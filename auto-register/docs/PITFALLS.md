# 踩坑集（实测记录）

这份比代码值钱：每条都是"页面为什么这么点"的实测依据。没写在这一页的坑，
下一版改代码的人（包括未来的你）会再踩一遍。

---

## 1. 不要走「邮箱 + 密码」直登

同一个 Workspace 域里，拿邮箱去 `accounts.google.com` 输密码，很可能直接吃：

```
Couldn't sign you in
user@your-domain.com
Contact your domain admin for help.
```

这是**域策略级拒绝**，跟指纹、IP、密码正确性都无关。
但建号时 Google 发给辅助邮箱的那封「新的 Google 帐号」邮件里的
`accounts.google.com/RP?c=…&uc=ac` 链接**能免密码进**。所以整条流程从这封邮件出发。

**顺带两条实测：**

- 这种一次性链接**可以重复打开**（同一封邮件我们用过 3 次以上仍能拿回会话）。
  所以"链接烧掉"不用慌，重开同一封即可 —— 但也别浪费，毕竟它是最干净的入口。
- 会话可能因为"改密失败/中途乱跳"而丢；丢了之后再打开同一封链接又能回到流程里。

## 2. 首次登录强制改密的页面有**两套**，字段名不一样

| 页面 | 输入框 | 提交按钮 |
|---|---|---|
| `signin/challenge/pwd`（经典） | `input[name=Passwd]` / `input[name=ConfirmPasswd]` | 文本按钮 **下一步** |
| `speedbump/changepassword`（新版） | `input#Password` / `input#ConfirmPassword` | **`input#submit`，没有文字！** |

写死一套选择器必然挂一半。稳健做法：

```python
boxes = page.query_selector_all('input[type="password"]')
if len(boxes) >= 2:  # 直接填前两个
    ...
else:                # 兜底按名字
    ...
```

提交也别只按文字找：新版那个按钮根本没有文字，要回落到
`input#submit, input[type=submit], button[type=submit]`。

## 3. 提交后**必须轮询**等页面自己跳走，别 sleep 固定秒数

改密成功要 **8~12 秒**才跳转到下一个页面。只等 7 秒就会把"已经改成功、还在跳转"
误判成失败 —— 我们真的踩过：**报了失败，其实密码已经改掉，于是那个号变成"没人知道密码"**。

正确判据（三个都要满足才算离开改密页）：

```python
"changepassword" not in url and "challenge/pwd" not in url and "确认密码" not in text
```

## 4. Google 拒绝"用过的密码"

首次强制改密时，如果你填的是**这个号当前/以前的密码**，页面会写：

```
请使用您以前没有用过的密码重试
```

所以"预设密码"这个功能只在「给一个该号没用过的新密码」时成立。
填当前密码 100% 被拒，而且**提交会失败、页面不动** —— 如果你的代码不校验结果，
就会带着"改密成功"的错误认知继续往下跑，后面每一步都在游客状态下瞎点。

## 5. 抓 TOTP 密钥的正则必须**卡死 32 位**

Google 的验证器密钥是 **32 位 base32**，页面还会显示成 8 组 × 4 位。
用 `^[A-Z2-7]{16,64}$` 这种松正则会抓到 UI 文案 **`GOOGLEAUTHENTICATOR`**
（19 位、全是 base32 字母，照样通过校验）→ 存进库、算码时直接
`Error: Incorrect padding`。

首选匹配页面上带空格的 8×4 原样格式，兜底才用"精确 32 位 + 排除 UI 词"。

## 6. 「开启两步验证」的按钮在**另一个页面**上

登记完身份验证器后，你还在那页找不到"开启"开关：

- 子页上只有一个 `<a aria-label="开启">`，点它**只会返回上一页**；
- 真正要点的 `button[aria-label="开启两步验证"]` 在 `/signinoptions/twosv` 主页上。

所以流程是：登记成功 → **重新 goto `/signinoptions/twosv`** → 点那个 aria 按钮 → 再回来校验
`受两步验证功能的保护` 是否出现。

## 7. 已经登记过验证器时，按钮会改名

`添加身份验证器应用` → 变成 `更改身份验证器应用`。
写死找"添加"会空转到超时（我们卡了 60 秒）。
判据：页面含「更改身份验证器应用」+ 本地库里已有该号 32 位密钥 → 跳过重登记，直接开开关。

## 8. 辅助邮箱要**连点两次**

安全页点 `div[aria-label="添加电子邮件地址"]`（中间可能夹一次重输密码的身份验证）
→ 落到 `/recovery/email` → **还要再点一次「添加辅助邮箱」**才出表单。
漏了这一步就会一直等 `input[type="email"]` 到超时（截图能一眼看出来：页面上按钮还在）。

验证码输入框的 id 是 `c4`，验证按钮是 `button[aria-label="验证您的辅助邮箱"]`。

## 9. 动态页面（SPA）判定：**等页面表态**，别数秒

AI Studio 首次访问会弹条款门（18+ 复选框 + 继续）。它**同意状态记在账号上** ——
不点的话，导出的 cookie 拿给反代照样卡在欢迎页。

**更坑的是假阴性**：页面是 JS 渲染的，你在"弹窗还没出来"的时候去读
`document.body.innerText`，会是空白 → 于是得出"没有条款门"的结论 →
导出一个废 cookie，而日志还写着"无条款门"一切正常。

正确做法是轮询等页面**表态**，直到能区分三种状态：

```python
# ≤30s：出现欢迎语 = 有门；出现 Playground/EXPLORE/New app/Dashboard = 应用已加载；
# 都没有 = unknown（按"未过"处理并记进台账，别假装成功）
```

同一条规则适用于任何动态页面：**判据要能区分"还没渲染"和"确实没有"**。

## 10. 导 cookie 之前必须先访问一次 AI Studio

只导出 cookie 的话 `origins` 是空的（`localStorage` 没被带上）。
先 `goto("https://aistudio.google.com/")` 再 `ctx.storage_state()`，
才能把 `aiStudioUserPreference` 这类东西一起带走。

另外：**同一个身份目录不能被两个浏览器实例同时打开**，导出前先关掉窗口，
否则报 `Failed to launch`。

## 11. 记账的四条铁律（全是血泪）

1. **动过账号状态就立刻落盘**：改密一提交（不管验没验成）就要把密码写进台账。
   只在"全程成功"时记账 = 中途一挂，那个号就变成没人知道密码。
2. **字段必须清洗换行**：异常文本（Playwright 的 `Call log:`）自带换行，
   会把 TSV 台账撑成碎行、污染整个文件。
3. **锁要认 PID**：进程被强杀时 `finally` 不执行，旧锁会挡住后面所有运行。
   写锁时带上 `pid=`，启动时用 `tasklist` 验活，死的自动接管。
4. **拿不到账号邮箱也要留痕**：异常分支里如果 `account` 还是 `"unknown"` 字符串，
   千万不要拿它当台账主键（会写出一条 `unknown` 脏行）。
   要么把变量清成 `None` 再抛，要么用"（账号待确认）+ 本次身份名"兜底。

## 12. 下游反代（AIStudioToAPI）相关

- **拷 `auth-N.json` 进去不会自动热加载**：源码里没有文件监听（无 `fs.watch`），
  auth 扫描只在 ① 启动 ② 界面点「保存会话」③ 某些控制台接口被请求时发生。
  所以拷完要 `docker restart <容器>`（auth/ 与 data/ 是挂载的，不丢号），
  然后看日志里这行确认：`[Auth] Reload complete. N valid sources available: [0, 1, …]`。
- **日志里每 60 秒刷 `wss://ais-dev-….run.app` 报错 ≠ App 失效**：那是 AI Studio app
  自己 iframe 的 dev 通道问题，项目只是把页面 JS 错误原样转发；保活服务每 60 秒的
  "防超时"鼠标动作会反复惊扰它。四条免鉴权检查能分清噪音和真故障：
  App 链接（301 换成 `aistudio.google.com` 域名是正常的，404 才是死）、
  出网（宿主/容器直连与经代理拉 `_aistudio-iframe.js` 都应 200）、
  内部通道（`✅ Connection successful`）、`/health`（`browserConnected: true`）。
- **`MAX_RETRIES` 默认 3**：一次失败的调用会向上游发最多 3 次请求。
  按次数计费的场合记得调成 1。
