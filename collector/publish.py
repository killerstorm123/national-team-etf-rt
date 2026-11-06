"""把 web/ 与最新 JSON 同步到 docs/ 并推送到 GitHub Pages。

用法：
  python3 collector/publish.py                 # 同步 + 提交 + 推送
  python3 collector/publish.py --sync-only     # 只同步 docs/，不碰 git

仓库准备（只需一次）：
  git init && git add . && git commit -m "init"
  git remote add origin git@github.com:<you>/national-team-etf-rt.git
  仓库 Settings → Pages → Source: main /docs
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
DATA = ROOT / "data"
DOCS = ROOT / "docs"
TZ = ZoneInfo("Asia/Shanghai")
WEB_FILES = ["index.html", "app.js", "echarts.min.js"]
DATA_FILES = ["rt.json", "hist.json"]


def _run(args: list[str], cwd: Path = ROOT) -> subprocess.CompletedProcess:
    return subprocess.run(args, cwd=str(cwd), capture_output=True, text=True)


def sync() -> None:
    DOCS.mkdir(exist_ok=True)
    (DOCS / "data").mkdir(exist_ok=True)
    for name in WEB_FILES:
        src = WEB / name
        if src.exists():
            shutil.copyfile(src, DOCS / name)
    for name in DATA_FILES:
        src = DATA / name
        if src.exists():
            shutil.copyfile(src, DOCS / "data" / name)


def _is_repo() -> bool:
    return (ROOT / ".git").exists()


def publish(quiet: bool = False) -> bool:
    sync()
    if not _is_repo():
        msg = "[publish] 项目还不是 git 仓库，docs/ 已同步；按 README 初始化并添加 remote 后再推"
        if not quiet:
            print(msg)
        return False

    paths = ["docs"]
    _run(["git", "add", "--"] + paths)
    status = _run(["git", "status", "--porcelain", "--"] + paths)
    if not (status.stdout or "").strip():
        if not quiet:
            print("[publish] 无变更")
        return True

    stamp = datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S")
    commit = _run(["git", "commit", "-m", f"data: 看板快照 {stamp}", "--"] + paths)
    if commit.returncode != 0:
        print(f"[publish] commit 失败：{commit.stderr.strip()}", file=sys.stderr)
        return False

    for attempt in range(4):
        push = _run(["git", "push", "origin", "HEAD"])
        if push.returncode == 0:
            local = _run(["git", "rev-parse", "HEAD"]).stdout.strip()
            remote = _run(["git", "rev-parse", "origin/HEAD"]).stdout.strip()
            ok = bool(local)
            if not quiet:
                print(f"[publish] 已推送 {local[:8]}（远端 {remote[:8] or '未知'}）")
            return ok
        print(f"[publish] push 重试 {attempt + 1}/4：{push.stderr.strip()[:160]}", file=sys.stderr)
        time.sleep(2 + attempt * 2)
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sync-only", action="store_true")
    args = ap.parse_args()
    if args.sync_only:
        sync()
        print(f"[publish] docs/ 已同步（{len(WEB_FILES)} 个页面文件 + {len(DATA_FILES)} 个数据文件）")
        return 0
    return 0 if publish() else 1


if __name__ == "__main__":
    raise SystemExit(main())
