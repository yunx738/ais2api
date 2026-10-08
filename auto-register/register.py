# -*- coding: utf-8 -*-
"""通用框架：从「邮箱里的一次性登录链接」出发，自动激活 Google Workspace 账号并导出登录态。

一次跑通一个账号的完整链路：
    ① 打开邮件里的 accounts.google.com/RP?c=… 一次性链接（免密码）
    ② 接受 Workspace 代管条款（如出现）
    ③ 首次登录强制改密（用预设密码，或自动生成 16 位强密码）
    ④ 绑身份验证器（抓 32 位 base32 密钥 → 存本地 TOTP 库）
       并开启两步验证
    ⑤ 绑辅助邮箱（从邮箱取 6 位验证码回填）
    ⑥ 进 AI Studio 过首次条款门（18+ 复选框 + 继续）
    ⑦ 导出登录态 cookie（形状可直接喂 AIStudioToAPI 的 auth-N.json）

设计约定（都是踩过坑才定下来的，详见 docs/PITFALLS.md）：
    * 只走邮箱一次性链接，不走「邮箱+密码」直登（Workspace 域常直接拒绝）
    * 所有秘密（密码/TOTP 密钥/验证码）不打印，只写文件；日志最多打指纹
    * 只要动过账号状态（改密），无论这一步成功与否，值都要立刻落盘记账
    * 单实例锁（按 PID 判活）：并发会互相顶掉邮箱的 refresh_token

用法：
    python register.py                 # 处理收件箱里所有待激活的新号
    python register.py --limit 2       # 只处理 2 个
    python register.py --dry-run       # 只列出待处理的链接，不操作
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import struct
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from camoufox.fingerprints import Screen
from camoufox.sync_api import Camoufox

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

STEP_TIMEOUT = 60_000
SCREEN_W, SCREEN_H = 1920, 1080

# ───────────────────────── 配置 ─────────────────────────

DEFAULTS = {
    "domain": "example.com",                 # 你的 Workspace 域名
    "mailbox": "you@outlook.com",            # 收信邮箱（新号的登录链接发到这里）
    "graph_client_id": "",                   # Microsoft Graph 设备码用（见 mailbox.py 注释）
    "recovery_email": "you@outlook.com",     # 默认绑定的辅助邮箱
    "mail_subject_keywords": ["新的 Google", "Google 帐号"],   # 识别「新账号」邮件的关键词
    "profiles_dir": "profiles",              # 每个号一个浏览器身份目录
    "output_dir": "output",                  # 产出根目录
    "accounts_tsv": "output/accounts.tsv",   # 台账
    "cookies_dir": "output/cookies",         # 登录态
    "otp_store": "secrets.json",             # TOTP 密钥库（务必 gitignore！）
    "presets_file": "presets.txt",           # 预设表：别名/邮箱 → 密码、辅助邮箱
    "headless": False,                       # False = 看着它跑（推荐先看着跑）
}


def load_config(path: Path) -> dict:
    cfg = dict(DEFAULTS)
    if path.exists():
        cfg.update(json.loads(path.read_text(encoding="utf-8")))
    else:
        print(f"[!] 没找到 {path}，用示例配置跑（多数会失败）。先复制 config.example.json → config.json 并填好。")
    for k in ("profiles_dir", "output_dir", "accounts_tsv", "cookies_dir", "otp_store", "presets_file"):
        p = Path(cfg[k])
        cfg[k + "_path"] = (HERE / p) if not p.is_absolute() else p
    cfg["config_path"] = path
    return cfg


CONFIG: dict = {}
LOG_FILE = None


def log(msg: str) -> None:
    line = f"[{datetime.now():%H:%M:%S}] {msg}"
    print(line, flush=True)
    if LOG_FILE is not None:          # 同时落一份到 runs/<时间戳>/run.log，事后可查
        try:
            LOG_FILE.write(line + "\n")
            LOG_FILE.flush()
        except Exception:
            pass


# ───────────────────────── 小工具 ─────────────────────────

def pwgen(length: int = 16) -> str:
    """四类字符都带上的随机强密码（不含易混字符）。"""
    import secrets as _s
    alphabets = ["abcdefghjkmnpqrstuvwxyz", "ABCDEFGHJKMNPQRSTUVWXYZ", "23456789", "!@#$%^&*-_=+"]
    pwd = [_s.choice(a) for a in alphabets]
    pool = "".join(alphabets)
    pwd += [_s.choice(pool) for _ in range(max(0, length - len(pwd)))]
    _s.SystemRandom().shuffle(pwd)
    return "".join(pwd)


def totp_now(secret: str) -> str:
    """按 RFC 6238 算 6 位码（30 秒窗口）。"""
    s = secret.replace(" ", "").upper()
    key = base64.b32decode(s + "=" * (-len(s) % 8), casefold=True)
    counter = int(time.time()) // 30
    d = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    o = d[-1] & 0x0F
    return str((struct.unpack(">I", d[o:o + 4])[0] & 0x7FFFFFFF) % 10 ** 6).zfill(6)


def save_secret(entry: str, secret: str) -> None:
    p = CONFIG["otp_store_path"]
    store = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    store[entry] = {"label": entry, "secret": secret, "digits": 6, "period": 30, "algo": "sha1"}
    p.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")


def has_secret(entry: str) -> bool:
    p = CONFIG["otp_store_path"]
    if not p.exists():
        return False
    store = json.loads(p.read_text(encoding="utf-8"))
    return entry in store and len(store[entry].get("secret", "")) == 32


def load_presets() -> dict:
    """预设表：每行 `<邮件别名 或 账号邮箱>\\t[密码]\\t[辅助邮箱]`，后两列可空，# 是注释。"""
    p = CONFIG["presets_file_path"]
    out = {}
    if not p.exists():
        return out
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [x.strip() for x in line.split("\t")]
        if parts and parts[0]:
            out[parts[0]] = (parts[1:] + ["", ""])[:2]
    if out:
        log(f"预设表 {len(out)} 条")
    return out


def upsert_ledger(account: str, password: str, note: str, extra: str = "", status: str = "OK") -> None:
    """按账号 upsert 一行台账。

    ★ 字段必须清掉换行/制表符：异常文本（如 Playwright 的 "Call log:"）自带换行，
      会把 TSV 撑成碎行、污染整个台账。
    """
    clean = lambda s: " ".join(str(s).replace("\t", " ").split())
    account, password, note, extra, status = map(clean, (account, password, note, extra, status))
    f = CONFIG["accounts_tsv_path"]
    f.parent.mkdir(parents=True, exist_ok=True)
    header = "# 邮箱\t密码\t备注\t日期\t其他\t状态\n"
    lines = [l for l in f.read_text(encoding="utf-8").splitlines() if l.strip()] if f.exists() else []
    body = [l for l in lines if not l.startswith("#") and l.split("\t")[0].strip() != account]
    row = f"{account}\t{password}\t{note}\t{datetime.now():%Y-%m-%d}\t{extra}\t{status}"
    f.write_text(header + "\n".join(body + [row]) + "\n", encoding="utf-8")


def acquire_lock() -> None:
    """单实例锁，认 PID：进程被强杀时留下的锁能自动接管。"""
    lock = HERE / ".run.lock"
    if lock.exists():
        txt = lock.read_text(encoding="utf-8", errors="replace")
        m = re.search(r"pid=(\d+)", txt)
        alive = False
        if m:
            try:
                out = subprocess.run(["tasklist", "/FI", f"PID eq {m.group(1)}", "/NH"],
                                     capture_output=True, text=True, timeout=20).stdout
                alive = m.group(1) in out
            except Exception:
                alive = True
        if alive:
            sys.exit(f"[x] 已有一次运行在进行（{lock}）。确认没在跑就删掉它再试。")
        log("接管陈旧锁")
        lock.unlink(missing_ok=True)
    lock.write_text(f"pid={os.getpid()} at={datetime.now()}", encoding="utf-8")


def release_lock() -> None:
    (HERE / ".run.lock").unlink(missing_ok=True)


# ───────────────────────── 页面操作（选择器全部实测过） ─────────────────────────

CLICK_TEXT_JS = """(t) => {
  const els = [...document.querySelectorAll('button,[role=button],span,a,div')];
  const leaf = els.find(e => e.children.length === 0 && (e.innerText||'').trim() === t);
  const hit = leaf || els.find(e => (e.innerText||'').trim() === t);
  if (!hit) return false;
  hit.scrollIntoView({block:'center'});
  hit.click();
  return true;
}"""

STATE_JS = """() => ({
  url: location.href,
  title: document.title,
  text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' '),
  inputs: [...document.querySelectorAll('input')].map(e => ({id: e.id, name: e.name, type: e.type,
                                                            len: (e.value || '').length})),
})"""

# ★ 密钥抓取必须卡死 32 位，否则会抓到 "GOOGLEAUTHENTICATOR" 这种 UI 文案
#   （19 位、全是 base32 字母，松正则照样通过）
READ_SECRET_JS = """() => {
  const norm = t => String(t||'').replace(/[\\s-]/g,'').toUpperCase();
  const isSecret = m => /^[A-Z2-7]{32}$/.test(m);
  const BAD = /GOOGLE|AUTHENTICATOR|FIREFOX|CHROME|MOZILLA|EDGE|WINDOWS/;
  const hits = [];
  const spaced = /(?:[A-Za-z2-7]{4}[ \\t]+){7}[A-Za-z2-7]{4}/g;      // 页面原样：8 组 × 4 位
  for (const m of (document.body.innerText||'').match(spaced) || []) hits.push(norm(m));
  if (!hits.length) {
    document.querySelectorAll('div,span,p,b,strong,input,textarea').forEach(e => {
      if (e.children && e.children.length) return;
      const m = norm(e.value !== undefined && e.value ? e.value : (e.innerText||''));
      if (isSecret(m) && !BAD.test(m)) hits.push(m);
    });
  }
  return hits.filter(isSecret).filter(m => !BAD.test(m))[0] || '';
}"""

AI_STUDIO_URL = "https://aistudio.google.com/"


class Flow:
    """一个账号的完整流程。"""

    def __init__(self, page, ctx, run_dir: Path, mailbox, cfg: dict):
        self.page, self.ctx, self.run_dir = page, ctx, run_dir
        self.mail, self.cfg = mailbox, cfg
        self.password_set = None        # True 改成了 / False 本来就不用改
        self.password_attempted = None  # 点过提交（哪怕没验成）
        self.known_email = None         # 页面上见过的账号邮箱
        self.ai_tos_ok = None           # AI Studio 条款门过没过
        self._current_password = None

    # — 基础设施 —
    def state(self) -> dict:
        return self.page.evaluate(STATE_JS)

    def shot(self, tag: str) -> Path:
        p = self.run_dir / f"{tag}.jpg"
        try:
            self.page.screenshot(path=str(p), type="jpeg", quality=60)
        except Exception:
            pass
        return p

    def click_text(self, text: str, timeout: int = STEP_TIMEOUT) -> bool:
        deadline = time.time() + timeout / 1000
        while time.time() < deadline:
            if self.page.evaluate(CLICK_TEXT_JS, text):
                return True
            time.sleep(0.5)
        raise TimeoutError(f"找不到可点的文本：{text}")

    def click_aria(self, selector: str, timeout: int = STEP_TIMEOUT) -> None:
        self.page.wait_for_selector(selector, state="attached", timeout=timeout)
        self.page.eval_on_selector(selector, "el => { el.scrollIntoView({block:'center'}); el.click(); }")

    def wait_input(self, selector: str, timeout: int = STEP_TIMEOUT):
        self.page.wait_for_selector(selector, state="visible", timeout=timeout)
        return self.page.locator(selector).first

    def wait_text(self, needle: str, timeout: int = STEP_TIMEOUT) -> bool:
        deadline = time.time() + timeout / 1000
        while time.time() < deadline:
            if needle in self.page.evaluate("() => document.body ? document.body.innerText : ''"):
                return True
            time.sleep(0.5)
        return False

    def _remember_email(self) -> None:
        m = re.search(r"[A-Za-z0-9._%+-]+@" + re.escape(self.cfg["domain"]), self.state()["text"])
        if m:
            self.known_email = m.group(0)

    def account_email(self) -> str:
        """从账号页里读出本号邮箱（读不到返回 unknown）。"""
        self.page.goto("https://myaccount.google.com/", wait_until="domcontentloaded", timeout=STEP_TIMEOUT)
        time.sleep(3)
        m = re.search(r"[A-Za-z0-9._%+-]+@" + re.escape(self.cfg["domain"]), self.state()["text"])
        return m.group(0) if m else "unknown"

    # — 流程各步 —
    def step_login_by_link(self, link: str) -> None:
        log("  ① 打开邮件里的一次性登录链接")
        self.page.goto(link, wait_until="domcontentloaded", timeout=STEP_TIMEOUT)
        time.sleep(4)
        self._remember_email()
        txt = self.state()["text"]
        if "无法让您登录" in txt or "Couldn't sign you in" in txt:
            raise RuntimeError("该账号被域管理员限制（域级拒绝），跳过")

    def step_accept_tos(self) -> None:
        st = self.state()
        if "我了解" in st["text"] or "欢迎使用您的新账号" in st["text"]:
            log("  ② 接受 Workspace 代管条款")
            deadline = time.time() + 60
            clicks = 0
            while time.time() < deadline:
                url, txt = self.page.url, self.state()["text"]
                if "workspacetermsofservice" not in url and "欢迎使用您的新账号" not in txt:
                    break
                if clicks < 3 and ("我了解" in txt):
                    self.click_text("我了解")
                    clicks += 1
                    time.sleep(4)
                    continue
                time.sleep(1)
            else:
                raise RuntimeError("条款页未通过（点击后页面未跳转）")
            time.sleep(2)

    def step_set_password(self, password: str) -> None:
        """首次登录强制改密。

        ★ 两个坑：
          a) 页面有两种变体，输入框不同名：
             signin/challenge/pwd      → input[name=Passwd]/input[name=ConfirmPasswd]
             speedbump/changepassword  → input#Password/input#ConfirmPassword
             提交按钮也可能是没有文字的 <input id=submit type=submit>
          b) 提交后**必须轮询等页面离开改密页**才算成功；只 sleep 几秒会把
             "已经改成功但还在跳转" 误判成失败（实测踩过，还把已生效的密码弄丢）。
        """
        self._remember_email()
        txt = self.state()["text"]
        if not any(k in txt for k in ("创建安全系数高的密码", "创建一个您不会在其他网站上使用",
                                      "更改密码", "设置密码")):
            if "workspacetermsofservice" in self.page.url or "欢迎使用您的新账号" in txt:
                raise RuntimeError("仍停在条款页")
            log("  ③ 无需改密（该号已激活过）")
            self.password_set = False
            return
        log("  ③ 首次登录强制改密")
        boxes = self.page.query_selector_all('input[type="password"]')
        if len(boxes) >= 2:
            boxes[0].fill(password)
            boxes[1].fill(password)
        else:
            self.wait_input('input[name="Passwd"]').fill(password)
            self.wait_input('input[name="ConfirmPasswd"]').fill(password)
        time.sleep(1)
        self.password_attempted = True      # ★ 动过密码了：后面即使失败也要记账
        clicked = self.page.evaluate("""() => {
            const b = [...document.querySelectorAll('button,[role=button],div[role=button]')]
                .find(e => /^(下一步|Next|保存|更改密码)$/.test((e.innerText || '').trim()));
            if (b) { b.click(); return b.innerText.trim(); }
            const s = document.querySelector('input#submit, input[type=submit], button[type=submit]');
            if (s) { s.click(); return 'submit-input'; }
            return null;
        }""")
        deadline = time.time() + 45
        while time.time() < deadline:
            url, t = self.page.url, self.state()["text"]
            if "changepassword" not in url and "challenge/pwd" not in url and "确认密码" not in t:
                self.password_set = True
                log("     改密成功")
                return
            time.sleep(1)
        err = self.page.evaluate("""() => {
            const e = [...document.querySelectorAll('[role=alert],[aria-live],span,div')]
                .map(x => (x.innerText || '').trim())
                .filter(t => /密码/.test(t) && /(请|不能|无法|必须|太|相同|无效|安全|用过)/.test(t) && t.length < 120);
            return e[0] || '';
        }""")
        raise RuntimeError(f"改密没成功（提交={clicked}）" + (f" 提示：{err}" if err else ""))

    def step_bind_authenticator(self, entry: str) -> str:
        """绑身份验证器 + 开启两步验证。返回本次抓到的密钥（空串=已登记过）。"""
        log("  ④ 绑定身份验证器（密钥直接进库，不回显）")
        self.page.goto("https://myaccount.google.com/signinoptions/twosv",
                       wait_until="domcontentloaded", timeout=STEP_TIMEOUT)
        time.sleep(4)
        st = self.state()["text"]
        if "受两步验证功能的保护" in st:
            log("     两步验证已开启过 → 跳过")
            return ""
        # 已登记过验证器时按钮会变成「更改身份验证器应用」
        if ("更改身份验证器应用" in st or "添加时间" in st) and has_secret(entry):
            log("     验证器已登记过且密钥在库 → 只开开关")
            self._enable_2sv()
            return ""
        try:
            self.click_text("添加身份验证器应用", timeout=15_000)
        except TimeoutError:
            self.click_text("更改身份验证器应用", timeout=15_000)
        time.sleep(3)
        self.click_text("设置身份验证器")
        time.sleep(4)
        self.click_text("无法扫描？")
        time.sleep(2)
        secret = self.page.evaluate(READ_SECRET_JS)
        if not secret or len(secret) != 32:
            raise RuntimeError(f"没抓到合法密钥（拿到 {len(secret or '')} 位，应为 32 位）")
        try:
            base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
        except Exception as e:
            raise RuntimeError(f"抓到的不是合法 base32：{e}")
        save_secret(entry, secret)
        log(f"     密钥已入库（{len(secret)} 位，指纹 {secret[:4]}…{secret[-4:]}）")
        self.click_text("下一页")
        time.sleep(3)
        self.wait_input('input[type="text"]').fill(totp_now(secret))
        self.click_text("验证")
        time.sleep(5)
        self._enable_2sv()
        log("     两步验证已开启")
        return secret

    def _enable_2sv(self) -> None:
        """★ 「开启两步验证」按钮在 twosv 主页上，不在身份验证器子页
        （子页那个是 <a aria-label="开启">，点了只会返回上一页）。"""
        self.page.goto("https://myaccount.google.com/signinoptions/twosv",
                       wait_until="domcontentloaded", timeout=STEP_TIMEOUT)
        time.sleep(4)
        if self.wait_text("受两步验证功能的保护", timeout=8000):
            return
        try:
            self.click_aria('button[aria-label="开启两步验证"]', timeout=30_000)
            time.sleep(8)
        except Exception:
            log("     ⚠ 没找到「开启两步验证」按钮（可能已开）")
        self.page.goto("https://myaccount.google.com/signinoptions/twosv",
                       wait_until="domcontentloaded", timeout=STEP_TIMEOUT)
        time.sleep(4)
        if not self.wait_text("受两步验证功能的保护", timeout=20_000):
            raise RuntimeError("两步验证未成功开启")

    def step_bind_recovery(self, recovery: str) -> None:
        """绑辅助邮箱：安全页点行 →（可能重验密码）→ **再点一次「添加辅助邮箱」** → 填地址 →
        保存 → 从邮箱取 6 位码回填 → 验证。"""
        log(f"  ⑤ 绑定辅助邮箱 {recovery}")
        self.page.goto("https://myaccount.google.com/security", wait_until="domcontentloaded", timeout=STEP_TIMEOUT)
        time.sleep(4)
        if recovery in self.state()["text"]:
            log("     已绑定过 → 跳过")
            return
        self.click_aria('div[aria-label="添加电子邮件地址"]')
        time.sleep(5)
        if any(i["name"] == "Passwd" for i in self.state()["inputs"]):
            log("     需要重新验证身份 → 填密码")
            self.wait_input('input[name="Passwd"]').fill(self._current_password)
            self.click_text("下一步")
            time.sleep(7)
            if any(i["name"] == "Passwd" for i in self.state()["inputs"]):
                raise RuntimeError("重新验证后仍停在密码页（密码不对）")
        try:      # ★ 落到辅助邮箱页后还要再点一次，否则一直等不到输入框
            self.click_text("添加辅助邮箱", timeout=15_000)
            time.sleep(4)
        except TimeoutError:
            pass
        self.wait_input('input[type="email"]').fill(recovery)
        self.click_text("保存")
        time.sleep(6)
        code = self.mail.email_code(recovery)
        self.wait_input('input#c4').fill(code)
        time.sleep(2)
        try:
            self.click_aria('button[aria-label="验证您的辅助邮箱"]', timeout=10_000)
        except Exception:
            self.click_text("验证")
        time.sleep(6)
        self.page.goto("https://myaccount.google.com/security", wait_until="domcontentloaded", timeout=STEP_TIMEOUT)
        time.sleep(3)
        if "验证辅助邮箱" in self.state()["text"]:
            raise RuntimeError("辅助邮箱验证似未完成")

    # — AI Studio 条款门 + 导出 —
    def _ai_tos_state(self, wait_s: int = 30) -> str:
        deadline = time.time() + wait_s
        while time.time() < deadline:
            t = self.page.evaluate("() => document.body.innerText || ''")
            url = self.page.url
            if "/onboarding" in url or any(x in t for x in ("欢迎使用 AI Studio", "欢迎使用 Google AI Studio", "Welcome to Google AI Studio")):
                return "gate"
            if any(x in t for x in ("Continue to the app", "继续使用此应用")):
                return "gate"
            if "aistudio.google.com" in url and any(x in t for x in ("Playground", "New app", "Dashboard", "Build", "Get API key")):
                return "ok"
            time.sleep(1)
        return "unknown"

    def _accept_ai_studio_tos(self) -> bool:
        for attempt in range(6):
            st = self._ai_tos_state()
            if st == "ok":
                return True
            if st == "unknown":
                log("     AI Studio 页面状态未确认")
                return False
            log(f"     完成 AI Studio 首次设置（{attempt + 1}/6）")
            self.page.evaluate("""() => {
                const text = document.body.innerText || '';
                if (/18/.test(text) && /Terms|条款/.test(text)) {
                    const c = document.querySelector('input[type=checkbox], [role=checkbox]');
                    if (c && !(c.checked || c.getAttribute('aria-checked') === 'true')) c.click();
                }
            }""")
            time.sleep(1)
            self.page.evaluate("""() => {
                const buttons = [...document.querySelectorAll('button,[role=button],a')];
                const b = buttons.find(e => ['跳过','Skip'].includes((e.innerText || '').trim())) ||
                    buttons.find(e => ['继续','Continue'].some(t => (e.innerText || '').trim().startsWith(t)));
                if (b && !b.disabled) b.click();
            }""")
            time.sleep(4)
        return False
    def step_export_cookies(self, account: str) -> Path:
        """导出登录态。★ 必须先访问 AI Studio（否则 localStorage/origins 是空的），
        并顺手过掉条款门（同意状态记在账号上，不点的话拿去反代照样卡欢迎页）。"""
        log("  ⑥⑦ 导出登录态（先进 AI Studio 过条款门，再把 localStorage 一起带走）")
        try:
            self.page.goto(AI_STUDIO_URL, wait_until="domcontentloaded", timeout=90_000)
            time.sleep(4)
            self.ai_tos_ok = self._accept_ai_studio_tos()
        except Exception as e:
            log(f"     ⚠ AI Studio 预访问失败（继续导出）：{type(e).__name__}: {e}")
        out = CONFIG["cookies_dir_path"]
        out.mkdir(parents=True, exist_ok=True)
        raw = self.ctx.storage_state()
        shaped = {"cookies": raw.get("cookies", []), "origins": raw.get("origins", []),
                  "accountName": account, "savedAt": datetime.now(timezone.utc).isoformat()}
        p = out / f"{account.replace('@', '_at_')}.json"
        p.write_text(json.dumps(shaped, ensure_ascii=False, indent=2), encoding="utf-8")
        names = {c.get("name") for c in shaped["cookies"]}
        key = [k for k in ("SID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID") if k in names]
        log(f"     已导出 {len(shaped['cookies'])} cookie + {len(shaped['origins'])} origin"
            f"（关键命中 {len(key)}/4）→ {p}")
        return p


# ───────────────────────── 跑一个号 ─────────────────────────

def run_one(mail_item: dict, presets: dict, run_dir: Path) -> dict:
    mailbox = mail_item["mailbox"]
    alias = mail_item["alias"]
    preset_pw, preset_rec = presets.get(alias, ["", ""])
    if not preset_rec and mail_item.get("account_hint"):
        preset_pw, preset_rec = presets.get(mail_item["account_hint"], [preset_pw, preset_rec])
    password = preset_pw or pwgen()
    recovery = preset_rec or CONFIG["recovery_email"]

    profile_dir = CONFIG["profiles_dir_path"] / re.sub(r"[^A-Za-z0-9_.-]", "_", alias)
    profile_dir.mkdir(parents=True, exist_ok=True)
    result = {"alias": alias, "ok": False}

    with Camoufox(headless=CONFIG["headless"], persistent_context=True,
                  user_data_dir=str(profile_dir), os="windows", humanize=True,
                  i_know_what_im_doing=True, block_webrtc=True,
                  window=(1600, 900),
                  screen=Screen(min_width=SCREEN_W, max_width=SCREEN_W,
                                min_height=SCREEN_H, max_height=SCREEN_H),
                  config={"screen.width": SCREEN_W, "screen.height": SCREEN_H}) as ctx:
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        flow = Flow(page, ctx, run_dir, mailbox, CONFIG)
        flow._current_password = password
        account = None
        pw_known = False
        try:
            log(f"— 处理 {alias}")
            flow.step_login_by_link(mail_item["link"])
            flow.step_accept_tos()
            flow.step_set_password(password)

            account = flow.account_email()
            if account == "unknown":
                account = None      # ★ 必须清掉，否则下面会把 "unknown" 当台账主键
                raise RuntimeError("读不到账号邮箱（会话可能已掉）")
            result["account"] = account
            log(f"  账号确认：{account}")

            if flow.password_set:
                pw_known = True
            # ★ 动过密码就立刻落盘：哪怕后面全挂，这个号也不会变成"没人知道密码"
            if pw_known or flow.password_attempted:
                upsert_ledger(account, password,
                              ("改密完成" if flow.password_set else "改密未确认（密码可能已生效）"),
                              status="PARTIAL" if flow.password_set else "PARTIAL-改密未确认")

            secret = flow.step_bind_authenticator(account)
            flow.step_bind_recovery(recovery)
            cookie_path = flow.step_export_cookies(account)
            status = "OK" if pw_known else "OK-密码未知"
            if flow.ai_tos_ok is False:
                status += "+AI条款门未过"
            upsert_ledger(account, password if pw_known else "-（未知，见 cookie）",
                          f"2FA({'新登记' if secret else '已有'})+辅助邮箱{recovery}",
                          extra=str(cookie_path), status=status)
            result.update(ok=True, account=account, cookies=str(cookie_path))
        except Exception as e:
            shot = flow.shot("fail")
            log(f"  ✗ 失败：{type(e).__name__}: {e}")
            log(f"    截图：{shot}")
            key = account or flow.known_email
            if not key and (flow.password_attempted or pw_known):
                key = f"（账号待确认）{alias}"     # ★ 拿不到邮箱也要留痕，别让号静静消失
            if key:
                unconfirmed = bool(flow.password_attempted) and not flow.password_set
                upsert_ledger(key, password if (pw_known or flow.password_attempted) else "-（未知）",
                              f"失败于：{str(e)[:110]}" + ("（改密未确认）" if unconfirmed else ""),
                              extra=str(shot),
                              status="PARTIAL-改密未确认" if unconfirmed else "PARTIAL")
            result["error"] = f"{type(e).__name__}: {e}"
            result["shot"] = str(shot)
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="Google Workspace 账号自动激活（邮箱一次性链接）")
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--limit", type=int, default=0, help="最多处理几个（0=不限）")
    ap.add_argument("--dry-run", action="store_true", help="只列出待处理链接，不操作")
    args = ap.parse_args()

    global CONFIG
    CONFIG = load_config((HERE / args.config) if not Path(args.config).is_absolute() else Path(args.config))
    from mailbox import Mailbox      # noqa: E402  （延迟导入，--dry-run 也要能用）

    box = Mailbox(CONFIG)
    todo = box.new_account_links()
    log(f"收件箱里发现 {len(todo)} 个待激活的新号链接")
    for t in todo:
        log(f"   {t['time']}  {t['alias']}")
    if args.dry_run or not todo:
        return 0
    if args.limit:
        todo = todo[:args.limit]

    acquire_lock()
    run_dir = CONFIG["output_dir_path"] / "runs" / datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir.mkdir(parents=True, exist_ok=True)
    global LOG_FILE
    LOG_FILE = open(run_dir / "run.log", "a", encoding="utf-8")
    log(f"本次运行目录：{run_dir}")
    presets = load_presets()
    results = []
    try:
        for item in todo:
            results.append(run_one(item, presets, run_dir))
            state_f = HERE / "state.json"
            done = json.loads(state_f.read_text(encoding="utf-8")) if state_f.exists() else {}
            if results[-1].get("ok"):
                done.setdefault("done_mail_ids", []).append(item["mail_id"])
                state_f.write_text(json.dumps(done, ensure_ascii=False, indent=2), encoding="utf-8")
    finally:
        release_lock()
    ok = [r for r in results if r.get("ok")]
    log(f"完成：成功 {len(ok)} / 失败 {len(results) - len(ok)}")
    (run_dir / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"结果明细：{run_dir / 'results.json'}")
    if LOG_FILE is not None:
        LOG_FILE.close()
    return 0 if not results or ok else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        release_lock()
        raise
