# -*- coding: utf-8 -*-
"""独立 TOTP（RFC 6238）验证码器 —— 不依赖任何第三方库。

    python totp.py --selftest          # 用 RFC 6238 官方向量自检
    python totp.py --list              # 列出密钥库里的条目（只显示指纹）
    python totp.py <条目名>            # 出 6 位码（带剩余秒数）

密钥库 secrets.json 的形状：
    {"条目名": {"label": "...", "secret": "<32位base32>", "digits": 6, "period": 30, "algo": "sha1"}}
★ 这个文件等于所有账号的二步验证钥匙，务必 gitignore + 限制权限（见 README）。
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import struct
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_STORE = HERE / "secrets.json"


def code_for(secret: str, digits: int = 6, period: int = 30, algo: str = "sha1") -> str:
    s = secret.replace(" ", "").upper()
    key = base64.b32decode(s + "=" * (-len(s) % 8), casefold=True)
    counter = int(time.time()) // period
    digest = {"sha1": hashlib.sha1, "sha256": hashlib.sha256, "sha512": hashlib.sha512}[algo]
    d = hmac.new(key, struct.pack(">Q", counter), digest).digest()
    o = d[-1] & 0x0F
    return str((struct.unpack(">I", d[o:o + 4])[0] & 0x7FFFFFFF) % 10 ** digits).zfill(digits)


def selftest() -> int:
    """RFC 6238 附录 B 官方向量（T=59 / 1111111109 / 1111111111 / 1234567890 / 2000000000）。"""
    secret = base64.b32encode(b"12345678901234567890").decode()
    vectors = [(59, "94287082"), (1111111109, "07081804"), (1111111111, "14050471"),
               (1234567890, "89005924"), (2000000000, "69279037")]
    ok = 0
    for ts, expect in vectors:
        counter = ts // 30
        key = base64.b32decode(secret)
        d = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
        o = d[-1] & 0x0F
        got = str((struct.unpack(">I", d[o:o + 4])[0] & 0x7FFFFFFF) % 10 ** 8).zfill(8)
        flag = "✓" if got == expect else "✗"
        print(f"  T={ts:<12} 期望 {expect}  得到 {got}  {flag}")
        ok += got == expect
    print(f"  {ok}/{len(vectors)} 通过")
    return 0 if ok == len(vectors) else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("entry", nargs="?", help="条目名（账号邮箱）")
    ap.add_argument("--store", default=str(DEFAULT_STORE))
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    store_p = Path(a.store)
    if not store_p.exists():
        sys.exit(f"没有密钥库：{store_p}")
    store = json.loads(store_p.read_text(encoding="utf-8"))
    if a.list or not a.entry:
        for k, v in store.items():
            s = v.get("secret", "")
            print(f"  {k:34s} {len(s)}位  指纹 {s[:4]}…{s[-4:]}")
        return 0
    if a.entry not in store:
        sys.exit(f"库里没有条目：{a.entry}（用 --list 看有哪些）")
    v = store[a.entry]
    c = code_for(v["secret"], v.get("digits", 6), v.get("period", 30), v.get("algo", "sha1"))
    left = v.get("period", 30) - int(time.time()) % v.get("period", 30)
    print(f"{c}   （{left}s 后失效）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
