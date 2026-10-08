# -*- coding: utf-8 -*-
"""单独把某个浏览器身份的登录态导出来（反代形状）。

    python export_cookies.py --profile <身份目录名> --name <accountName>
                            [--out 文件] [--headful] [--no-accept-tos]

为什么导出前要「先访问 AI Studio + 过条款门」：
    * 只导出 cookie 不带 localStorage 的话，反代打开 AI Studio 时缺偏好项；
    * 首次访问会弹「欢迎使用 AI Studio」条款门（18+ 复选框 + 继续），
      **同意状态记在账号上** —— 不点的话导出的 cookie 拿去反代照样卡在欢迎页。

注意：同一个身份目录不能被两个浏览器实例同时打开 → 导出前先关掉窗口。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from camoufox.fingerprints import Screen
from camoufox.sync_api import Camoufox

import register as R      # 复用主程序的 Flow（AI Studio 条款门逻辑在里面）

KEY_COOKIES = ("SID", "HSID", "SSID", "SAPISID", "APISID", "__Secure-1PSID", "__Secure-3PSID")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", required=True, help="profiles 目录下的身份名")
    ap.add_argument("--name", default=None, help="写进 accountName（默认=身份名）")
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--out", default=None)
    ap.add_argument("--headful", action="store_true")
    ap.add_argument("--no-accept-tos", action="store_true")
    a = ap.parse_args()

    R.CONFIG = R.load_config((R.HERE / a.config) if not Path(a.config).is_absolute() else Path(a.config))
    profile_dir = R.CONFIG["profiles_dir_path"] / a.profile
    if not profile_dir.exists():
        sys.exit(f"没有这个身份目录：{profile_dir}")

    with Camoufox(headless=not a.headful, persistent_context=True,
                  user_data_dir=str(profile_dir), os="windows", humanize=True,
                  i_know_what_im_doing=True, block_webrtc=True,
                  window=(1600, 900),
                  screen=Screen(min_width=1920, max_width=1920, min_height=1080, max_height=1080)) as ctx:
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        if not a.no_accept_tos:
            print("  先访问 AI Studio 并处理条款门 …")
            try:
                page.goto(R.AI_STUDIO_URL, wait_until="domcontentloaded", timeout=90_000)
                time.sleep(4)
                flow = R.Flow(page, ctx, R.CONFIG["output_dir_path"], None, R.CONFIG)
                ok = flow._accept_ai_studio_tos()
                print(f"  AI Studio 条款门：{'已过/无需' if ok else '⚠ 未确认（脚本仍会导出，但反代可能用不了）'}")
            except Exception as e:
                print(f"  ⚠ 预访问失败（继续导出）：{type(e).__name__}: {e}")
        raw = ctx.storage_state()

    cookies = raw.get("cookies", [])
    name = a.name or a.profile
    shaped = {"cookies": cookies, "origins": raw.get("origins", []),
              "accountName": name, "savedAt": datetime.now(timezone.utc).isoformat()}
    dest = Path(a.out) if a.out else (R.CONFIG["cookies_dir_path"] / f"{name.replace('@', '_at_')}.json")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(shaped, ensure_ascii=False, indent=2), encoding="utf-8")
    domains = Counter(c.get("domain", "?") for c in cookies)
    got = [k for k in KEY_COOKIES if any(c.get("name") == k for c in cookies)]
    print(f"[OK] 已导出 {len(cookies)} 个 cookie + {len(shaped['origins'])} 个 origin → {dest}")
    print(f"     关键 cookie 命中：{', '.join(got) if got else '（一个都没命中 → 多半没登录）'}")
    print("     域名分布：" + "、".join(f"{d}×{n}" for d, n in domains.most_common(6)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
