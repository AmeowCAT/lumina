use crate::family;
use anyhow::Result;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

const MAX_DEPTH: usize = 3;
const MAX_WARNINGS: usize = 100;
const SAFETENSORS_INDEX_SUFFIX: &str = ".safetensors.index.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFile {
    pub name: String,
    pub stem: String,
    pub path: String,
    pub rel_path: String,
    pub size_mb: f64,
    pub dir: String,
    pub ext: String,
    pub category: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanWarning {
    pub code: String,
    pub path: String,
    pub message: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanStats {
    pub directories_scanned: usize,
    pub entries_inspected: usize,
    pub skipped_directories: usize,
    pub read_errors: usize,
    pub entry_errors: usize,
    pub metadata_errors: usize,
    pub depth_limit_hits: usize,
    pub warnings_omitted: usize,
    pub elapsed_ms: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    // Existing fields stay unchanged so older frontends remain compatible.
    pub files: Vec<ModelFile>,
    pub count: usize,
    pub base_dir: String,
    pub families: HashMap<String, String>,
    pub warnings: Vec<ScanWarning>,
    pub truncated: bool,
    pub partial: bool,
    pub stats: ScanStats,
}

#[derive(Default)]
struct ScanContext {
    warnings: Vec<ScanWarning>,
    stats: ScanStats,
    truncated: bool,
    referenced_shards: HashSet<PathBuf>,
}

struct SafetensorsIndexInfo {
    size_mb: f64,
    shard_paths: HashSet<PathBuf>,
}

impl ScanContext {
    fn warn(&mut self, code: &str, path: &Path, message: impl Into<String>) {
        if self.warnings.len() < MAX_WARNINGS {
            self.warnings.push(ScanWarning {
                code: code.into(),
                path: to_slash(path),
                message: message.into(),
            });
        } else {
            self.stats.warnings_omitted += 1;
        }
    }

    fn partial(&self) -> bool {
        self.truncated
            || self.stats.read_errors > 0
            || self.stats.entry_errors > 0
            || self.stats.metadata_errors > 0
    }
}

fn allowed_ext(ext: &str) -> bool {
    matches!(ext, "safetensors" | "sft" | "gguf" | "ckpt" | "pt" | "pth")
}

fn is_safetensors_index(name: &str) -> bool {
    name.to_ascii_lowercase()
        .ends_with(SAFETENSORS_INDEX_SUFFIX)
}

pub fn to_slash(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// Return the first existing subdirectory under `base` from the list of candidates.
pub fn find_dir(base: &Path, candidates: &[&str]) -> Option<PathBuf> {
    for name in candidates {
        let d = base.join(name);
        if d.is_dir() {
            return Some(d);
        }
    }
    None
}

fn metadata_size_mb(path: &Path, context: &mut ScanContext) -> f64 {
    match fs::metadata(path) {
        Ok(metadata) => metadata.len() as f64 / 1024.0 / 1024.0,
        Err(error) => {
            context.stats.metadata_errors += 1;
            context.warn(
                "metadata_failed",
                path,
                format!("无法读取文件元数据：{}", error),
            );
            0.0
        }
    }
}

fn normalized_existing_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn safetensors_index_info(path: &Path, context: &mut ScanContext) -> Option<SafetensorsIndexInfo> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) => {
            context.stats.read_errors += 1;
            context.warn(
                "index_unreadable",
                path,
                format!("无法读取 Safetensors 索引：{}", error),
            );
            return None;
        }
    };
    let index: serde_json::Value = match serde_json::from_str(&contents) {
        Ok(index) => index,
        Err(error) => {
            context.stats.entry_errors += 1;
            context.warn(
                "index_invalid",
                path,
                format!("Safetensors 索引不是有效 JSON：{}", error),
            );
            return None;
        }
    };
    let Some(weight_map) = index.get("weight_map").and_then(|value| value.as_object()) else {
        context.stats.entry_errors += 1;
        context.warn("index_invalid", path, "Safetensors 索引缺少 weight_map");
        return None;
    };

    let mut shards = HashSet::new();
    for value in weight_map.values() {
        let Some(shard) = value.as_str() else {
            context.stats.entry_errors += 1;
            context.warn("index_invalid", path, "Safetensors 索引包含无效 shard 路径");
            return None;
        };
        let shard_path = PathBuf::from(shard);
        shards.insert(if shard_path.is_absolute() {
            shard_path
        } else {
            path.parent().unwrap_or(Path::new("")).join(shard_path)
        });
    }
    if shards.is_empty() {
        context.stats.entry_errors += 1;
        context.warn("index_invalid", path, "Safetensors 索引没有引用任何 shard");
        return None;
    }

    let mut size_bytes = 0u64;
    let mut shard_paths = HashSet::new();
    for shard in shards {
        match fs::metadata(&shard) {
            Ok(metadata) if metadata.is_file() => {
                size_bytes += metadata.len();
                shard_paths.insert(normalized_existing_path(&shard));
            }
            Ok(_) => {
                context.stats.metadata_errors += 1;
                context.warn("index_shard_invalid", &shard, "Safetensors shard 不是文件");
                return None;
            }
            Err(error) => {
                context.stats.metadata_errors += 1;
                context.warn(
                    "index_shard_missing",
                    &shard,
                    format!("无法读取 Safetensors shard：{}", error),
                );
                return None;
            }
        }
    }
    Some(SafetensorsIndexInfo {
        size_mb: size_bytes as f64 / 1024.0 / 1024.0,
        shard_paths,
    })
}

fn category_with_hint(category: &str, category_hint: Option<&str>, is_index: bool) -> String {
    if let Some(hint) = category_hint {
        let generic_category = category == "other" || category == "model" && hint != "model";
        if generic_category {
            return hint.to_string();
        }
    }
    if is_index && category == "other" {
        return "model".into();
    }
    category.to_string()
}

fn is_skipped(path: &Path, skip: &HashSet<PathBuf>) -> bool {
    skip.contains(path)
        || path
            .canonicalize()
            .map(|canonical| skip.contains(&canonical))
            .unwrap_or(false)
}

fn walk(
    dir: &Path,
    base: &Path,
    depth: usize,
    skip: &HashSet<PathBuf>,
    category_hint: Option<&str>,
    out: &mut Vec<ModelFile>,
    context: &mut ScanContext,
) {
    if depth > MAX_DEPTH {
        context.truncated = true;
        context.stats.depth_limit_hits += 1;
        context.stats.skipped_directories += 1;
        context.warn(
            "depth_limit",
            dir,
            format!("目录深度超过扫描上限 {}，已跳过", MAX_DEPTH),
        );
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            context.stats.read_errors += 1;
            context.stats.skipped_directories += 1;
            context.warn(
                "directory_unreadable",
                dir,
                format!("无法读取目录：{}", error),
            );
            return;
        }
    };
    context.stats.directories_scanned += 1;

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                context.stats.entry_errors += 1;
                context.warn(
                    "directory_entry_failed",
                    dir,
                    format!("无法读取目录项：{}", error),
                );
                continue;
            }
        };
        context.stats.entries_inspected += 1;
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                context.stats.metadata_errors += 1;
                context.warn(
                    "file_type_failed",
                    &path,
                    format!("无法判断文件类型：{}", error),
                );
                continue;
            }
        };

        if file_type.is_dir() {
            if is_skipped(&path, skip) {
                continue;
            }
            // Diffusers directory: contains model_index.json → treat as a model file.
            let model_index = path.join("model_index.json");
            if model_index.is_file() {
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();
                if name.is_empty() {
                    context.stats.entry_errors += 1;
                    context.warn("invalid_file_name", &path, "模型目录名称不是有效 UTF-8");
                    continue;
                }
                let dir_base = path
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();
                let size_mb = metadata_size_mb(&model_index, context);
                let category = category_with_hint(
                    family::classify_file(&name, &name, &dir_base, size_mb),
                    category_hint,
                    false,
                );
                out.push(ModelFile {
                    stem: name.clone(),
                    rel_path: path.strip_prefix(base).map(to_slash).unwrap_or_default(),
                    path: to_slash(&path),
                    dir: path.parent().map(to_slash).unwrap_or_default(),
                    size_mb,
                    ext: String::new(),
                    name,
                    category,
                });
                continue;
            }
            walk(&path, base, depth + 1, skip, category_hint, out, context);
            continue;
        }

        if !file_type.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => {
                context.stats.entry_errors += 1;
                context.warn("invalid_file_name", &path, "文件名不是有效 UTF-8");
                continue;
            }
        };
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();
        let safetensors_index = is_safetensors_index(&name);
        if !allowed_ext(&ext) && !safetensors_index {
            continue;
        }
        let stem = if safetensors_index {
            name[..name.len() - SAFETENSORS_INDEX_SUFFIX.len()].to_string()
        } else {
            path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string()
        };
        let size_mb = if safetensors_index {
            let Some(info) = safetensors_index_info(&path, context) else {
                continue;
            };
            context.referenced_shards.extend(info.shard_paths);
            info.size_mb
        } else {
            metadata_size_mb(&path, context)
        };
        let dir_base = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let category = category_with_hint(
            family::classify_file(&name, &stem, &dir_base, size_mb),
            category_hint,
            safetensors_index,
        );
        out.push(ModelFile {
            stem,
            rel_path: path.strip_prefix(base).map(to_slash).unwrap_or_default(),
            path: to_slash(&path),
            dir: path.parent().map(to_slash).unwrap_or_default(),
            size_mb,
            ext: if safetensors_index {
                SAFETENSORS_INDEX_SUFFIX[1..].to_string()
            } else {
                ext
            },
            name,
            category,
        });
    }
}

pub fn scan_models(dir: &str) -> Result<ScanResult> {
    let started = Instant::now();
    let requested_base = PathBuf::from(dir);
    let base = requested_base.canonicalize().unwrap_or(requested_base);
    if !base.is_dir() {
        anyhow::bail!("not a directory: {}", dir);
    }
    let mut files = Vec::new();
    let mut context = ScanContext::default();

    // ── Structured subdirectory detection (ComfyUI layout) ─────────────
    let diffusion_dir = find_dir(&base, &["diffusion_models", "diffusion_model"]);
    let vae_dir = find_dir(&base, &["vaes", "vae"]);
    let llm_dir = find_dir(&base, &["llms", "text_encoders"]);
    let lora_dir = find_dir(&base, &["loras", "lora"]);

    let mut skip: HashSet<PathBuf> = HashSet::new();
    let structured_dirs = [
        (diffusion_dir.as_ref(), "model"),
        (vae_dir.as_ref(), "vae"),
        (llm_dir.as_ref(), "llm"),
        (lora_dir.as_ref(), "lora"),
    ];
    for (dir, category_hint) in structured_dirs
        .into_iter()
        .filter_map(|(dir, hint)| dir.map(|dir| (dir, hint)))
    {
        let canonical = match dir.canonicalize() {
            Ok(canonical) => canonical,
            Err(error) => {
                context.stats.metadata_errors += 1;
                context.warn(
                    "canonicalize_failed",
                    dir,
                    format!("无法规范化目录路径：{}", error),
                );
                dir.clone()
            }
        };
        skip.insert(canonical.clone());
        walk(
            &canonical,
            &base,
            0,
            &HashSet::new(),
            Some(category_hint),
            &mut files,
            &mut context,
        );
    }

    let needs_fallback =
        diffusion_dir.is_none() || vae_dir.is_none() || llm_dir.is_none() || lora_dir.is_none();
    if needs_fallback {
        walk(&base, &base, 0, &skip, None, &mut files, &mut context);
    }

    files.retain(|file| {
        file.ext == SAFETENSORS_INDEX_SUFFIX.trim_start_matches('.')
            || !context
                .referenced_shards
                .contains(&normalized_existing_path(Path::new(&file.path)))
    });
    let mut seen = HashSet::new();
    files.retain(|file| seen.insert(file.path.clone()));
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

    let mut families = HashMap::new();
    for file in &files {
        if file.category == "model" {
            families.insert(
                file.path.clone(),
                family::detect_family(&file.path).to_string(),
            );
        }
    }
    let count = files.len();
    context.stats.elapsed_ms = started.elapsed().as_millis();
    let partial = context.partial();
    Ok(ScanResult {
        files,
        count,
        base_dir: to_slash(&base),
        families,
        warnings: context.warnings,
        truncated: context.truncated,
        partial,
        stats: context.stats,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lumina-scanner-test-{}-{}-{}",
            name,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scan_keeps_existing_fields_and_reports_stats() {
        let dir = test_dir("stats");
        fs::write(dir.join("model.safetensors"), b"model").unwrap();
        fs::write(dir.join("ignored.txt"), b"ignored").unwrap();

        let result = scan_models(dir.to_str().unwrap()).unwrap();
        assert_eq!(result.count, 1);
        assert_eq!(result.files[0].name, "model.safetensors");
        assert!(!result.partial);
        assert!(!result.truncated);
        assert!(result.stats.directories_scanned >= 1);
        assert!(result.stats.entries_inspected >= 2);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn scan_reports_depth_truncation() {
        let dir = test_dir("depth");
        let too_deep = dir.join("a").join("b").join("c").join("d").join("e");
        fs::create_dir_all(&too_deep).unwrap();
        fs::write(too_deep.join("hidden.gguf"), b"model").unwrap();

        let result = scan_models(dir.to_str().unwrap()).unwrap();
        assert!(result.truncated);
        assert!(result.partial);
        assert!(result.stats.depth_limit_hits >= 1);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.code == "depth_limit"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn scan_includes_valid_safetensors_index() {
        let dir = test_dir("safetensors-index");
        fs::write(dir.join("layer-00001-of-00002.safetensors"), b"first").unwrap();
        fs::write(dir.join("layer-00002-of-00002.safetensors"), b"second").unwrap();
        fs::write(
            dir.join("qwen-image-layered.safetensors.index.json"),
            r#"{"weight_map":{"a":"layer-00001-of-00002.safetensors","b":"layer-00002-of-00002.safetensors"}}"#,
        )
        .unwrap();

        let result = scan_models(dir.to_str().unwrap()).unwrap();
        let index = result
            .files
            .iter()
            .find(|file| file.ext == "safetensors.index.json")
            .unwrap();
        assert_eq!(index.stem, "qwen-image-layered");
        assert_eq!(index.category, "model");
        assert!(index.size_mb > 0.0);
        assert_eq!(result.files.len(), 1);
        assert!(result
            .files
            .iter()
            .all(|file| !file.name.starts_with("layer-")));
        assert_eq!(
            result.families.get(&index.path).unwrap(),
            "qwen-image-layered"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn scan_includes_sft_files_used_by_common_vaes() {
        let dir = test_dir("sft-extension");
        fs::write(dir.join("ae.sft"), b"vae").unwrap();

        let result = scan_models(dir.to_str().unwrap()).unwrap();
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].name, "ae.sft");
        assert_eq!(result.files[0].category, "vae");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn structured_directory_classifies_generic_indexes() {
        let dir = test_dir("structured-indexes");
        let text_encoders = dir.join("text_encoders");
        let vaes = dir.join("vae");
        fs::create_dir_all(&text_encoders).unwrap();
        fs::create_dir_all(&vaes).unwrap();

        fs::write(text_encoders.join("text-00001.safetensors"), b"text").unwrap();
        fs::write(
            text_encoders.join("model.safetensors.index.json"),
            r#"{"weight_map":{"text":"text-00001.safetensors"}}"#,
        )
        .unwrap();
        fs::write(vaes.join("vae-00001.safetensors"), b"vae").unwrap();
        fs::write(
            vaes.join("model.safetensors.index.json"),
            r#"{"weight_map":{"vae":"vae-00001.safetensors"}}"#,
        )
        .unwrap();

        let result = scan_models(dir.to_str().unwrap()).unwrap();
        let llm_index = result
            .files
            .iter()
            .find(|file| file.path.contains("text_encoders"))
            .unwrap();
        let vae_index = result
            .files
            .iter()
            .find(|file| file.path.contains("/vae/"))
            .unwrap();
        assert_eq!(llm_index.category, "llm");
        assert_eq!(vae_index.category, "vae");
        assert_eq!(result.files.len(), 2);
        fs::remove_dir_all(dir).unwrap();
    }
}
