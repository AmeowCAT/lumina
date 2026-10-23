# 安全策略

## 报告渠道

本仓库分发的二进制是**未签名的本地桌面应用**，它启动并代理本机上的 `sd-server`。
如果你发现安全问题，请**不要**直接开公开 issue，改走：

- 邮件：`security@ameowcat.dev`（Subject 前缀 `[Lumina Security]`）
- 或 GitHub 的 [私密安全公告](https://github.com/AmeowCAT/lumina/security/advisories/new)

三天内会收到确认。修复发布前请勿公开细节。

## 支持范围

只有最新 release 与 `master` 接受安全修复。

## 设计边界（不算漏洞）

- `sd-server` 的 HTTP 面**没有鉴权**，只监听 `127.0.0.1`；界面也硬拒
  `--listen-ip` / `--listen-port`（含短别名 `-l`）。如果用户自己绕过这一点
  在局域网暴露服务，风险由用户承担。
- 模型权重、`--type` 量化与显存行为属于上游 `stable-diffusion.cpp`，请报上游。
- 应用不发起任何外连（没有遥测、没有更新检查）；页面 CSP 不放行 `connect-src`，
  所有 HTTP 都由 Rust 侧代理到 `127.0.0.1:<port>`。
