//! Model-family detection and file classification.
//!
//! Direct port of the webui `detectFamily` / `classifyFile` Go logic, unified in
//! one place (the webui had it duplicated across Go + JS regex). Family metadata
//! (fields / genDefaults) lives in the TypeScript frontend.

fn has_any(s: &str, patterns: &[&str]) -> bool {
    patterns.iter().any(|p| s.contains(p))
}

/// Map a model file path to one of the supported family ids.
pub fn detect_family(path: &str) -> &'static str {
    let t = path.to_lowercase();
    if has_any(&t, &["kontext"]) {
        return "kontext";
    }
    if has_any(
        &t,
        &["flux-2-klein-base", "flux2-klein-base", "flux.2-klein-base"],
    ) {
        return "flux2-klein-base";
    }
    if has_any(&t, &["flux-2-klein", "flux2-klein", "flux.2-klein"]) {
        return "flux2-klein";
    }
    if has_any(&t, &["flux2", "flux.2-dev", "flux-2-dev"]) {
        return "flux2";
    }
    if has_any(&t, &["flux1-", "flux.1-", "flux1_"]) {
        return "flux";
    }
    if has_any(&t, &["chroma1-radiance", "chroma-radiance"]) {
        return "chroma-radiance";
    }
    if has_any(&t, &["chroma"]) {
        return "chroma";
    }
    if has_any(
        &t,
        &[
            "qwen-image-layered",
            "qwen_image_layered",
            "qwenimagelayered",
        ],
    ) {
        return "qwen-image-layered";
    }
    if has_any(&t, &["qwen-image-edit", "qwen_image_edit"]) {
        return "qwen-image-edit";
    }
    if has_any(&t, &["qwen-image", "qwen_image"]) {
        return "qwen-image";
    }
    if has_any(&t, &["ernie-image", "ernie_image"]) {
        if has_any(&t, &["turbo"]) {
            return "ernie-image-turbo";
        }
        return "ernie-image";
    }
    if has_any(&t, &["ideogram"]) {
        return "ideogram";
    }
    if has_any(&t, &["ltx"]) {
        return "ltx";
    }
    if has_any(&t, &["hidream"]) {
        return "hidream";
    }
    if has_any(&t, &["z_image_turbo", "z-image-turbo", "zimage_turbo"]) {
        return "zimage-turbo";
    }
    if has_any(&t, &["z_image", "z-image", "zimage"]) {
        return "zimage";
    }
    if has_any(&t, &["lingbot-video", "lingbot_video", "lingbotvideo"]) {
        return "lingbot-video";
    }
    if has_any(
        &t,
        &["boogu-image-edit", "boogu_image_edit", "boogu.image.edit"],
    ) {
        return "boogu-edit";
    }
    if has_any(
        &t,
        &[
            "boogu-image-turbo",
            "boogu_image_turbo",
            "boogu.image.turbo",
        ],
    ) {
        return "boogu-turbo";
    }
    if has_any(
        &t,
        &["boogu-image-base", "boogu_image_base", "boogu.image.base"],
    ) {
        return "boogu-base";
    }
    if has_any(&t, &["boogu-image", "boogu_image", "boogu.image"]) {
        return "boogu-base";
    }
    if has_any(
        &t,
        &["krea-2-turbo", "krea_2_turbo", "krea2-turbo", "krea2_turbo"],
    ) {
        return "krea2-turbo";
    }
    if has_any(&t, &["krea-2-raw", "krea_2_raw", "krea2-raw", "krea2_raw"]) {
        return "krea2";
    }
    if has_any(&t, &["krea-2", "krea_2", "krea2"]) {
        return "krea2";
    }
    if has_any(&t, &["sefi"]) {
        if has_any(&t, &["turbo"]) {
            return "sefi-turbo";
        }
        return "sefi";
    }
    if has_any(&t, &["anima"]) {
        return "anima";
    }
    if has_any(&t, &["longcat"]) {
        return "longcat";
    }
    if has_any(&t, &["ovis_image", "ovis-image"]) {
        return "ovis";
    }
    if has_any(&t, &["lens"]) {
        if has_any(&t, &["turbo"]) {
            return "lens-turbo";
        }
        return "lens";
    }
    if has_any(&t, &["minit2i", "mini-t2i", "mini_t2i"]) {
        return "minit2i";
    }
    if has_any(&t, &["sdxl", "sd_xl", "sd-xl", "stable-diffusion-xl"]) {
        return "sdxl";
    }
    if has_any(&t, &["sd3.5", "sd_3", "stable-diffusion-3", "sd3"]) {
        return "sd3";
    }
    if has_any(&t, &["wan"]) {
        if has_any(&t, &["a14b"]) {
            return "wan-a14b";
        }
        if has_any(&t, &["ti2v"]) {
            return "wan-ti2v";
        }
        if has_any(&t, &["i2v", "flf2v"]) {
            return "wan-i2v";
        }
        return "wan-t2v";
    }
    if has_any(&t, &["ssd-1b", "bk-sdm", "sdxs"]) {
        return "distilled-sd";
    }
    if has_any(
        &t,
        &["v1-", "v1_", "v2-", "v2_", "sd-v1", "sd-v2", "sd1.", "sd2."],
    ) {
        return "sd";
    }
    "custom"
}

fn is_llm_encoder(test: &str) -> bool {
    // qwen-image is a diffusion model, not an LLM encoder.
    if has_any(test, &["qwen-image", "qwen_image", "qwen-image-edit"]) {
        return false;
    }
    has_any(
        test,
        &[
            "mistral",
            "ministral",
            "gemma",
            "gpt-oss",
            "ovis_2",
            "ovis-2",
            "phi-",
            "qwen2.5-vl",
            "qwen_2.5_vl",
            "qwen2_5_vl",
            "qwen3-",
            "qwen_3_",
            "qwen3_",
        ],
    )
}

fn is_diffusion_model_name(test: &str) -> bool {
    has_any(
        test,
        &[
            "flux1-",
            "flux1_",
            "flux2-",
            "flux2_",
            "flux-2-",
            "flux.1-",
            "flux.2-",
            "kontext",
            "sd_xl",
            "sdxl",
            "sd-xl",
            "sd-v1",
            "sd-v2",
            "v1-5",
            "v2-1",
            "sd3",
            "sd3.5",
            "wan2.",
            "wan2_",
            "wan_2.",
            "lingbot-video",
            "lingbot_video",
            "lingbotvideo",
            "z_image",
            "z-image",
            "zimage",
            "qwen-image",
            "qwen_image",
            "chroma",
            "ltx-2",
            "ltx-1",
            "ideogram",
            "ernie-image",
            "ernie_image",
            "anima",
            "longcat",
            "ovis_image",
            "ovis-image",
            "hidream",
            "lens_",
            "lens-",
            "ssd-1b",
            "bk-sdm",
            "sdxs",
            "boogu",
            "krea",
            "sefi",
            "minit2i",
            "mini-t2i",
        ],
    )
}

/// Classify a model file into a component category (model / vae / clip_l / ...).
pub fn classify_file(name: &str, stem: &str, dir_base: &str, size_mb: f64) -> &'static str {
    let test = format!(
        "{}|{}|{}",
        name.to_lowercase(),
        stem.to_lowercase(),
        dir_base.to_lowercase()
    );

    // Audio VAE (must check before generic VAE)
    if has_any(&test, &["audio_vae", "audio-vae"]) {
        return "audio_vae";
    }
    // Embedding connectors (LTX)
    if has_any(&test, &["embeddings_connector"]) {
        return "embeddings";
    }
    // VAE
    if has_any(&test, &["ae.safetensors", "ae.sft", "autoencoder"]) && size_mb < 2000.0 {
        return "vae";
    }
    if has_any(&test, &["_vae", "-vae"])
        && !has_any(&test, &["diffusion", "audio"])
        && size_mb < 2000.0
    {
        return "vae";
    }
    // CLIP-L
    if has_any(&test, &["clip_l", "clip_vit_l", "vit_large", "clip-l"])
        && !has_any(&test, &["clip_g"])
    {
        return "clip_l";
    }
    // CLIP-G
    if has_any(&test, &["clip_g", "clip-g", "vit_big"]) {
        return "clip_g";
    }
    // T5-XXL (incl UMT5, flan-t5 for MiniT2I)
    if has_any(
        &test,
        &[
            "t5xxl", "t5_xx", "t5-xxl", "umt5", "t5_xxl", "umt5-xxl", "flan-t5", "flan_t5",
        ],
    ) {
        return "t5xxl";
    }
    // CLIP Vision
    if has_any(
        &test,
        &["clip_vision", "clip-vision", "siglip", "clip_visual"],
    ) {
        return "clip_vision";
    }
    // LLM Vision (mmproj)
    if has_any(&test, &["mmproj"]) {
        return "llm_vision";
    }
    // Unconditional diffusion model (Ideogram4)
    if has_any(&test, &["uncond"]) && size_mb > 500.0 {
        return "uncond_model";
    }
    // LoRA
    if has_any(&test, &["lora"]) && size_mb < 2000.0 {
        return "lora";
    }
    // ControlNet — check for "controlnet" prefix or specific mode keywords.
    if size_mb < 3000.0 {
        let mut is_ctrl = has_any(&test, &["controlnet", "control-net", "control_net"]);
        if !is_ctrl {
            is_ctrl = has_any(
                &test,
                &[
                    "canny", "depth", "openpose", "tile", "lineart", "normal", "seg", "scribble",
                    "mlsd", "softedge", "shuffle", "ip2p", "qrcode",
                ],
            );
        }
        // "inpaint" alone is ambiguous (SD inpainting models); only match if
        // a ControlNet keyword already matched or the file is clearly small/alt.
        if is_ctrl || has_any(&test, &["inpaint"]) && size_mb < 800.0 {
            return "control_net";
        }
    }
    // PhotoMaker
    if has_any(&test, &["photomaker", "photo-maker", "photo_maker"]) {
        return "photo_maker";
    }
    // PuLID
    if has_any(&test, &["pulid"]) {
        return "pulid";
    }
    // TAESD
    if has_any(&test, &["taesd", "tae_sd", "tae-sd", "tiny_autoencoder"]) && size_mb < 500.0 {
        return "taesd";
    }
    // ESRGAN upscaler
    if has_any(
        &test,
        &[
            "upscaler",
            "esrgan",
            "realesrgan",
            "real-esrgan",
            "swinir",
            "bsrgan",
            "4x",
            "8x",
        ],
    ) && has_any(&test, &["pth", "pt"])
        && size_mb < 500.0
    {
        return "upscaler";
    }
    // AnimateDiff motion modules are large enough to look like standalone
    // diffusion models, so classify them before the size fallback.
    if has_any(
        &test,
        &[
            "motion_module",
            "motion-module",
            "animatediff",
            "mm_sd_v",
            "mm_sd15",
            "v3_sd15_mm",
        ],
    ) {
        return "motion_module";
    }
    // LLM text encoders
    if is_llm_encoder(&test) {
        return "llm";
    }
    // Diffusion model by name — high-noise variant first
    if is_diffusion_model_name(&test) {
        if has_any(&test, &["highnoise", "high-noise", "high_noise"]) {
            return "high_noise_model";
        }
        return "model";
    }
    // Size fallback
    if size_mb >= 500.0 {
        return "model";
    }
    "other"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_wan_ti2v_before_i2v_substring() {
        assert_eq!(detect_family("Wan2.2-TI2V-5B.safetensors"), "wan-ti2v");
    }

    #[test]
    fn detects_qwen_image_layered_separately() {
        assert_eq!(
            detect_family("Qwen-Image-Layered.safetensors.index.json"),
            "qwen-image-layered"
        );
    }

    #[test]
    fn classifies_animatediff_motion_modules_before_size_fallback() {
        assert_eq!(
            classify_file("mm_sd15_v3.safetensors", "mm_sd15_v3", "animatediff", 836.0,),
            "motion_module"
        );
    }
}
