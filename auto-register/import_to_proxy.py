# -*- coding: utf-8 -*-
"""把登录态导入 AIStudioToAPI（Docker 版）—— 拷 auth-N.json + 重启 + 校验。

用法：
    python import_to_proxy.py --dry-run      # 只看哪些号没导入，不动任何东西
    python import_to_proxy.py                # 拷贝 → 重启容器 → 校验 N valid sources
    python import_to_proxy.py --no-restart   # 只拷文件（重启你自己来）

为什么要重启：
    这个服务**没有文件监听**（源码里没有 fs.watch）。auth 扫描只在
    ① 进程启动 ② 界面里「保存会话」之后 ③ 某些控制台接口被请求时发生。
    所以拷完文件最省事的生效办法就是 docker restart（auth/ 与 data/ 是挂载的，不丢号）。

导入记录写在 output/imported.json，重复运行不会重复导入同一个号。
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import register as R


def proxy_accounts(auth_dir: Path) -> dict:
    """读反代 auth 目录：{accountName: 文件名}。"""
    out = {}
    for f in sorted(auth_dir.glob("auth-*.json")):
        try:
            j = json.loads(f.read_text(encoding="utf-8"))
            name = j.get("accountName") or f.stem
            out[name] = f.name
        except Exception:
            pass
    return out


def next_index(auth_dir: Path) -> int:
    used = []
    for f in auth_dir.glob("auth-*.json"):
        m = re.search(r"auth-(\d+)\.json$", f.name)
        if m:
            used.append(int(m.group(1)))
    return max(used) + 1 if used else 0


def docker(args: list, timeout: int = 120) -> str:
    try:
        r = subprocess.run(["docker"] + args, capture_output=True, text=True, timeout=timeout)
        return (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return f"[docker 调用失败] {e}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-restart", action="store_true")
    a = ap.parse_args()

    cp = Path(a.config)
    R.CONFIG = R.load_config(cp if cp.is_absolute() else (R.HERE / cp))
    auth_dir = Path(R.CONFIG.get("proxy_auth_dir", ""))
    container = R.CONFIG.get("proxy_container", "")
    if not auth_dir or not Path(auth_dir).exists():
        sys.exit("config.json 里的 proxy_auth_dir 没填或不存在（应是容器挂载出来的 auth 目录）")

    have = proxy_accounts(auth_dir)
    rec_f = R.CONFIG["output_dir_path"] / "imported.json"
    rec = json.loads(rec_f.read_text(encoding="utf-8")) if rec_f.exists() else {}

    todo = []
    for f in sorted(R.CONFIG["cookies_dir_path"].glob("*.json")):
        j = json.loads(f.read_text(encoding="utf-8"))
        name = j.get("accountName") or f.stem
        if name in have:
            continue
        todo.append((name, f))

    print(f"反代现有 {len(have)} 个号；本次要导入 {len(todo)} 个")
    for name, _ in todo:
        print(f"   + {name}")
    if a.dry_run:
        print("\n（--dry-run：什么都没动）")
        return 0
    if not todo:
        return 0

    auth_dir.mkdir(parents=True, exist_ok=True)
    idx = next_index(auth_dir)
    for name, src in todo:
        dst = auth_dir / f"auth-{idx}.json"
        shutil.copyfile(src, dst)
        print(f"   导入 {name} → {dst.name}")
        rec[name] = {"index": idx, "file": dst.name,
                     "imported_at": datetime.now().isoformat(timespec="seconds")}
        idx += 1
    rec_f.parent.mkdir(parents=True, exist_ok=True)
    rec_f.write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")

    if a.no_restart:
        print("\n已拷贝（没重启）。重启后才会生效：docker restart " + (container or "<容器名>"))
        return 0

    print(f"\n重启容器 {container} 让它重扫 …")
    out = docker(["restart", container], timeout=180)
    if "[docker 调用失败]" in out:
        print(out)
        return 1
    time.sleep(14)
    logs = docker(["logs", "--since", "2m", container], timeout=120)
    hits = [l for l in logs.splitlines() if "valid sources" in l]
    for l in hits[-3:]:
        print("   " + l.strip())
    if hits:
        m = re.search(r"(\d+) valid sources", hits[-1])
        if m:
            print(f"\n[OK] 反代现在有 {m.group(1)} 个有效源"
                  f"（预期 {len(have) + len(todo)}）")
    else:
        print("\n⚠ 日志里没看到 'valid sources' 行，请手动确认："
              f"docker logs --since 2m {container} | findstr source")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
