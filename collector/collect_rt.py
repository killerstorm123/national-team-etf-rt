"""盘中分钟成交额采集：东财主源 / 腾讯备源 → data/rt.json（60s 一轮）。

用法：
  python3 collector/collect_rt.py --once              # 跑一轮写盘后退出
  python3 collector/collect_rt.py --loop              # 盘中常驻，60s 一轮
  python3 collector/collect_rt.py --loop --publish-every 300
  python3 collector/collect_rt.py --once --force-source tx
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import date, datetime, time as dtime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sources  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
POOL_PATH = ROOT / "config" / "pool.json"
DATA_DIR = ROOT / "data"
RT_PATH = DATA_DIR / "rt.json"
TZ = ZoneInfo("Asia/Shanghai")
MIN_OK_RATIO = 0.7
FULL_LMT, INC_LMT = 300, 6


def now_bj() -> datetime:
    return datetime.now(TZ)


def load_pool() -> dict:
    return json.loads(POOL_PATH.read_text(encoding="utf-8"))


POOL = load_pool()
ALL_ETFS: list[str] = [s for g in POOL["groups"] for s in g["etfs"]]
INDEX = POOL["index"]["secid"]


class LiveState:
    def __init__(self) -> None:
        self.date = ""
        self.minutes: list[str] = []
        self.idx_price: list[float] = []
        self.etf: dict[str, dict[str, float]] = {}
        self.names: dict[str, str] = {}
        self.source = "em"
        self.yest_total: float | None = None
        self.pre_close: float | None = None
        self.meta_for = ""
        self.last_written: str = ""

    def reset_if_new_date(self, day: str) -> None:
        if day != self.date:
            self.date = day
            self.minutes = []
            self.idx_price = []
            self.etf = {}
            self.meta_for = ""
            self.yest_total = None
            self.pre_close = None


STATE = LiveState()
SOURCE = sources.SourceState()


def is_trading_now(dt: datetime | None = None) -> bool:
    """09:15–11:35 / 12:55–15:05（留 5 分钟宽限，与页面判定同一口径）。"""
    dt = dt or now_bj()
    m = dt.hour * 60 + dt.minute
    return (555 <= m <= 695) or (775 <= m <= 905)


def phase_now(day: str, dt: datetime | None = None) -> str:
    dt = dt or now_bj()
    if day and day != dt.date().isoformat():
        return "closed" if day < dt.date().isoformat() else "preopen"
    if not is_trading_now(dt):
        if dt.time() > dtime(15, 5):
            return "closed"
        if dt.time() < dtime(9, 15):
            return "preopen"
        return "closed"
    return "intraday"


# ───────────────────────── 取数一轮 ─────────────────────────

def fetch_round(incremental: bool, force_source: str | None) -> dict:
    lmt = INC_LMT if incremental else FULL_LMT
    if force_source == "tx":
        return {"source": "tx_fallback", "cached_em_bad": False, "idx": [], "etf": {}, "names": {}}
    if force_source != "em" and SOURCE.cooling():
        return {"source": "tx_fallback", "cached_em_bad": False, "idx": [], "etf": {}, "names": {}}

    alive, idx_rows = sources.probe_em(lmt)
    if alive:
        etf_rows, names = sources.fetch_many_em(ALL_ETFS, 1, lmt)
        if etf_rows.get("__ok", 0) >= len(ALL_ETFS) * MIN_OK_RATIO:
            SOURCE.mark_em_ok()
            return {"source": "em", "idx": idx_rows, "etf": etf_rows, "names": names,
                    "ok": etf_rows["__ok"], "cached_em_bad": False}
    # 指数活但批量不足，或探测失败：本轮改走腾讯，并进入 5 分钟冷却
    SOURCE.mark_em_bad()
    return {"source": "tx_fallback", "cached_em_bad": True,
            "idx": idx_rows if alive else [], "etf": {}, "names": {}}


def fetch_tx_round() -> dict:
    name_idx, idx_rows = sources.fetch_tx_minute(INDEX)
    etf_rows = sources.fetch_many_tx(ALL_ETFS)
    names = {}
    for secid in ALL_ETFS:
        rows = etf_rows.get(secid)
        if rows:
            names[secid] = STATE.names.get(secid, secid)
    return {"source": "tx", "idx": idx_rows, "etf": etf_rows, "names": names,
            "ok": etf_rows.get("__ok", 0)}


def fetch_day_meta(day: str) -> None:
    """昨收 + 昨日 33 只合计（亿），每个交易日只取一次。"""
    if STATE.meta_for == day:
        return
    try:
        _, idx_rows = sources.fetch_em(INDEX, 101, 4)
        prev = [r for r in idx_rows if r["day"] < day]
        if prev:
            STATE.pre_close = prev[-1]["close"]
    except Exception:
        pass

    total = 0.0
    got = 0
    for start in range(0, len(ALL_ETFS), sources.EM_BATCH):
        batch = ALL_ETFS[start : start + sources.EM_BATCH]
        for secid in batch:
            try:
                rows = sources.fetch_em_day(secid, 4)
            except Exception:
                continue
            prev = [r for r in rows if r["day"] < day]
            if prev:
                total += prev[-1]["amount"]
                got += 1
        if start + sources.EM_BATCH < len(ALL_ETFS):
            time.sleep(sources.EM_GAP)
    if got >= len(ALL_ETFS) * MIN_OK_RATIO:
        STATE.meta_for = day
        STATE.yest_total = round(total / sources.YI, 2)


# ───────────────────────── 聚合与写盘 ─────────────────────────

def merge(idx_rows: list[dict], etf_rows: dict, names: dict, source: str) -> int:
    if not idx_rows:
        raise RuntimeError("empty index")
    day = idx_rows[-1]["day"]
    STATE.reset_if_new_date(day)

    idx_map = {r["t"]: r["close"] for r in idx_rows if r["day"] == day}
    all_t: set[str] = set(idx_map)
    ok = 0
    for secid in ALL_ETFS:
        rows = etf_rows.get(secid)
        if not rows:
            continue
        ok += 1
        if secid not in STATE.etf:
            STATE.etf[secid] = {}
        if secid in names:
            STATE.names[secid] = names[secid]
        for r in rows:
            if r["day"] != day or not r["t"]:
                continue
            STATE.etf[secid][r["t"]] = r["amount"] / sources.YI
            all_t.add(r["t"])

    STATE.minutes = sorted(all_t)
    # 指数缺该分钟时沿用上一分钟价格
    prices = []
    last = None
    for t in STATE.minutes:
        last = idx_map.get(t, last)
        prices.append(last)
    STATE.idx_price = [p if p is not None else 0.0 for p in prices]
    STATE.source = "em" if source in ("em", "tx_fallback") else "tx"
    return ok


def build_payload(ok_count: int) -> dict:
    series = {}
    for secid in ALL_ETFS:
        m = STATE.etf.get(secid, {})
        series[secid] = {
            "name": STATE.names.get(secid, secid),
            "amt": [round(m[t], 4) if t in m else None for t in STATE.minutes],
        }
    return {
        "schema": 1,
        "date": STATE.date,
        "updated": now_bj().isoformat(timespec="seconds"),
        "phase": phase_now(STATE.date),
        "source": STATE.source,
        "online": ok_count,
        "totalEtfs": len(ALL_ETFS),
        "minutes": STATE.minutes,
        "index": {"preClose": STATE.pre_close, "price": STATE.idx_price},
        "yestTotal": STATE.yest_total,
        "groups": POOL["groups"],
        "etf": series,
    }


def atomic_write(path: Path, payload: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, path)


def run_once(force_source: str | None = None, incremental: bool = False) -> bool:
    first = fetch_round(incremental, force_source)
    if first["source"] == "em":
        ok = merge(first["idx"], first["etf"], first["names"], "em")
    else:
        if first.get("cached_em_bad"):
            print("[collect] 东财不健康，切腾讯备源", file=sys.stderr)
        tx = fetch_tx_round()
        ok = merge(tx["idx"], tx["etf"], tx["names"], "tx")

    if ok < len(ALL_ETFS) * MIN_OK_RATIO:
        print(f"[collect] 在线仅 {ok}/{len(ALL_ETFS)}，拒绝写盘", file=sys.stderr)
        return False

    fetch_day_meta(STATE.date)
    payload = build_payload(ok)
    atomic_write(RT_PATH, payload)
    STATE.last_written = payload["updated"]
    print(f"[collect] {payload['date']} {payload['minutes'][-1] if payload['minutes'] else '--'} "
          f"源={payload['source']} 在线={ok}/{len(ALL_ETFS)} 分钟数={len(payload['minutes'])}")
    return True


# ───────────────────────── 循环 ─────────────────────────

def maybe_publish(every: int, last_ts: float) -> float:
    if every <= 0 or time.time() - last_ts < every:
        return last_ts
    try:
        import publish
        publish.publish(quiet=True)
        return time.time()
    except Exception as exc:
        print(f"[collect] 发布失败：{exc}", file=sys.stderr)
        return time.time()


def maybe_hist(day: str, done: set[str]) -> None:
    if day in done or not day:
        return
    if phase_now(day) != "closed":
        return
    try:
        import collect_hist
        collect_hist.collect()
        done.add(day)
    except Exception as exc:
        print(f"[collect] 跨日归档失败：{exc}", file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="跑一轮后退出")
    ap.add_argument("--loop", action="store_true", help="常驻循环")
    ap.add_argument("--interval", type=int, default=60, help="盘中轮询秒数")
    ap.add_argument("--publish-every", type=int, default=300, help="发布间隔秒数，0=不发布")
    ap.add_argument("--force-source", choices=["em", "tx"], default=None)
    args = ap.parse_args()

    if args.once or not args.loop:
        return 0 if run_once(args.force_source) else 1

    last_pub = 0.0
    hist_done: set[str] = set()
    first_round = True
    backoff = 0
    while True:
        try:
            ok = run_once(args.force_source, incremental=not first_round)
            first_round = False
            backoff = 0 if ok else min(30, backoff + 5)
            last_pub = maybe_publish(args.publish_every, last_pub)
            if STATE.date and phase_now(STATE.date) == "closed":
                maybe_hist(STATE.date, hist_done)
                last_pub = maybe_publish(args.publish_every, last_pub)
        except KeyboardInterrupt:
            return 0
        except Exception as exc:
            print(f"[collect] 本轮失败：{exc}", file=sys.stderr)
            backoff = min(30, backoff + 5)

        sleep_s = args.interval if is_trading_now() else 300
        if backoff:
            sleep_s = max(sleep_s, backoff)
        # 对齐到下一分钟边界，保证分钟数据尽量完整
        now = time.time()
        time.sleep(max(5, sleep_s - (now % 60)) if sleep_s >= 60 else sleep_s)


if __name__ == "__main__":
    sys.exit(main())
