# workspace-auto-register

把「**Google Workspace 新账号的激活**」做成一条命令：从邮箱里的一封一次性登录链接出发，
自动改密、绑两步验证、绑辅助邮箱、过 AI Studio 条款门、导出登录态（可直接喂 AIStudioToAPI 那类反代）。

面向的场景：你用 Workspace 后台**批量建了号**（每个号带一个辅助邮箱），
建号后 Google 会给每个辅助邮箱发一封「新的 Google 帐号」登录说明邮件 —— 本工具就是吃这封邮件的。

> ⚠️ 请只在你**自己拥有/被授权管理**的账号上使用。自动化操作账号有被封的风险，自行判断。

---

## 一、它到底做了什么

一个号跑完这 7 步（每步的"成功判据"都有校验，不是点点就算）：

| # | 步骤 | 关键点 |
|---|---|---|
| ① | 打开邮件里的 `accounts.google.com/RP?c=…` | 免密码登录（直登常被 Workspace 域拒绝） |
| ② | 接受 Workspace 代管条款 | 只在第一次出现 |
| ③ | 首次登录强制改密 | 用 `presets.txt` 的预设密码，或自动生成 16 位 |
| ④ | 绑身份验证器 + 开启两步验证 | 抓 32 位 base32 密钥存本地库（不回显） |
| ⑤ | 绑辅助邮箱 | 从邮箱取 6 位验证码回填 |
| ⑥ | 过 AI Studio 条款门 | 18+ 复选框 + 继续（同意状态记在账号上） |
| ⑦ | 导出登录态 | `{cookies, origins, accountName, savedAt}` |

输出：

```
output/
  accounts.tsv        台账：邮箱 / 密码 / 备注 / 日期 / cookie路径 / 状态
  cookies/<账号>.json 登录态
  runs/<时间戳>/      run.log、results.json、失败截图
  imported.json       （可选）导入反代记录
secrets.json          TOTP 密钥库  ← 等于所有号的二步验证钥匙
mailbox-token.json    邮箱授权 token
```

## 二、依赖与安装

- Windows / macOS / Linux 均可（默认参数按 Windows 的 `tasklist` 判锁，其它系统见 `register.acquire_lock`）
- Python 3.10+
- 浏览器底座：[camoufox](https://github.com/daijro/camoufox)（反检测 Firefox，自带指纹伪装）

```bash
pip install camoufox
python -m camoufox fetch          # 下载浏览器本体（几百 MB，耐心等）
```

## 三、配置（3 分钟）

1. 复制 `config.example.json` → **`config.json`**，填：
   - `domain`：你的 Workspace 域名
   - `mailbox` / `recovery_email`：收信邮箱（新号登录链接发到这里）
   - `graph_client_id`（**必填**）：去 Azure 注册一个「公共客户端」应用，4 步：
     ① portal.azure.com → 搜「应用注册」→ 新注册
     ② 名称随便填；「受支持的帐户类型」选「仅个人 Microsoft 帐户」
     ③ 复制「应用程序(客户端) ID」→ 填进 `config.json`
     ④ 进「身份验证」→ 页面底部「允许公共客户端流」设为「是」→ 保存
2. 复制 `presets.example.txt` → **`presets.txt`**（可选）：想指定某个号的密码/辅助邮箱就写在这里
3. 邮箱授权（只需一次）：

```bash
python mailbox.py --login      # 打印一个码 + 网址，去浏览器输一次
```

> **单实例**：邮箱的 `refresh_token` 每次刷新都会滚动，两个进程同时用会互相顶掉。
> `register.py` 自带按 PID 的锁，别绕过它并发跑。

## 四、跑

```bash
python register.py --dry-run     # 先看看收件箱里有多少待激活的链接
python register.py --limit 1     # 先跑 1 个（建议第一次务必这样）
python register.py               # 全部跑掉
```

跑的时候会**弹出浏览器窗口**（`config.json` 里 `headless: false`）——建议前几次盯着看，
确认每一步的页面行为符合预期；稳定后再改 `headless: true` 全自动。

## 五、（可选）导入反代

如果你的下游是 AIStudioToAPI（Docker 版）：

```bash
python import_to_proxy.py --dry-run    # 看哪些号还没导入
python import_to_proxy.py              # 拷贝 auth-N.json → 重启容器 → 校验
```

`config.json` 里填 `proxy_auth_dir`（容器挂载出来的 `auth/` 目录）和 `proxy_container`（容器名）。

## 六、安全须知

- `secrets.json`、`mailbox-token.json`、`output/cookies/*.json`、`config.json` **都在 .gitignore 里**
  —— 分享代码前确认没把它们带出去。cookie 文件 = 账号的完整登录态，明文，等于钥匙。
- 建议给 `secrets.json` 收紧权限（Windows：`icacls secrets.json /inheritance:r /grant:r "%USERNAME%:F"`）。
- 脚本的设计约定是**秘密不进日志**：密码/TOTP 密钥/验证码都只写文件，日志最多打指纹
  （`W7N5…TFNS` 这种）。改代码时请保持这个约定。
- 台账里的密码是明文的（这是它的用途），别把台账放进云同步/共享目录。

## 七、其它工具

```bash
python totp.py --selftest        # TOTP 实现自检（RFC 6238 官方向量）
python totp.py --list            # 看密钥库有哪些条目（只显示指纹）
python totp.py <账号邮箱>        # 出 6 位验证码
python export_cookies.py --profile <身份目录> --name <账号>   # 单独重导某个号的登录态
```

## 八、别人拿去能复刻吗（前提清单）

**能复刻的是后半程**（登录链接 → 激活 → 改密 → 2FA → 辅助邮箱 → AI Studio → 导出 cookie），
前提是这几样：

| 需要 | 说明 |
|---|---|
| **自己管得着的 Workspace 域** | 这套流程的起点是：管理员建号时把「辅助邮箱」填成你的邮箱，Google 会给那个邮箱发一封带一次性登录链接的「登录说明」。没有域管理员权限，前一半无从谈起（框架不管建号） |
| 一个能收信的邮箱 + 自己的 Azure client id | 见「三、配置」 |
| camoufox | `pip install camoufox` + `python -m camoufox fetch`（浏览器本体几百 MB，国内网络可能很慢） |
| **界面语言要对上** | ⚠ 选择器是按**中文界面**写的：`下一步` / `我了解` / `添加辅助邮箱` / `继续` / `保存` … 账号或浏览器是英文界面时，要把这些文案换成对应语言，否则会一路卡在超时上。要改的位置：`register.py` 里所有 `click_text(...)`、`wait_text(...)` 的字符串 |
| Windows 的 `tasklist` | 单实例锁用它判进程是否还活着；Linux/macOS 把 `acquire_lock()` 里那行换成 `ps -p <pid>` 即可 |

## 九、踩过的坑

全部写在 **[docs/PITFALLS.md](docs/PITFALLS.md)** —— 那一份比代码更值钱：
每条都是"页面为什么这么点"的实测依据（改密页有两套字段名、密钥正则会抓到 UI 文案、
SPA 判定不能 sleep 固定秒数、辅助邮箱要连点两次……）。改代码前请先读它。
