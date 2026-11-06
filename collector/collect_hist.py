"""收盘后：15 日 5 分钟聚合 → data/hist.json + 当日分钟明细归档。

用法：python3 collector/collect_hist.py [--days 15]
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sources  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
POOL_PATH = ROOT / "config" / "pool.json"
DATA_DIR = ROOT / "data"
HIST_PATH = DATA_DIR / "hist.json"
RT_PATH = DATA_DIR / "rt.json"
ARCHIVE_DIR = DATA_DIR / "archive"
TZ = ZoneInfo("Asia/Shanghai")


def sort_key(t: str) -> int:
    """把 09:35…15:00 映射成连续序号，午休不计。"""
    m = int(t[:2]) * 60 + int(t[3:5])
    return m if m <= 690 else m + 240   # 11:30 之后整体后移，避免午休留空


def collect(days: int = 15, quiet: bool = False) -> dict:
    pool = json.loads(POOL_PATH.read_text(encoding="utf-8"))
    groups = pool["groups"]
    all_etfs = [s for g in groups for s in g["etfs"]]

    raw: dict[str, dict[str, dict[str, float]]] = {}   # secid → day → t → 额(亿)
    degraded: list[str] = []
    for start in range(0, len(all_etfs), sources.EM_BATCH):
        for secid in all_etfs[start : start + sources.EM_BATCH]:
            try:
                rows = sources.fetch_em(secid, 5, 800)[1]
            except Exception:
                degraded.append(secid)
                continue
            by_day: dict[str, dict[str, float]] = {}
            for r in rows:
                by_day.setdefault(r["day"], {})[r["t"]] = r["amount"] / sources.YI
            raw[secid] = by_day
        if start + sources.EM_BATCH < len(all_etfs):
            time.sleep(sources.EM_GAP)

    if not raw:
        raise RuntimeError("东财 5 分钟数据全失败")

    try:
        index_rows = sources.fetch_em(pool["index"]["secid"], 5, 800)[1]
    except Exception:
        index_rows = []
    index_by_day: dict[str, dict[str, float]] = {}
    for r in index_rows:
        index_by_day.setdefault(r["day"], {})[r["t"]] = r["close"]

    day_set = sorted({d for by_day in raw.values() for d in by_day})[-days:]
    labels = sorted({t for by_day in raw.values() for d in day_set for t in by_day.get(d, {})}, key=sort_key)

    total5: list[list[float]] = []
    fam5: dict[str, list[list[float]]] = {g["name"]: [] for g in groups}
    daily_total: list[float] = []
    for d in day_set:
        row_total = []
        for t in labels:
            row_total.append(round(sum(by_day.get(d, {}).get(t, 0.0) for by_day in raw.values()), 4))
        total5.append(row_total)
        daily_total.append(round(sum(row_total), 2))
        for g in groups:
            fam_row = []
            for t in labels:
                fam_row.append(round(sum(raw[s].get(d, {}).get(t, 0.0) for s in g["etfs"] if s in raw), 4))
            fam5[g["name"]].append(fam_row)

    payload = {
        "schema": 1,
        "updated": datetime.now(TZ).isoformat(timespec="seconds"),
        "granularity": 5,
        "days": day_set,
        "bars": labels,
        "total5": total5,
        "fam5": fam5,
        "index5": [[round(index_by_day.get(d, {}).get(t, 0.0), 3) for t in labels] for d in day_set],
        "dailyTotal": daily_total,
        "degraded": degraded,
        "approx": False,
    }
    DATA_DIR.mkdir(exist_ok=True)
    tmp = HIST_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, HIST_PATH)

    archive_today()
    if not quiet:
        print(f"[hist] {len(day_set)} 日 × {len(labels)} 根，缺测 {len(degraded)} 只，"
              f"最新日合计 {daily_total[-1]:.1f} 亿")
    return payload


def archive_today() -> None:
    if not RT_PATH.exists():
        return
    try:
        rt = json.loads(RT_PATH.read_text(encoding="utf-8"))
        day = rt.get("date")
        if not day:
            return
        ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(RT_PATH, ARCHIVE_DIR / f"{day}.json")
    except Exception as exc:
        print(f"[hist] 归档失败：{exc}", file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=15)
    args = ap.parse_args()
    collect(args.days)
    return 0


if __name__ == "__main__":
    sys.exit(main())
