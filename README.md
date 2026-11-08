# ais2api

将 Google AI Studio 转换为 OpenAI 与 Gemini 原生兼容接口的反代服务。支持多账号并发与自动轮换、按模型独立统计配额与用量、Build 应用通道、长输出抗截断、异常自动换号重试、Workspace 账号自动重登以及网页管理后台。

---

## 一、整体结构与端口说明

默认采用单进程合并部署（由 `coord-rs/coordinator` 提供）：

| 端口 | 角色 | 说明 |
|---|---|---|
| `127.0.0.1:8890` | 协调器（调度接口） | 对外提供 `/v1/*` 与 `/v1beta/*` 模型调用接口，负责选号、配额统计、通道转换与失败重试 |
| `127.0.0.1:8893` | 管理后台 | 网页控制台（`/`），查看账号池、配额、请求记录、模型策略、Build 配置与服务状态 |
| `127.0.0.1:8894` | 登录服务 | 处理账号导入、手动重登、每晚定时重登队列与失效自动重登 |
| `127.0.0.1:2048` | 无浏览器后端 | `ais2api-headless`（无浏览器模式下的底层执行服务，维护各账号会话） |
| `127.0.0.1:8891` / `8892` | 浏览器实例 A / B | 仅在双实例 / 单实例浏览器模式下启用，对应 `ais2api-dual-a`、`ais2api-dual-b` 容器 |

反向代理（如 OpenResty / Nginx）通常将 `/v1`、`/v1beta` 转发到 `8890`，其余路径转发到 `8893`。

---

## 二、目录结构

- `coord-rs/`：当前线上默认使用的 Rust 版协调器源码与编译脚本。
  - 单进程同时承载 `8890`（调度）、`8893`（管理后台）与 `8894`（登录服务），常驻内存约 20 MB。
  - 在浏览器模式下可通过 `--side` 参数仅启动管理后台与登录服务，配合 Node 调度器运行。
- `coord-go/`：Go 版协调器源码（无浏览器模式下的备用实现）及统一启动脚本 `launch.sh`。
- `dual-runtime/`：原有的 Node.js 实现、运行期数据目录与前端静态资源。
  - `refactor/`：Node 版协调器、管理后台前端静态资源（`refactor/ui/`）、运维工具与单元测试。
  - `code/`：浏览器容器内运行的客户端脚本与响应转换模块。
  - `tools/`：浏览器 Tampermonkey（油猴）一键导入脚本与同步密钥生成工具。
- `auto-register/`：Google Workspace 批量新账号自动激活、改密、绑定 2FA 与导出登录态工具，详见 [auto-register/README.md](auto-register/README.md)。
- `docs/`：
  - [docs/COOKIE-SYNC.md](docs/COOKIE-SYNC.md)：使用油猴脚本从浏览器一键导入或刷新账号 Cookie。
  - 注：早期手动创建共享 AI Studio Build 应用（原 `docs/BUILD-APP.md`）的方式已废弃，现已不再需要，Build 项目均由协调器按账号自动创建与轮换。

---

## 三、运行模式与版本切换

### 1. 运行模式

可在管理后台实时切换，当前模式记录在 `dual-runtime/run-mode.json`：

- **无浏览器模式（`headless`，默认）**
  - 协调器将请求转发给本机 `2048` 端口的无浏览器后端服务。
  - 池中所有正常账号可同时参与调度与并发请求，无需启动 Chromium 容器，资源占用低。
- **双实例浏览器模式（`dual`）**
  - 启动 A、B 两个隔离的浏览器容器承载账号，一主一备或双活分流，支持后台无感换号、冷备预热与故障自动恢复。
- **单实例浏览器模式（`single`）**
  - 仅启动单个浏览器容器承载当前活跃账号，适合低内存机器。

> 在 `dual` / `single` 浏览器模式下，`8890` 调度器由 Node 版（`dual-runtime/refactor/start-coordinator.js`）运行以管理 Docker 浏览器容器，管理后台（`8893`）与登录服务（`8894`）仍由 Rust 进程以 `--side` 方式提供。

### 2. 协调器实现切换

`coord-go/launch.sh` 在无浏览器模式下默认启动 Rust 版，可通过标记文件或环境变量随时切换回退：

```bash
# 切回 Go 版协调器
touch /opt/ais2api/coord-go/USE_GO
systemctl restart ais2api-dual-coordinator

# 切回 Node 版协调器
touch /opt/ais2api/coord-go/USE_NODE
systemctl restart ais2api-dual-coordinator

# 恢复默认 Rust 版
rm -f /opt/ais2api/coord-go/USE_GO /opt/ais2api/coord-go/USE_NODE
systemctl restart ais2api-dual-coordinator
```

### 3. 单进程合并与拆分

默认存在 `coord-rs/MERGED` 标记文件，管理后台和登录服务合并在主进程内运行：

```bash
# 拆分为独立服务运行
/opt/ais2api/coord-rs/unmerge.sh

# 合并回单进程运行
/opt/ais2api/coord-rs/merge.sh
```

---

## 四、接口与模型前缀用法

### 1. 支持的接口路径

- OpenAI 兼容接口：
  - `GET /v1/models`
  - `POST /v1/chat/completions`（支持普通响应与 SSE 流式响应）
- Gemini 原生接口：
  - `GET /v1beta/models`
  - `POST /v1beta/models/{model}:generateContent`
  - `POST /v1beta/models/{model}:streamGenerateContent`

鉴权支持 `Authorization: Bearer <API_KEY>` 或 `x-goog-api-key: <API_KEY>`。

### 2. 模型功能前缀

可以在基础模型名（如 `gemini-2.5-pro`、`gemini-2.5-flash`）前叠加前缀来切换通道或调用方式：

- **Build 应用通道**：
  - `build/<模型名>`：通过 AI Studio Build（Applet）通道调用，使用独立的配额与 Token 用量统计。
  - `build-st/<模型名>`：Build 通道酒馆（SillyTavern）预设模式，按配置自动注入预设与上下文打包格式。
  - `bridge/<模型名>`：Build 通道桥接模式（支持附件拆分与工具调用格式透传）。
  - 每个账号下的 Build 示例项目（基于完整 Vite 模板）由协调器自动创建，达到轮换阈值或删号时自动替换与清理。
- **长输出抗截断**：
  - `anti-truncation/<模型名>`：当单次输出因长度限制中断时，自动通过内置续写机制分段拉取并拼接完整回复。
- **流式转换前缀**：
  - `假流式/<模型名>`（或后台开启全局假流式）：向上游发起非流式请求（或内部接收流并定期向客户端发送保活块），集齐完整结果后按流式格式返回，减少长思考请求断流。
  - `流式抗截断/<模型名>`：结合流式输出与断尾自动续写。
- **指定账号或分组调用**：
  - `@<账号ID>:<模型名>`（例如 `@22:gemini-2.5-pro`）：强制使用指定编号的账号发起本次请求。

---

## 五、账号调度、容错与重登机制

### 1. 配额与冷却

- 每个账号、每个模型系列（如 Pro、Flash）独立计算时间窗口内的请求次数与冷却时间。
- 单个账号在某个模型上触发限流或冷却时，不影响该账号调用其他模型，也不会阻塞池中其他正常账号。
- 模型单价配置仅用于后台估算参考费用，不参与请求放行与调度判断。

### 2. 登录失效自动换号重试

- **请求实时换号**：当某次请求遇到上游返回登录态过期（如 503 提示 `needs to sign in again`、`sign-in session expired`、`需要重新登录` 等）时，协调器会立即将该账号标为需重登，并在同一次请求内自动切换其他可用账号重试（覆盖普通、流式、假流式与抗截断路径），避免将报错直接返回给客户端。
- **后台状态同步**：无浏览器模式下，协调器每 60 秒轮询一次后端账号状态，将后端标记为 `auth_required` 的账号同步为失效状态；当账号重新登录且后端恢复 `ready` 后自动解除失效标记。

### 3. 自动重登与 Gmail 保护规则

- **Workspace 账号自动维护**：
  - 已保存登录凭据与 TOTP 密钥的自定义域名（Workspace）账号，支持**每晚 0 点全量排队重登**（逐个执行，单个失败挂起等待人工处理）以及**失效后定期自动重登**（每 5 分钟检查一次，同一账号间隔至少 6 小时，连续失败后停止自动重试）。
- **Gmail 账号排除规则**：
  - 所有 `@gmail.com` 与 `@googlemail.com` 账号**永久排除在一切自动重登之外**（包括每晚队列、后台自动重登与手动点击立即重登），防止因无密码/验证码反复尝试而触发 Google 风控。
  - Gmail 账号登录过期后仅标记状态，通过浏览器油猴脚本一键同步新 Cookie 或手动上传登录文件即可恢复。

---

## 六、账号导入方式

1. **浏览器油猴脚本导入（推荐）**
   - 安装 `dual-runtime/tools/ais2api-cookie-sync.user.js`，在已登录 AI Studio 的浏览器页面点击同步按钮，即可将当前账号导入服务器或刷新已有账号 Cookie。详见 [docs/COOKIE-SYNC.md](docs/COOKIE-SYNC.md)。
2. **管理后台网页登录 / 凭据录入**
   - 在管理后台的登录管理页可发起远程浏览器登录会话，或为 Workspace 账号配置邮箱、密码与 2FA 密钥以启用自动重登。
3. **Workspace 批量新号激活**
   - 使用 `auto-register/` 工具从管理员激活邮件链接自动完成首次改密、绑定 2FA、过条款并导出登录态文件。详见 [auto-register/README.md](auto-register/README.md)。

---

## 七、管理后台功能概览

通过浏览器访问管理后台（默认由反向代理映射至根路径 `/`）：

- **账号池管理**：查看各账号在线状态、各模型剩余配额、冷却倒计时、启用/禁用账号、分组设置、手动切换或删除账号（删号时同步清理关联的 Build 项目记录）。
- **Build 通道设置**：管理酒馆预设、系统提示词、文件打包策略、单账号项目轮换次数及独立用量统计。
- **请求历史与诊断**：查看近期请求耗时、使用账号、输入/输出/思考 Token 数量、完成状态与错误摘要。
- **运维面板**：查看协调器、无浏览器服务与容器的实时内存（已扣除系统文件页缓存，单独显示缓存占用）、查看服务日志、重启服务、切换运行模式（`headless` / `dual` / `single`）。

---

## 八、本地运行数据与隐私说明

以下运行期数据全部保存在服务器本地目录（已在 `.gitignore` 中排除，不会提交到代码仓库）：

- 账号 Cookie 与登录态文件（`auth/auth-*.json`）
- 自动重登加密凭据与密钥（`/opt/ais2api-direct/`）
- 协调器配置与 API Key（`dual-runtime/coordinator.json`）
- 后台登录密码与会话记录（`dual-runtime/console-auth.json`、`console-sessions.json`）
- 账号配额状态、Build 项目映射、预设库与请求历史（`dual-runtime/state.json`、`build-*.json`、`request-history/`）

持久化的请求历史仅记录元数据（时间、模型、账号编号、Token 计数、耗时与状态码），**不保存用户的提问正文、模型回复内容或任何账号凭据**。

---

## 九、编译与测试

### 编译 Rust 协调器

使用内置脚本通过 Docker（`rust:1-slim-bookworm`）编译，宿主机无需安装 Rust 工具链：

```bash
cd /opt/ais2api/coord-rs && ./b.sh
```

### 编译 Go 协调器（备用）

```bash
cd /opt/ais2api/coord-go
docker run --rm -v "$PWD":/src -w /src golang:1.27 go build -o coordinator .
```

### 运行 Node 侧单元测试

```bash
cd /opt/ais2api
npm test
```
