use anyhow::{anyhow, Result};
use std::fs;
use std::path::Path;

fn read_be_u32(buf: &[u8], off: usize) -> u32 {
    u32::from_be_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
}

/// Parse a PNG file and extract the `parameters` tEXt chunk (sd-server
/// `embed_image_metadata` output). Returns the JSON value, or None if no
/// metadata was found / the file is not a valid PNG.
pub fn parse_png_metadata(path: &str) -> Result<Option<serde_json::Value>> {
    let data = fs::read(Path::new(path))?;
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
        let chunk_type = &data[off + 4..off + 8];
        if chunk_type == b"tEXt" {
            let chunk_data = &data[off + 8..off + 8 + len];
            // tEXt: keyword\0text
            if let Some(nul) = chunk_data.iter().position(|&b| b == 0) {
                let keyword = std::str::from_utf8(&chunk_data[..nul]).unwrap_or("");
                if keyword == "parameters" {
                    let text = std::str::from_utf8(&chunk_data[nul + 1..]).unwrap_or("");
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
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

/// List files in a directory with their PNG metadata, for the history gallery.
pub fn list_output_files(dir: &str) -> Result<Vec<serde_json::Value>> {
    let base = Path::new(dir);
    if !base.is_dir() {
        return Ok(vec![]);
    }
    let mut entries = Vec::new();
    let mut dirs = vec![base.to_path_buf()];
    while let Some(d) = dirs.pop() {
        if let Ok(read_dir) = fs::read_dir(&d) {
            for entry in read_dir.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    if dirs.len() < 50 {
                        dirs.push(p);
                    }
                    continue;
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
                if ext == "png" {
                    if let Ok(Some(metadata)) = parse_png_metadata(&path_str) {
                        entry_json["metadata"] = metadata;
                    }
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
