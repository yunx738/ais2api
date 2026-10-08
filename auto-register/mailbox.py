# -*- coding: utf-8 -*-
"""邮箱侧：用 Microsoft Graph + 设备码授权收信 —— 取「新账号登录链接」和「验证码」。

为什么用 Graph 设备码而不是 IMAP：
    很多免费邮箱（含 Outlook）已关闭 IMAP 的基础认证，直连 993 端口会被拒；
    设备码授权只要浏览器里点一次，之后靠 refresh_token 长期续期。

首次使用（同目录下会生成 mailbox-token.json）：
    python mailbox.py --login        # 打印一个码 + 网址，去浏览器输一次即可
之后 register.py 会自动复用/续期 token。

★ 单实例限制：refresh_token 每次刷新都会滚动，两个进程同时用会互相顶掉 →
   跑批时请只开一个进程（register.py 里有按 PID 的锁）。

依赖：只用标准库（urllib）。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOKEN_FILE = HERE / "mailbox-token.json"

# 设备码流需要一个「公共客户端 ID」（= 你在 Azure 注册的应用的 Application ID）。
#
# 自己注册一个（免费，两分钟）：
#   1. portal.azure.com → 搜「应用注册」→ 新注册
#   2. 名称随便填；「受支持的帐户类型」选「仅个人 Microsoft 帐户」
#   3. 注册完复制「应用程序(客户端) ID」→ 填进 config.json 的 graph_client_id
#   4. 进「身份验证」→ 页面底部「允许公共客户端流」设为「是」→ 保存
#
# 为什么不写死一个现成的 ID：设备码授权是给「你的应用」签发的，
# 用别人代码里抄来的 ID，你既控制不了授权范围，也可能哪天被作者改配置直接失效。
PUBLIC_CLIENT_ID = ""      # ← 留空：强制走 config.json 的 graph_client_id（见上）
SCOPE = "offline_access https://graph.microsoft.com/Mail.Read"
AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0"


def _post(url: str, data: dict) -> dict:
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def _get(url: str, token: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}",
                                               "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


class Mailbox:
    def __init__(self, config: dict):
        self.cfg = config
        self.client_id = config.get("graph_client_id") or PUBLIC_CLIENT_ID
        if not self.client_id:
            raise SystemExit(
                "还没配置 graph_client_id —— 设备码授权需要你自己的 Azure 应用 ID。\n"
                "  README「三、配置」里有 4 步注册流程；拿到 Application (client) ID 后\n"
                "  填进 config.json 的同名字段即可。")
        # token 位置：默认放本目录；也可以用 config 里的 mailbox_token 指到别处
        # （例如你在别处已经授权过，直接复用，不必把 token 拷进这个目录）
        tok = config.get("mailbox_token")
        if tok:
            p = Path(tok)
            self.token_file = p if p.is_absolute() else (HERE / p)
        else:
            self.token_file = TOKEN_FILE
        self._token = None
        self._token_exp = 0

    # ── 授权 ──
    def login(self) -> None:
        """设备码授权（人工一次）。"""
        dc = _post(f"{AUTHORITY}/devicecode",
                   {"client_id": self.client_id, "scope": SCOPE})
        print("\n" + "=" * 60)
        print(f"请在浏览器打开：{dc['verification_uri']}")
        print(f"并输入代码：{dc['user_code']}")
        print("=" * 60 + "\n")
        interval = int(dc.get("interval", 5))
        deadline = time.time() + int(dc.get("expires_in", 900))
        while time.time() < deadline:
            time.sleep(interval)
            try:
                tok = _post(f"{AUTHORITY}/token", {
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                    "client_id": self.client_id, "device_code": dc["device_code"]})
            except urllib.error.HTTPError as e:
                err = json.loads(e.read().decode()).get("error", "")
                if err in ("authorization_pending", "slow_down"):
                    continue
                raise SystemExit(f"授权失败：{err}")
            self._save(tok)
            print("[OK] 授权成功，refresh_token 已保存到", self.token_file)
            return
        raise SystemExit("超时未完成授权")

    def _save(self, tok: dict) -> None:
        old = json.loads(self.token_file.read_text(encoding="utf-8")) if self.token_file.exists() else {}
        old.update({"refresh_token": tok.get("refresh_token", old.get("refresh_token")),
                    "access_token": tok.get("access_token"),
                    "expires_at": time.time() + int(tok.get("expires_in", 3600)) - 60,
                    "saved_at": datetime.now().isoformat(timespec="seconds")})
        self.token_file.write_text(json.dumps(old, ensure_ascii=False, indent=2), encoding="utf-8")

    def token(self) -> str:
        """取可用的 access token（过期就用 refresh_token 续期并原子写回）。"""
        if self._token and time.time() < self._token_exp:
            return self._token
        if not self.token_file.exists():
            raise SystemExit("还没授权过，先跑：python mailbox.py --login")
        tok = json.loads(self.token_file.read_text(encoding="utf-8"))
        if tok.get("access_token") and time.time() < tok.get("expires_at", 0):
            self._token, self._token_exp = tok["access_token"], tok["expires_at"]
            return self._token
        new = _post(f"{AUTHORITY}/token", {"grant_type": "refresh_token",
                                          "client_id": self.client_id,
                                          "refresh_token": tok["refresh_token"],
                                          "scope": SCOPE})
        self._save(new)
        self._token = new["access_token"]
        self._token_exp = time.time() + int(new.get("expires_in", 3600)) - 60
        return self._token

    # ── 收信 ──
    def fetch(self, top: int = 25) -> list:
        """取收件箱最近 top 封（★ 注意 $orderby 里的空格必须转义成 %20，
        否则 Graph 直接报 URL 含控制字符；/me 也可能 401，所以直接查邮件夹）。"""
        url = ("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages"
               f"?$top={top}&$orderby=receivedDateTime%20desc"
               "&$select=id,subject,receivedDateTime,bodyPreview,toRecipients,body")
        return _get(url, self.token()).get("value", [])

    @staticmethod
    def tos_of(msg: dict) -> str:
        return " ".join((r.get("emailAddress", {}).get("address", "")
                         for r in msg.get("toRecipients", [])))

    @staticmethod
    def fmt_time(iso: str) -> str:
        try:
            dt = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone()
            return dt.strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            return iso

    @staticmethod
    def extract_code(text: str) -> str:
        """抓 6 位验证码。

        ★ 正则要避开「邮箱别名里的数字」（例如 user+tag20250701@x.com 里的 20250701
          会被误当成验证码）—— 所以要求 6 位数字周围不是字母/数字。
        """
        m = re.search(r"(?<![A-Za-z0-9])(\d{6})(?![A-Za-z0-9])", text)
        return m.group(1) if m else ""

    # ── 业务 ──
    def new_account_links(self) -> list:
        """收件箱里所有「新账号登录链接」：主题命中关键词、正文里有 RP 一次性链接。"""
        state_f = HERE / "state.json"
        done = set()
        if state_f.exists():
            state = json.loads(state_f.read_text(encoding="utf-8"))
            if str(self.cfg.get("mailbox", "")).lower() in {x.lower() for x in state.get("ignored_mailboxes", [])}:
                return []
            done = set(map(str, state.get("done_mail_ids", []) + state.get("ignored_mail_ids", [])))
        keys = self.cfg.get("mail_subject_keywords", ["新的 Google"])
        out = []
        for msg in self.fetch(top=30):
            if str(msg["id"]) in done:
                continue
            subject = msg.get("subject", "")
            if keys and not any(k in subject for k in keys):
                continue
            body = (msg.get("body", {}).get("content") or msg.get("bodyPreview") or "")
            links = re.findall(r"https://accounts\.google\.com/RP\?[^\s\"'<>)\]]+", body)
            if not links:
                continue
            out.append({"mail_id": msg["id"], "subject": subject,
                        "time": self.fmt_time(msg["receivedDateTime"]),
                        "alias": self.tos_of(msg), "link": links[0],
                        "account_hint": ""})
        return out

    def email_code(self, target: str, since_minutes: int = 10, timeout: int = 150) -> str:
        """等一封发往 target 的验证码（不打印明文）。"""
        since = datetime.now(timezone.utc) - timedelta(minutes=since_minutes)
        deadline = time.time() + timeout
        while time.time() < deadline:
            for msg in self.fetch(top=15):
                recv = datetime.fromisoformat(msg["receivedDateTime"].replace("Z", "+00:00"))
                if recv < since or target.lower() not in self.tos_of(msg).lower():
                    continue
                body = msg.get("body", {}).get("content") or msg.get("bodyPreview") or ""
                code = self.extract_code(f"{msg.get('subject', '')} {body}")
                if code:
                    return code
            time.sleep(2)
        raise TimeoutError(f"{timeout}s 内没等到 {target} 的验证码")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--login", action="store_true")
    ap.add_argument("--list", action="store_true", help="列出待激活的新号链接")
    a = ap.parse_args()
    cfg = {"mail_subject_keywords": ["新的 Google", "Google 帐号"]}
    box = Mailbox(cfg)
    if a.login:
        box.login()
        return 0
    if a.list:
        for t in box.new_account_links():
            print(f"  {t['time']}  {t['alias']}")
        return 0
    ap.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
