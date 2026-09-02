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
    // PiD checkpoints often include their backbone name (for example
    // `pid_flux1_...`), so detect them before the generic Flux rules below.
    if has_any(
        &t,
        &[
            "pid_flux",
            "pid-flux",
            "pid-sd3",
            "pid_sd3",
            "pid_flux2",
            "pid_flux_2",
            "pid-flux2",
            "pid-flux-2",
            "pid_qwen",
            "pid_qwen_image",
            "pid-qwen",
            "pid-qwen-image",
            "pid_zimage",
            "pid-zimage",
            "pixeldit",
            "pixel-dit",
            "pixel_dit",
        ],
    ) {
        return "pid";
    }
    if has_any(
        &t,
        &[
            "hunyuanvideo",
            "hunyuan-video",
            "hunyuan_video",
            "hunyuan video",
        ],
    ) {
        return "hunyuan-video";
    }
    // MiniMax-H3 权重文件名：minimax_h3_fl2va[-pruned] / minimax_h3_ref2va[-pruned]。
    // Ref2VA 变体单独成族——其参考视频/音频输入目前只有 sd-cli 通道。
    if has_any(&t, &["minimax-h3", "minimax_h3", "minimaxh3"]) {
        if has_any(&t, &["ref2va"]) {
            return "minimax-h3-ref2va";
        }
        return "minimax-h3-fl2va";
    }
    if has_any(&t, &["mage-flow", "mage_flow", "mageflow"]) {
        let is_edit = t.contains("edit");
        let is_turbo = t.contains("turbo");
        return match (is_edit, is_turbo) {
            (true, true) => "mage-flow-edit-turbo",
            (true, false) => "mage-flow-edit",
            (false, true) => "mage-flow-turbo",
            (false, false) => "mage-flow",
        };
    }
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
    // LTX-2.5 单独成族（上游 #1893）：与 2.3 共用架构、按权重自动区分，
    // 但组件需求不同——Gemma 4 文本编码器内置投影，无需 --embeddings-connectors。
    if has_any(&t, &["ltx-2.5", "ltx_2_5", "ltx2.5", "ltx-2_5"]) {
        return "ltx25";
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
            // MiniMax-H3 文本编码器（qwen3vl_32b_minimax_h3）：不带连字符/下划线，
            // 上面的 qwen3- / qwen3_ 都匹配不到。
            "qwen3vl",
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
            "pid_flux",
            "pid-flux",
            "pid-sd3",
            "pid_sd3",
            "pid_flux2",
            "pid_flux_2",
            "pid-flux2",
            "pid-flux-2",
            "pid_qwen",
            "pid_qwen_image",
            "pid-qwen",
            "pid-qwen-image",
            "pid_zimage",
            "pid-zimage",
            "pixeldit",
            "pixel-dit",
            "pixel_dit",
            "hunyuanvideo",
            "hunyuan-video",
            "hunyuan_video",
            "hunyuan video",
            "mage-flow",
            "mage_flow",
            "mageflow",
            "boogu",
            "krea",
            "sefi",
            "minit2i",
            "mini-t2i",
            "minimax",
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
    // TAE (Tiny AutoEncoder) — must precede the generic VAE rules: every TAE
    // family shares the "…autoencoder"/"…_vae" spellings the VAE branch below
    // matches, and upstream takes them through `--taesd`, not `--vae`.
    // Covers taesd/taesdxl/taesd3 (image), taef1/taef2 (Flux, Flux.2),
    // taehv/taew2_1/taew2_2 (Wan VAE family incl. Qwen-Image) and taeh3
    // (MiniMax-H3, upstream #1874). See upstream docs/taesd.md.
    if has_any(
        &test,
        &[
            "taesd",
            "tae_sd",
            "tae-sd",
            "taef1",
            "taef2",
            "taehv",
            "taew2",
            "taeh3",
            "taeltx",
            "tiny_autoencoder",
            "tiny-autoencoder",
            "tae.safetensors",
            "tae.sft",
            "tae.gguf",
        ],
    ) && size_mb < 500.0
    {
        return "taesd";
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
    // T5-XXL (incl UMT5, flan-t5 for MiniT2I, and HunyuanVideo's ByT5)
    if has_any(
        &test,
        &[
            "t5xxl", "t5_xx", "t5-xxl", "umt5", "t5_xxl", "umt5-xxl", "flan-t5", "flan_t5", "byt5",
            "glyphxl",
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
    // IP-Adapter (SD 1.5 / SDXL, incl. the Plus variants) — upstream loads it
    // through `--ip-adapter` together with a ViT-H/14 `--clip_vision` encoder
    // (docs/ip_adapter.md). Checked before ControlNet so an adapter sitting in
    // a `controlnet/` folder is still classified by its own name.
    if has_any(&test, &["ip-adapter", "ip_adapter", "ipadapter"]) && size_mb < 2000.0 {
        return "ip_adapter";
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
    fn detects_minimax_h3_variants() {
        assert_eq!(
            detect_family("minimax_h3_fl2va-Q4_K_M.gguf"),
            "minimax-h3-fl2va"
        );
        assert_eq!(
            detect_family("minimax_h3_fl2va_pruned-Q4_K_M.gguf"),
            "minimax-h3-fl2va"
        );
        assert_eq!(
            detect_family("minimax_h3_ref2va-Q4_K_M.gguf"),
            "minimax-h3-ref2va"
        );
        assert_eq!(
            detect_family("minimax_h3_ref2va_pruned-Q2_K_M.gguf"),
            "minimax-h3-ref2va"
        );
        assert_eq!(
            detect_family("MiniMax-H3-FL2VA.safetensors"),
            "minimax-h3-fl2va"
        );
    }

    #[test]
    fn classifies_minimax_h3_components() {
        // 文本编码器名字不带 qwen3- / qwen3_，此前会被大小回退误判成 model。
        assert_eq!(
            classify_file(
                "qwen3vl_32b_minimax_h3-Q4_K_M.gguf",
                "qwen3vl_32b_minimax_h3-Q4_K_M",
                "text_encoders",
                18000.0,
            ),
            "llm"
        );
        assert_eq!(
            classify_file(
                "minimax_h3_audio_vae_fp32.safetensors",
                "minimax_h3_audio_vae_fp32",
                "vae",
                600.0,
            ),
            "audio_vae"
        );
        assert_eq!(
            classify_file(
                "minimax_h3_video_vae_fp16.safetensors",
                "minimax_h3_video_vae_fp16",
                "vae",
                800.0,
            ),
            "vae"
        );
        assert_eq!(
            classify_file(
                "minimax_h3_fl2va-Q4_K_M.gguf",
                "minimax_h3_fl2va-Q4_K_M",
                "diffusion_models",
                9000.0,
            ),
            "model"
        );
    }

    #[test]
    fn detects_ltx25_before_generic_ltx() {
        // 上游 #1893 / docs/ltx2.md：LTX-2.5 与 2.3 共用架构但组件需求不同
        // （Gemma 4 内置投影，无 --embeddings-connectors），单独成族。
        assert_eq!(
            detect_family("ltx-2.5-22b-dev-transformer-Q8_0.gguf"),
            "ltx25"
        );
        assert_eq!(detect_family("LTX-2.5-22B-dev.safetensors"), "ltx25");
        assert_eq!(detect_family("ltx_2_5_22b_dev.gguf"), "ltx25");
        // 2.3 与旧 LTX-Video 仍归 ltx 家族。
        assert_eq!(detect_family("ltx-2.3-22b-dev-UD-Q4_K_M.gguf"), "ltx");
        assert_eq!(detect_family("ltx-video-2b.safetensors"), "ltx");
    }

    #[test]
    fn classifies_ltx25_components() {
        // gemma4 文件名同时命中 llm 关键词（gemma）与扩散模型关键词（ltx-2），
        // 依赖 is_llm_encoder 分支在前才能正确归类。
        assert_eq!(
            classify_file(
                "gemma4-12b-with-proj-ltx-2.5-bf16.safetensors",
                "gemma4-12b-with-proj-ltx-2.5-bf16",
                "text_encoders",
                24000.0,
            ),
            "llm"
        );
        assert_eq!(
            classify_file(
                "ltx-2.5-video-vae-conv-bf16.safetensors",
                "ltx-2.5-video-vae-conv-bf16",
                "vae",
                900.0,
            ),
            "vae"
        );
        assert_eq!(
            classify_file(
                "ltx-2.5-audio-vae-bf16.safetensors",
                "ltx-2.5-audio-vae-bf16",
                "vae",
                400.0,
            ),
            "audio_vae"
        );
        assert_eq!(
            classify_file(
                "ltx-2.5-22b-dev-transformer-Q8_0.gguf",
                "ltx-2.5-22b-dev-transformer-Q8_0",
                "diffusion_models",
                12000.0,
            ),
            "model"
        );
    }

    #[test]
    fn detects_wan_ti2v_before_i2v_substring() {
        assert_eq!(detect_family("Wan2.2-TI2V-5B.safetensors"), "wan-ti2v");
    }

    #[test]
    fn classifies_every_tae_flavour_as_taesd() {
        // 上游 docs/taesd.md + tae.hpp：taesd/taesdxl/taesd3（图像）、
        // taef1/taef2（Flux、Flux.2）、taehv/taew2_x（Wan VAE 系）、
        // taeh3（MiniMax-H3，上游 #1874）。
        for (name, dir) in [
            ("taesd.safetensors", "vae"),
            ("taesdxl.safetensors", "vae"),
            ("taesd3.safetensors", "vae"),
            ("taef1.safetensors", "vae"),
            ("taef2.safetensors", "vae"),
            ("taehv.safetensors", "vae"),
            ("taew2_1.safetensors", "vae"),
            ("taew2_2.safetensors", "vae"),
            ("taeh3.safetensors", "vae"),
            ("tae.safetensors", "models"),
        ] {
            let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
            assert_eq!(
                classify_file(name, stem, dir, 30.0),
                "taesd",
                "{name} should classify as taesd"
            );
        }
    }

    #[test]
    fn classifies_ip_adapter_weights_and_their_clip_vision() {
        // 上游 docs/ip_adapter.md：--ip-adapter 权重 + ViT-H/14 --clip_vision。
        for name in [
            "ip-adapter_sd15.safetensors",
            "ip-adapter_sdxl_vit-h.safetensors",
            "ip-adapter-plus_sd15.safetensors",
            "ip-adapter-plus_sdxl_vit-h.safetensors",
            "ip_adapter_sd15.safetensors",
            "IPAdapter-SDXL.safetensors",
        ] {
            let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
            assert_eq!(
                classify_file(name, stem, "controlnet", 100.0),
                "ip_adapter",
                "{name} should classify as ip_adapter"
            );
        }
        assert_eq!(
            classify_file(
                "clip_vision_h.safetensors",
                "clip_vision_h",
                "clip_vision",
                1200.0,
            ),
            "clip_vision"
        );
    }

    #[test]
    fn classifies_tae_before_the_generic_vae_rules() {
        // "tiny_autoencoder" 命中 VAE 分支的 "autoencoder"，TAE 判定必须更早，
        // 否则会被当成完整 VAE 交给 --vae。
        assert_eq!(
            classify_file(
                "tiny_autoencoder_sdxl.safetensors",
                "tiny_autoencoder_sdxl",
                "vae",
                10.0,
            ),
            "taesd"
        );
        assert_eq!(
            classify_file("taesd_vae.safetensors", "taesd_vae", "vae", 5.0),
            "taesd"
        );
        // 完整 VAE 不受影响。
        assert_eq!(classify_file("ae.safetensors", "ae", "vae", 320.0), "vae");
        assert_eq!(
            classify_file("wan_2.1_vae.safetensors", "wan_2.1_vae", "vae", 250.0),
            "vae"
        );
        // 大文件不是 TAE（TAE 权重只有几十 MB），避免误吞同名完整模型。
        assert_eq!(
            classify_file(
                "taesd_like_model.safetensors",
                "taesd_like_model",
                "models",
                6000.0
            ),
            "model"
        );
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

    #[test]
    fn detects_pid_before_backbone_name() {
        assert_eq!(
            detect_family("pid_flux1_512_to_2048_4step_bf16.safetensors"),
            "pid"
        );
    }

    #[test]
    fn detects_hunyuan_video() {
        assert_eq!(
            detect_family("hunyuanvideo1.5_720p_t2v_fp16.safetensors"),
            "hunyuan-video"
        );
    }

    #[test]
    fn detects_mage_flow_variants() {
        assert_eq!(detect_family("Mage-Flow-4B-Base.safetensors"), "mage-flow");
        assert_eq!(
            detect_family("Mage-Flow-4B-Turbo.safetensors"),
            "mage-flow-turbo"
        );
        assert_eq!(
            detect_family("Mage-Flow-Edit-4B.safetensors"),
            "mage-flow-edit"
        );
        assert_eq!(
            detect_family("mage_flow_edit_turbo_bf16.safetensors"),
            "mage-flow-edit-turbo"
        );
    }

    #[test]
    fn classifies_mage_flow_as_model_even_when_small() {
        assert_eq!(
            classify_file("mage-flow-4b.safetensors", "mage-flow-4b", "", 12.0),
            "model"
        );
    }

    #[test]
    fn classifies_hunyuan_byt5_as_t5() {
        assert_eq!(
            classify_file(
                "byt5_small_glyphxl_fp16.safetensors",
                "byt5_small_glyphxl_fp16",
                "text_encoders",
                800.0,
            ),
            "t5xxl"
        );
    }

    #[test]
    fn classifies_pid_and_hunyuan_names_as_models_even_when_small() {
        assert_eq!(
            classify_file(
                "pid_qwen_image_checkpoint.safetensors",
                "pid_qwen_image_checkpoint",
                "",
                12.0
            ),
            "model"
        );
        assert_eq!(
            classify_file(
                "hunyuan video 1.5.safetensors",
                "hunyuan video 1.5",
                "",
                12.0
            ),
            "model"
        );
    }
}
