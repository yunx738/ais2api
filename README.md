# ais2api

把 Google AI Studio 转成 OpenAI / Gemini 兼容接口的自用反代，带多账号轮换、配额账本、Build 通道、抗截断和管理后台。

## 目录结构

- `coord-rs/`：当前线上默认使用的 Rust 协调器。单个进程同时提供调度接口（`8890`）、管理后台（`8893`）和登录服务（`8894`），内存占用约 20 MB。
- `coord-go/`：Go 版协调器（无浏览器模式回退备选）及启动脚本 `launch.sh`。
- `dual-runtime/`：原有的 Node.js 实现、静态前端资源（`refactor/ui/`）、浏览器 worker 脚本和油猴导入脚本（`tools/`）。在双实例 / 单实例浏览器模式下仍由 Node 负责管理浏览器容器，Rust 以 `--side` 副进程提供管理后台和登录服务。
- `auto-register/`：Google Workspace 批量新号自动激活与登录态导出工具，见 [auto-register/README.md](auto-register/README.md)。
- `docs/`：
  - [docs/COOKIE-SYNC.md](docs/COOKIE-SYNC.md)：用油猴脚本从浏览器一键导入 / 刷新账号 Cookie
  - 注：早期手动创建共享 AI Studio Build 应用（原 `docs/BUILD-APP.md`）的方式已废弃，现已不再需要，Build 项目均由协调器按账号自动创建与轮换。

## 运行模式

可在管理后台切换，状态保存在 `dual-runtime/run-mode.json`：

1. **无浏览器模式（`headless`，默认）**：协调器把请求转发给本机的无浏览器后端服务（`127.0.0.1:2048`），所有已导入账号可同时并发使用，不需要跑浏览器容器。
2. **双实例 / 单实例浏览器模式（`dual` / `single`）**：由 A/B 两个隔离的浏览器容器承载账号，支持自动换号、冷备保活与故障恢复。

### 协调器版本切换

`coord-go/launch.sh` 默认在无浏览器模式下启动 Rust 版（`coord-rs/coordinator`）：

- 临时切回 Go 版：`touch /opt/ais2api/coord-go/USE_GO && systemctl restart ais2api-dual-coordinator`
- 临时切回 Node 版：`touch /opt/ais2api/coord-go/USE_NODE && systemctl restart ais2api-dual-coordinator`
- 拆开管理后台与登录服务（不用单进程合并）：执行 `coord-rs/unmerge.sh`；重新合并执行 `coord-rs/merge.sh`

## 主要功能

- **接口兼容**：支持 `/v1/chat/completions`（含流式、假流式）、`/v1/models` 以及原生 `/v1beta/models/*:generateContent`、`:streamGenerateContent`。
- **Build 通道**：模型名前加 `build/`、`build-st/` 或 `bridge/` 走 AI Studio Build 应用通道，带独立 Token 账本、预设注入和每账号独立项目自动创建与轮换。
- **抗截断**：模型名前加 `anti-truncation/`，通过内置工具调用与续写拼接长输出。
- **账号与重登**：
  - 支持按前缀指定账号（`@账号ID:模型名`）或按分组调度。
  - 请求遇到账号登录态过期（503）时，立即将该账号标为失效并自动换号重试，不把错误直接抛给客户端。
  - 配置了凭据的 Workspace 账号支持每晚排队重登与失效自动重登；`@gmail.com` 账号固定排除在一切自动重登之外，避免触发风控，仅通过油猴脚本或手动更新 Cookie 恢复。
- **隐私与本地数据**：账号 Cookie、密码库、API Key、配额状态、请求历史、价格与预设均存放在本机运行目录（已在 `.gitignore` 排除），不会进入仓库，持久化历史也不记录对话正文。

## 编译

Rust 协调器（使用 Docker `rust:1-slim-bookworm`，无需宿主机安装工具链）：

```bash
cd coord-rs && ./b.sh
```
