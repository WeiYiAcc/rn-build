# rn-build（私有构建仓，不是 fork）

- 上游：https://github.com/reason-machines/reason-network （MIT OR Apache-2.0，本目录保留 LICENSE-APACHE / LICENSE-MIT / NOTICE 原文）
- 上游 HEAD（本副本来源）：5442c8b551a6897b596c7695e51b0329551aaa6c
  `fix: refuse to start on a config.toml that can't be read or parsed (#192)`，2026-11-07
- 关键提交：`777674e fix: reclaim an offline local session's name and waiting mail (#206)`（上游 2026-11-06 合并，尚未发版；最新 release 仍为 v0.12.17）
- 镜像时间：2026-11-19 21:40 IST
- 为什么自建：Pi 重启后会话名变化 → 发给旧名的消息永远 UNREAD、24h 后静默丢弃；#206 修了这条但没发版。
- 构建：`.github/workflows/build-musl.yml`，**只能 workflow_dispatch 手动触发**，产物
  `reason-network-x86_64-unknown-linux-musl.tar.gz` + `.sha256`，与上游 release 命名一致（上游 installer 按这个名字拼 URL）。
- Rust 钉 1.97.0（upstream `edition = "2024"` 要求 >= 1.85；不跟随 stable 以免哪天变了）。
