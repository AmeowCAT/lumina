//! Model-family detection and file classification.
//!
//! Direct port of the webui `detectFamily` / `classifyFile` Go logic, unified in
//! one place (the webui had it duplicated across Go + JS regex). Family metadata
//! (fields / genDefaults) lives in the TypeScript frontend.

fn has_any(s: &str, patterns: &[&str]) -> bool {
    patterns.iter().any(|p| s.contains(p))
}

fn is_z_image_l2p(path: &str) -> bool {
    let mut parts = path.rsplit(['/', '\\']).filter(|part| !part.is_empty());
    let name = parts.next().unwrap_or("");
    if name
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .any(|token| token == "l2p")
    {
        return true;
    }
    // 只有无线索的权重名才借助明确目录段；不能用父目录覆盖普通模型名。
    let opaque_name = name.starts_with("model-1k-merge.")
        || name.starts_with("model-1k-merge-")
        || matches!(
            name,
            "model.safetensors"
                | "model.safetensors.index.json"
                | "diffusion_pytorch_model.safetensors"
        );
    opaque_name
        && parts.any(|part| {
            matches!(part, "l2p" | "z_image_l2p" | "z-image-l2p" | "zimage-l2p")
        })
}

/// Map a model file path to one of the supported family ids.
pub fn detect_family(path: &str) -> &'static str {
    let t = path.to_lowercase();
    // SenseNova is a complete RGB-space MoT model, not a separate LLM/DiT.
    // Include the parent directory: the official entry is model.safetensors.index.json.
    if has_any(
        &t,
        &[
            "sensenova-u1",
            "sensenova_u1",
            "sensenovau1",
            "sensenova u1",
        ],
    ) {
        return "sensenova-u1";
    }
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
    // Qwen Image 2.1 单独成族（上游 #1994）：自带 VAE（与 Qwen Image / Wan2.2
    // 的 VAE 不通用）、Qwen3-VL-8B 文本编码器、宽高需 32 对齐。规则必须排在
    // 通用 qwen-image 之前，否则 qwen_image_2.1 会被子串命中误判成旧家族。
    if has_any(
        &t,
        &[
            "qwen-image-2.1",
            "qwen_image_2.1",
            "qwenimage2.1",
            "qwen-image-2_1",
            "qwen_image_2_1",
            "qwen-image-21",
            "qwen_image_21",
            "qwenimage21",
        ],
    ) {
        return "qwen-image-2.1";
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
    // PixArt-α / PixArt-Σ（上游 #2047）：DiT + T5-XXL + 4 通道 VAE。上游只有
    // 一个 VERSION_PIXART，VAE 缩放多数由权重里的 csize_embedder 自动识别，
    // 但两族的 VAE latent 空间（Σ = SDXL、α = SD1.x）与 TAE 权重不同、
    // α 512 还需要显式 --model-args 覆盖，所以按名字拆成两族，让检查单、
    // 提示与 TAE 说明落到正确的一支。
    // 官方 Σ 权重名必带 "sigma"；其余 PixArt 权重按 α 处理（官方 α 命名为
    // PixArt-XL-2-1024-MS）。判定确实为难时用户可在控制台手动覆盖家族。
    if has_any(&t, &["pixart"]) {
        if has_any(&t, &["sigma"]) {
            return "pixart-sigma";
        }
        return "pixart-alpha";
    }
    // Ming-Image 0.1 Design（上游 #2063）：DiT + Ling-mini-2.0 BF16 文本编码器
    // + Ming VAE + 外部 Ling tokenizer；当前仅文生图（参考图被实现拒绝）。
    if has_any(&t, &["ming_image", "ming-image", "mingimage"]) {
        return "ming-image";
    }
    // LLaDA-Image / LLaDA-Image-Turbo（上游 #1968）：NextDiT + LLaDA2-MoE 文本
    // 编码器 + Flux.2 VAE + --embeddings-connectors。两个 checkpoint 的
    // transformer / 文本编码器 / QueryFormer 互不通用，只有 VAE、SigVQ 与
    // tokenizer 共用，所以拆成两族避免默认值互相污染。
    if has_any(&t, &["llada-image", "llada_image", "lladaimage"]) {
        if has_any(&t, &["turbo"]) {
            return "llada-image-turbo";
        }
        return "llada-image";
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
    // L2P 必须先于通用 Z-Image；只用明确文件名或无线索权重的确切目录段。
    if is_z_image_l2p(&t) {
        return "zimage-l2p";
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

fn is_llm_encoder(test: &str, name_test: &str) -> bool {
    // LLaDA-Image 的扩散模型本体与文本编码器共用 "llada-image" 前缀
    // （llada-image-text_encoder-q8_0.gguf），必须靠 text_encoder 标记区分。
    if has_any(name_test, &["llada"]) && has_any(name_test, &["text_encoder", "text-encoder", "text encoder"])
    {
        return true;
    }
    // qwen-image is a diffusion model, not an LLM encoder.
    if has_any(name_test, &["qwen-image", "qwen_image", "qwen-image-edit"]) {
        return false;
    }
    // Ming-Image 的 DiT 与文本编码器同目录、名字都带 ming_image，必须先把
    // 编码器认出来——它不带 gemma/qwen3 等通用标记，否则会被判成 diffusion
    // 模型（名字命中扩散名单，或体积回退）。
    //
    // 官方名是 …_ling_mini_2.0_bf16.safetensors，但不能只认 "ling_mini"：
    // 去掉 mini 的命名同样存在。因此按 "带 ming_image 且带编码器线索" 兜底。
    //
    // 这里只能看 name_test：把父目录名拼进来会让 "Ming-Image-sampling"
    // （sampling 含 "ling"）之类的目录把 DiT 误判成文本编码器，而
    // Dashboard 的主模型列表只收 model 类别，模型会直接消失。
    if has_any(name_test, &["ling_mini", "ling-mini", "lingmini"]) {
        return true;
    }
    if has_any(name_test, &["ming_image", "ming-image", "mingimage"]) {
        return has_any(
            name_test,
            &["ling", "text_enc", "text-enc", "text encoder", "mllm", "connector"],
        ) && !has_any(name_test, &["lingbot", "ling-bot", "ling_bot"]);
    }
    if has_any(name_test, &["llada-image", "llada_image", "lladaimage"]) {
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
            // PixArt-α / Σ 的 DiT（上游 #2047）：pixart_sigma_xl2_1024_ms.safetensors。
            "pixart",
            // Ming-Image 0.1 Design 的 DiT（上游 #2063）；文本编码器带
            // ling_mini 标记，在 is_llm_encoder 里先被拦下。
            "ming_image",
            "ming-image",
            "mingimage",
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
            "sensenova",
            // LLaDA-Image 扩散模型（llada-image-f16.gguf / llada-image-turbo-f16.gguf）；
            // 文本编码器带 text_encoder 标记，在 is_llm_encoder 里先被拦下。
            "llada-image",
            "llada_image",
            "lladaimage",
        ],
    )
}

/// Classify a model file into a component category (model / vae / clip_l / ...).
pub fn classify_file(name: &str, stem: &str, dir_base: &str, size_mb: f64) -> &'static str {
    // 文件名线索与目录线索分开保存：`dir_base` 只是直接父目录名，用它做
    // 子串匹配会把 "Ming-Image-sampling" 这类目录误判成编码器（sampling
    // 含 "ling"），所以子串规则一律只看 name_test。
    let name_test = format!("{}|{}", name.to_lowercase(), stem.to_lowercase());
    let dir = dir_base.to_lowercase();
    let test = format!("{}|{}", name_test, dir);

    // Audio VAE (must check before generic VAE)
    if has_any(&test, &["audio_vae", "audio-vae"]) {
        return "audio_vae";
    }
    // Embedding connectors (LTX, LLaDA-Image)
    if has_any(&test, &["embeddings_connector", "connectors"]) {
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
    // Diffusers 官方仓库的组件权重是通用名（diffusion_pytorch_model.safetensors、
    // model.safetensors.index.json、model-00001-of-00002.safetensors），家族线索
    // 只在目录名里。上游 DiffusersModelLoader 正是按 unet/ vae/ text_encoder/
    // text_encoder_2/ 这些目录取权重（src/model_loader.cpp），所以这里按目录
    // 归类；否则官方 PixArt / SDXL Diffusers 目录里的组件在界面上无法选择。
    match dir.as_str() {
        "vae" | "vaes" => return "vae",
        "transformer" | "unet" => return "model",
        "text_encoder" => {
            // 同名目录在 SDXL 里是 CLIP-L、在 PixArt 里是 T5-XXL。只能按体积
            // 区分：T5-XXL 分片合计约 19GB，CLIP-L 约 250MB（索引文件按分片
            // 总和计，见 scanner::safetensors_index_info）。
            return if size_mb >= 2000.0 { "t5xxl" } else { "clip_l" };
        }
        "text_encoder_2" => return "clip_g",
        _ => {}
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
    if is_llm_encoder(&test, &name_test) {
        return "llm";
    }
    // Diffusion model by name — high-noise variant first
    if is_diffusion_model_name(&test)
        || is_z_image_l2p(&format!("{}/{}", dir, name.to_lowercase()))
    {
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
    fn detects_sensenova_packages_and_classifies_the_index() {
        for path in [
            "/models/SenseNova-U1.5-8B-MoT/model.safetensors.index.json",
            "D:\\models\\sensenova_u1_5\\model.safetensors.index.json",
            "SenseNovaU1.5-8B-MoT.safetensors",
        ] {
            assert_eq!(detect_family(path), "sensenova-u1");
        }
        assert_eq!(
            classify_file(
                "model.safetensors.index.json",
                "model",
                "SenseNova-U1.5-8B-MoT",
                0.01
            ),
            "model"
        );
        assert_eq!(detect_family("unrelated-model.gguf"), "custom");
    }

    #[test]
    fn detects_pixart_and_ming_image() {
        // 官方 Σ 权重名带 sigma；α 的 PixArt-XL-2-1024-MS 不含，按 α 处理。
        assert_eq!(
            detect_family("pixart_sigma_xl2_1024_ms.safetensors"),
            "pixart-sigma"
        );
        assert_eq!(
            detect_family("PixArt-Sigma-XL-2-1024-MS.safetensors"),
            "pixart-sigma"
        );
        assert_eq!(
            detect_family("PixArt-XL-2-1024-MS.safetensors"),
            "pixart-alpha"
        );
        assert_eq!(detect_family("pixart_xl2_512.safetensors"), "pixart-alpha");
        assert_eq!(
            detect_family("ming_image_0.1_design_bf16.safetensors"),
            "ming-image"
        );
    }

    #[test]
    fn classifies_pixart_and_ming_components() {
        // Ming 的文本编码器（Ling-mini-2.0）不带通用编码器标记，必须按名字
        // 进 llm，而不是被大小回退判成 diffusion 模型。
        assert_eq!(
            classify_file(
                "ming_image_0.1_ling_mini_2.0_bf16.safetensors",
                "ming_image_0.1_ling_mini_2.0_bf16",
                "text_encoders",
                4000.0,
            ),
            "llm"
        );
        // 去掉 mini 的命名同样要认成编码器（名字里没有 gemma/qwen3 线索）。
        assert_eq!(
            classify_file(
                "ming_image_0.1_ling_bf16.safetensors",
                "ming_image_0.1_ling_bf16",
                "text_encoders",
                4000.0,
            ),
            "llm"
        );
        // LingBot Video 的扩散权重也含 "ling"，不能被误认成文本编码器。
        assert_eq!(
            classify_file(
                "lingbot-video-14b-bf16.safetensors",
                "lingbot-video-14b-bf16",
                "diffusion_models",
                20000.0,
            ),
            "model"
        );
        assert_eq!(
            classify_file(
                "ming_image_0.1_design_bf16.safetensors",
                "ming_image_0.1_design_bf16",
                "diffusion_models",
                12000.0,
            ),
            "model"
        );
        assert_eq!(
            classify_file(
                "ming_image_vae_bf16.safetensors",
                "ming_image_vae_bf16",
                "vae",
                300.0,
            ),
            "vae"
        );
        assert_eq!(
            classify_file(
                "pixart_sigma_xl2_1024_ms.safetensors",
                "pixart_sigma_xl2_1024_ms",
                "diffusion_models",
                2500.0,
            ),
            "model"
        );
        assert_eq!(
            classify_file("pixart_vae.safetensors", "pixart_vae", "vae", 300.0),
            "vae"
        );
        assert_eq!(
            classify_file("t5xxl.safetensors", "t5xxl", "text_encoders", 9000.0),
            "t5xxl"
        );
        // 官方 Diffusers 布局：组件是通用名，线索只在目录名里。
        assert_eq!(
            classify_file(
                "model.safetensors.index.json",
                "model",
                "text_encoder",
                19000.0,
            ),
            "t5xxl"
        );
        assert_eq!(
            classify_file("model.safetensors", "model", "text_encoder", 250.0),
            "clip_l"
        );
        assert_eq!(
            classify_file("model.safetensors", "model", "text_encoder_2", 700.0),
            "clip_g"
        );
        assert_eq!(
            classify_file(
                "diffusion_pytorch_model.safetensors",
                "diffusion_pytorch_model",
                "vae",
                320.0,
            ),
            "vae"
        );
        assert_eq!(
            classify_file(
                "diffusion_pytorch_model.safetensors",
                "diffusion_pytorch_model",
                "transformer",
                2800.0,
            ),
            "model"
        );
        // 父目录名不得参与编码器判定：Ming-Image-sampling 含 "ling"。
        for dir in ["Ming-Image-sampling", "Ming-Image-scaling", "Ming-Image-tiling"] {
            assert_eq!(
                classify_file(
                    "ming_image_0.1_design_bf16.safetensors",
                    "ming_image_0.1_design_bf16",
                    dir,
                    12000.0,
                ),
                "model"
            );
        }
    }

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
    fn detects_qwen_image_2_1_before_generic_qwen_image() {
        // 2.1 单独成族：自带 VAE / Qwen3-VL，不能被通用 qwen-image 子串吞掉。
        for path in [
            "/models/qwen_image_2.1-Q4_K.gguf",
            "D:\\models\\Qwen-Image-2.1\\diffusion_models\\qwen_image_2.1_int8_convrot.safetensors",
            "qwen_image_21_f16.gguf",
        ] {
            assert_eq!(detect_family(path), "qwen-image-2.1", "{path}");
        }
        // 旧 Qwen Image 仍留在原族。
        assert_eq!(detect_family("qwen_image_fp16.safetensors"), "qwen-image");
    }

    #[test]
    fn classifies_qwen_image_2_1_components() {
        assert_eq!(
            classify_file(
                "qwen_image_2.1_vae_bf16.safetensors",
                "qwen_image_2.1_vae_bf16",
                "vae",
                250.0
            ),
            "vae"
        );
        // Qwen3-VL 文本编码器按 qwen3- 规则归到 llm，而不是被 qwen-image 规则吞掉。
        assert_eq!(
            classify_file(
                "Qwen3VL-8B-Instruct-Q4_K_M.gguf",
                "Qwen3VL-8B-Instruct-Q4_K_M",
                "text_encoders",
                5000.0
            ),
            "llm"
        );
    }

    #[test]
    fn detects_and_classifies_llada_image() {
        assert_eq!(detect_family("llada-image-f16.gguf"), "llada-image");
        assert_eq!(
            detect_family("/models/LLaDA-Image-Turbo-GGUF/llada-image-turbo-f16.gguf"),
            "llada-image-turbo"
        );

        // 本体是扩散模型，文本编码器带 text_encoder 标记必须归 llm。
        assert_eq!(
            classify_file("llada-image-f16.gguf", "llada-image-f16", "models", 3000.0),
            "model"
        );
        assert_eq!(
            classify_file(
                "llada-image-turbo-text_encoder-q8_0.gguf",
                "llada-image-turbo-text_encoder-q8_0",
                "models",
                4000.0,
            ),
            "llm"
        );
        // 预合并 connectors 走 --embeddings-connectors；VAE 复用 Flux.2 那份。
        assert_eq!(
            classify_file(
                "llada-image-turbo-connectors.safetensors",
                "llada-image-turbo-connectors",
                "models",
                1500.0,
            ),
            "embeddings"
        );
        assert_eq!(
            classify_file("llada_vae.safetensors", "llada_vae", "vae", 300.0),
            "vae"
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

    /// 上游 #2075：L2P 既不是普通 Z-Image 也不是 Turbo——它不需要 VAE，
    /// 尺寸按 16 对齐，默认参数也不同。检测规则必须排在通用 zimage 之前，
    /// 否则 z_image_l2p 会被子串命中误判成 zimage。
    #[test]
    fn detects_z_image_l2p_before_generic_z_image() {
        assert_eq!(detect_family("/models/L2P/model-1k-merge.safetensors"), "zimage-l2p");
        assert_eq!(
            detect_family("/models/z_image_l2p_f16.safetensors"),
            "zimage-l2p"
        );
        assert_eq!(detect_family("Z-Image-L2P-Q8_0.gguf"), "zimage-l2p");
        // 普通 Z-Image / Turbo 不受影响。
        assert_eq!(detect_family("/models/z_image_turbo.safetensors"), "zimage-turbo");
        assert_eq!(detect_family("/models/z-image-base.safetensors"), "zimage");
    }

    #[test]
    fn l2p_directories_do_not_override_unrelated_models() {
        for dir in ["l2p-backups", "scal2per", "L2P"] {
            assert_eq!(
                detect_family(&format!("D:\\models\\{}\\z_image_turbo.safetensors", dir)),
                "zimage-turbo"
            );
            assert_eq!(
                detect_family(&format!("/models/{}/sdxl_base.safetensors", dir)),
                "sdxl"
            );
            assert_eq!(
                detect_family(&format!("/models/{}/wan2.1-t2v.safetensors", dir)),
                "wan-t2v"
            );
        }
        assert_eq!(detect_family("/models/scal2per.safetensors"), "custom");
        assert_eq!(
            detect_family("/models/l2p-backups/model-1k-merge.safetensors"),
            "custom"
        );
        assert_eq!(
            detect_family("/models/L2P/transformer/model.safetensors"),
            "zimage-l2p"
        );
        assert_eq!(classify_file("helper.gguf", "helper", "l2p-backups", 12.0), "other");
        assert_eq!(classify_file("scal2per.gguf", "scal2per", "", 12.0), "other");
        assert_eq!(classify_file("l2p-q8.gguf", "l2p-q8", "", 220.0), "model");
    }

    #[test]
    fn classifies_z_image_l2p_components() {
        // L2P 主模型（量化后可能只有几百 MB）仍要落 model，不能靠体积回退。
        assert_eq!(
            classify_file(
                "z_image_l2p_f16.gguf",
                "z_image_l2p_f16",
                "diffusion_models",
                220.0
            ),
            "model"
        );
        // 文本编码器仍是 Qwen3-4B，走 llm 类别。
        assert_eq!(
            classify_file(
                "qwen_3_4b.safetensors",
                "qwen_3_4b",
                "text_encoders",
                8000.0
            ),
            "llm"
        );
    }
}
