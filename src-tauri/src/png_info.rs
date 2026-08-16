use anyhow::{anyhow, Result};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

/// 元数据解析的单文件大小上限：list_output_files 会对目录里每个 png/webp
/// 整读解析，数 GB 的文件会直接 OOM（对抗性审查 C）。超限的文件跳过解析
/// （仍出现在画廊里，只是没有参数徽标）。
const MAX_METADATA_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// 输出目录遍历上限：visited 防 symlink 环（a→b→a 会无限循环），总量上限
/// 防止输出目录被塞进巨树时卡死 GUI。
const MAX_TRAVERSED_DIRS: usize = 200;
const MAX_LISTED_FILES: usize = 5000;

fn read_be_u32(buf: &[u8], off: usize) -> u32 {
    u32::from_be_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
}

fn read_le_u32(buf: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
}

/// 从 sd-server 写入的 `parameters` 文本中提取 `SDCPP:` 之后的 JSON。
/// 文本形如 A1111 风格参数串 + ", SDCPP: {json}"
/// （common.cpp `get_image_params` 的输出格式）。
pub fn extract_sdcpp_metadata(text: &str) -> Option<serde_json::Value> {
    const MARKER: &str = "SDCPP: ";
    let idx = text.rfind(MARKER)?;
    serde_json::from_str(text[idx + MARKER.len()..].trim()).ok()
}

fn xml_unescape(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn parse_webp_xmp(xmp: &str) -> Option<serde_json::Value> {
    const OPEN: &str = "<sdcpp:parameters>";
    const CLOSE: &str = "</sdcpp:parameters>";
    let start = xmp.find(OPEN)? + OPEN.len();
    let rel_end = xmp[start..].find(CLOSE)?;
    extract_sdcpp_metadata(&xml_unescape(&xmp[start..start + rel_end]))
}

/// Parse a PNG file and extract the `parameters` tEXt chunk (sd-server
/// `embed_image_metadata` output). Returns the JSON value, or None if no
/// metadata was found / the file is not a valid PNG.
pub fn parse_png_metadata(path: &str) -> Result<Option<serde_json::Value>> {
    let path = Path::new(path);
    if let Ok(metadata) = fs::metadata(path) {
        if metadata.len() > MAX_METADATA_FILE_BYTES {
            return Err(anyhow!("file too large for metadata parsing"));
        }
    }
    let data = fs::read(path)?;
    if data.len() < 33 {
        return Err(anyhow!("file too small to be PNG"));
    }
    // PNG signature: 8 bytes
    let sig: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
    if data[..8] != sig {
        return Err(anyhow!("not a valid PNG"));
    }
    let mut off = 8usize;
    while off + 12 <= data.len() {
        let len = read_be_u32(&data, off) as usize;
        if off + 12 + len > data.len() {
            break;
        }
        let chunk_type = &data[off + 4..off + 8];
        if chunk_type == b"tEXt" {
            let chunk_data = &data[off + 8..off + 8 + len];
            // tEXt: keyword\0text
            if let Some(nul) = chunk_data.iter().position(|&b| b == 0) {
                let keyword = std::str::from_utf8(&chunk_data[..nul]).unwrap_or("");
                if keyword == "parameters" {
                    let text = std::str::from_utf8(&chunk_data[nul + 1..]).unwrap_or("");
                    if let Some(v) = extract_sdcpp_metadata(text) {
                        return Ok(Some(v));
                    }
                }
            }
        } else if chunk_type == b"IEND" {
            break;
        }
        off += 12 + len;
    }
    Ok(None)
}

/// Parse a WebP file and extract the `sdcpp:parameters` XMP packet
/// (`embed_image_metadata` output). Returns the JSON value, or None if no
/// metadata was found / the file is not a valid WebP.
pub fn parse_webp_metadata(path: &str) -> Result<Option<serde_json::Value>> {
    let path = Path::new(path);
    if let Ok(metadata) = fs::metadata(path) {
        if metadata.len() > MAX_METADATA_FILE_BYTES {
            return Err(anyhow!("file too large for metadata parsing"));
        }
    }
    let data = fs::read(path)?;
    if data.len() < 12 || &data[..4] != b"RIFF" || &data[8..12] != b"WEBP" {
        return Err(anyhow!("not a valid WebP"));
    }
    let mut off = 12usize;
    while off + 8 <= data.len() {
        let size = read_le_u32(&data, off + 4) as usize;
        if off + 8 + size > data.len() {
            break;
        }
        let fourcc = &data[off..off + 4];
        if fourcc == b"XMP " {
            let chunk = &data[off + 8..off + 8 + size];
            let xmp = std::str::from_utf8(chunk).unwrap_or("");
            if let Some(v) = parse_webp_xmp(xmp) {
                return Ok(Some(v));
            }
        }
        off += 8 + size + (size & 1);
    }
    Ok(None)
}

/// 去掉 Windows canonicalize 产出的 `\\?\` verbatim 前缀。starts_with 比较
/// 两侧一个带前缀一个不带（一侧 canonicalize 失败回退原路径时）会恒为
/// false，把合法子目录整体跳过（对抗性审查）。统一去前缀后再比较。
fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p.to_path_buf(),
    }
}

/// List files in a directory with their image metadata, for the history gallery.
pub fn list_output_files(dir: &str) -> Result<Vec<serde_json::Value>> {
    let base = Path::new(dir);
    if !base.is_dir() {
        return Ok(vec![]);
    }
    let canonical_base = strip_verbatim(&base.canonicalize().unwrap_or_else(|_| base.to_path_buf()));
    let mut entries = Vec::new();
    let mut dirs = vec![base.to_path_buf()];
    // visited 按规范化路径去重：`is_dir()` 跟随 symlink，a→b→a 的环会导致
    // 无限循环（对抗性审查 C）。canonicalize 失败时退回原始路径。
    let mut visited: HashSet<PathBuf> = HashSet::new();
    let mut traversed = 0usize;
    while let Some(d) = dirs.pop() {
        let key = d.canonicalize().unwrap_or_else(|_| d.clone());
        if !visited.insert(key) {
            continue;
        }
        traversed += 1;
        if traversed > MAX_TRAVERSED_DIRS {
            break;
        }
        if let Ok(read_dir) = fs::read_dir(&d) {
            for entry in read_dir.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    // 与 scanner 的 structured dir 守卫一致：symlink 目录必须
                    // 仍位于输出目录根内，否则视为逃逸并跳过。
                    let canonical_dir =
                        strip_verbatim(&p.canonicalize().unwrap_or_else(|_| p.clone()));
                    if !canonical_dir.starts_with(&canonical_base) {
                        continue;
                    }
                    if dirs.len() < 50 && traversed < MAX_TRAVERSED_DIRS {
                        dirs.push(p);
                    }
                    continue;
                }
                // symlink 文件同样不允许指到输出目录之外。
                if entry
                    .file_type()
                    .map(|file_type| file_type.is_symlink())
                    .unwrap_or(false)
                    && p
                        .canonicalize()
                        .map(|canonical_file| {
                            !strip_verbatim(&canonical_file).starts_with(&canonical_base)
                        })
                        .unwrap_or(true)
                {
                    continue;
                }
                if entries.len() >= MAX_LISTED_FILES {
                    break;
                }
                let ext = p
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_lowercase())
                    .unwrap_or_default();
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let path_str = p.to_string_lossy().replace('\\', "/");
                let mut entry_json = serde_json::json!({
                    "path": path_str,
                    "name": p.file_name().and_then(|n| n.to_str()).unwrap_or(""),
                    "size": meta.len(),
                    "modified": modified,
                    "ext": ext,
                });
                // 超大文件跳过元数据解析（parse_* 内同样有上限兜底，这里
                // 提前判断省一次整读）。
                let parsed = if meta.len() > MAX_METADATA_FILE_BYTES {
                    Ok(None)
                } else if ext == "png" {
                    parse_png_metadata(&path_str)
                } else if ext == "webp" {
                    parse_webp_metadata(&path_str)
                } else {
                    Ok(None)
                };
                if let Ok(Some(metadata)) = parsed {
                    entry_json["metadata"] = metadata;
                }
                entries.push(entry_json);
            }
        }
    }
    entries.sort_by(|a, b| {
        let ta = a.get("modified").and_then(|v| v.as_u64()).unwrap_or(0);
        let tb = b.get("modified").and_then(|v| v.as_u64()).unwrap_or(0);
        tb.cmp(&ta)
    });
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&(data.len() as u32).to_be_bytes());
        v.extend_from_slice(kind);
        v.extend_from_slice(data);
        v.extend_from_slice(&[0; 4]); // CRC 不参与解析，占位即可
        v
    }

    fn make_png(text: &str) -> Vec<u8> {
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&1u32.to_be_bytes());
        ihdr.extend_from_slice(&1u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
        let mut png = vec![137, 80, 78, 71, 13, 10, 26, 10];
        png.extend_from_slice(&chunk(b"IHDR", &ihdr));
        let mut text_data = b"parameters\0".to_vec();
        text_data.extend_from_slice(text.as_bytes());
        png.extend_from_slice(&chunk(b"tEXt", &text_data));
        png.extend_from_slice(&chunk(b"IEND", &[]));
        png
    }

    fn make_webp(xmp: &str) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(b"XMP ");
        body.extend_from_slice(&(xmp.len() as u32).to_le_bytes());
        body.extend_from_slice(xmp.as_bytes());
        if xmp.len() % 2 == 1 {
            body.push(0);
        }
        let mut webp = Vec::new();
        webp.extend_from_slice(b"RIFF");
        webp.extend_from_slice(&((4 + body.len()) as u32).to_le_bytes());
        webp.extend_from_slice(b"WEBP");
        webp.extend_from_slice(&body);
        webp
    }

    fn temp_path(ext: &str) -> std::path::PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "lumina_png_info_{}_{}.{}",
            std::process::id(),
            n,
            ext
        ))
    }

    const METADATA_TEXT: &str = "a lovely cat\nSteps: 8, CFG scale: 1.0, Seed: 42, SDCPP: {\"schema\":\"sdcpp.image.params/v1\",\"seed\":42,\"width\":1024,\"height\":1024}";

    #[test]
    fn parses_sdcpp_json_from_png_text_chunk() {
        let p = temp_path("png");
        fs::write(&p, make_png(METADATA_TEXT)).unwrap();
        let meta = parse_png_metadata(p.to_str().unwrap())
            .unwrap()
            .expect("metadata");
        assert_eq!(meta["seed"], 42);
        assert_eq!(meta["schema"], "sdcpp.image.params/v1");
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn returns_none_when_png_has_no_sdcpp_metadata() {
        let p = temp_path("png");
        fs::write(&p, make_png("Steps: 8, CFG scale: 1.0")).unwrap();
        assert!(parse_png_metadata(p.to_str().unwrap()).unwrap().is_none());
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn parses_sdcpp_json_from_webp_xmp() {
        let escaped = METADATA_TEXT.replace('&', "&amp;").replace('<', "&lt;");
        let xmp = format!(
            "<?xpacket begin=\"\"?><x:xmpmeta><rdf:RDF><rdf:Description><sdcpp:parameters>{}</sdcpp:parameters></rdf:Description></rdf:RDF></x:xmpmeta>",
            escaped
        );
        let p = temp_path("webp");
        fs::write(&p, make_webp(&xmp)).unwrap();
        let meta = parse_webp_metadata(p.to_str().unwrap())
            .unwrap()
            .expect("metadata");
        assert_eq!(meta["seed"], 42);
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn extracts_json_after_sdcpp_marker() {
        let v = extract_sdcpp_metadata("prompt\nSteps: 4, SDCPP: {\"a\":1}").unwrap();
        assert_eq!(v["a"], 1);
        assert!(extract_sdcpp_metadata("no metadata here").is_none());
    }
}
