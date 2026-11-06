"""行情取数层：东财 push2his 主源 + 腾讯 ifzq 备源。

实测要点（2026-11 验证）：
- push2 域名的 klt=5 / klt=101 返回空数组，跨日与日 K 必须走 push2his；
  push2his 的 klt=1 同样可用，因此东财统一用 push2his。
- 东财 klines 每行 = "YYYY-MM-DD HH:MM,收盘价,成交额(元)"，klt=1 的 09:31 首根含集合竞价。
- 腾讯 minute 返回当日累计成交额，需要逐分钟差分；09:30 那根是竞价，并入 09:31。
- 腾讯 mkline 的 m5 没有成交额字段，只能按 收盘价 × 成交量(手)×100 近似。
"""

from __future__ import annotations

import json
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

YI = 1e8
EM_HOST = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
TX_MINUTE = "https://ifzq.gtimg.cn/appstock/app/minute/query?code={code}"
TX_MKLINE = "https://ifzq.gtimg.cn/appstock/app/kline/mkline?param={code},m5,,{lmt}"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36"

EM_BATCH, EM_GAP = 4, 0.5
TX_BATCH, TX_GAP = 12, 0.15
TIMEOUT, RETRIES = 6, 1


def _get_json(url: str, timeout: float = TIMEOUT, retries: int = RETRIES) -> dict:
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # 网络错误/超时/坏 JSON 统一重试
            last = exc
            if attempt < retries:
                time.sleep(0.8 * (attempt + 1))
    raise RuntimeError(f"request failed: {url} ({last})")


def tx_code(secid: str) -> str:
    return ("sh" if secid[0] == "1" else "sz") + secid.split(".", 1)[1]


def _is_session_minute(t: str) -> bool:
    """只保留 09:31–11:30 / 13:00–15:00，剔除腾讯盘后残留的 15:01+ 分钟。"""
    return ("09:31" <= t <= "11:30") or ("13:00" <= t <= "15:00")


# ───────────────────────── 东财 ─────────────────────────

def fetch_em(secid: str, klt: int, lmt: int, timeout: float = TIMEOUT) -> tuple[str, list[dict]]:
    """返回 (名称, [{day,t,close,amount}])，amount 单位元。"""
    url = (
        f"{EM_HOST}?secid={secid}&klt={klt}&fqt=1&lmt={lmt}&end=20500101"
        "&fields1=f1,f2,f3&fields2=f51,f53,f57"
    )
    payload = _get_json(url, timeout=timeout)
    if payload.get("rc") != 0 or not payload.get("data"):
        raise RuntimeError(f"bad em resp for {secid}")
    data = payload["data"]
    rows = []
    for line in data.get("klines") or []:
        parts = line.split(",")
        if len(parts) < 3 or not parts[0]:
            continue
        rows.append(
            {
                "day": parts[0][:10],
                "t": parts[0][11:16],
                "close": float(parts[1]),
                "amount": float(parts[2]),
            }
        )
    if not rows:
        raise RuntimeError(f"empty em klines for {secid}")
    return data.get("name") or secid, rows


def probe_em(lmt: int = 5, timeout: float = 2.5) -> tuple[bool, list[dict]]:
    """只拉指数判活：短超时、不重试。"""
    try:
        _, rows = fetch_em("1.000001", 1, lmt, timeout=timeout)
        return True, rows
    except Exception:
        return False, []


def fetch_em_day(secid: str, lmt: int = 6) -> list[dict]:
    """日 K：昨收与昨日全天成交额都从这里取。"""
    _, rows = fetch_em(secid, 101, lmt)
    return rows


def fetch_many_em(secids: list[str], klt: int, lmt: int) -> tuple[dict[str, list[dict]], dict[str, str]]:
    rows_out: dict[str, list[dict]] = {}
    names: dict[str, str] = {}
    ok = 0
    for start in range(0, len(secids), EM_BATCH):
        batch = secids[start : start + EM_BATCH]
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            results = list(pool.map(lambda s: _safe(lambda x: fetch_em(x, klt, lmt), s), batch))
        for secid, result in zip(batch, results):
            if result is None:
                continue
            name, rows = result
            rows_out[secid] = rows
            names[secid] = name
            ok += 1
        if start + EM_BATCH < len(secids):
            time.sleep(EM_GAP)
    rows_out["__ok"] = ok  # type: ignore[assignment]
    return rows_out, names


def _safe(fn, arg):
    try:
        return fn(arg)
    except Exception:
        return None


# ───────────────────────── 腾讯 ─────────────────────────

def fetch_tx_minute(secid: str) -> tuple[str, list[dict]]:
    """累计额差分 → 当分钟额；09:30 竞价并入 09:31。"""
    code = tx_code(secid)
    payload = _get_json(TX_MINUTE.format(code=code))
    node = (payload.get("data") or {}).get(code) or {}
    body = (node.get("data") or {})
    lines = body.get("data") or []
    if not lines:
        raise RuntimeError(f"empty tx minute for {code}")
    raw_date = body.get("date") or time.strftime("%Y%m%d")
    day = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:8]}"

    rows: list[dict] = []
    prev = 0.0
    auction: float | None = None
    for line in lines:
        parts = line.split()
        if len(parts) < 4:
            continue
        hhmm = parts[0]
        t = f"{hhmm[:2]}:{hhmm[2:4]}"
        cum = float(parts[3])
        amount = cum - prev
        prev = cum
        if t == "09:30":
            auction = amount
            continue
        if t == "09:31" and auction is not None:
            amount += auction
            auction = None
        if not _is_session_minute(t) or amount < 0:
            continue
        rows.append({"day": day, "t": t, "close": float(parts[1]), "amount": amount})
    if auction is not None:
        rows.append({"day": day, "t": "09:31", "close": rows[0]["close"] if rows else 0.0, "amount": auction})
    if not rows:
        raise RuntimeError(f"empty tx minute rows for {code}")
    qt = (node.get("qt") or {}).get(code) or []
    name = qt[1] if len(qt) > 1 else secid
    return name, rows


def fetch_many_tx(secids: list[str]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    ok = 0
    for start in range(0, len(secids), TX_BATCH):
        batch = secids[start : start + TX_BATCH]
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            results = list(pool.map(lambda s: (s, _safe(lambda x: fetch_tx_minute(x), s)), batch))
        for secid, result in results:
            if result is None:
                continue
            out[secid] = result[1]
            ok += 1
        if start + TX_BATCH < len(secids):
            time.sleep(TX_GAP)
    out["__ok"] = ok  # type: ignore[assignment]
    return out


def fetch_tx_mkline(secid: str, lmt: int = 790) -> list[dict]:
    """5 分钟 K 备源：无成交额字段，按 收盘价×量(手)×100 近似。"""
    code = tx_code(secid)
    payload = _get_json(TX_MKLINE.format(code=code, lmt=lmt))
    node = (payload.get("data") or {}).get(code) or {}
    raw = node.get("m5") or []
    if not raw:
        raise RuntimeError(f"empty tx mkline for {code}")
    rows = []
    for item in raw:
        stamp = item[0]
        rows.append(
            {
                "day": f"{stamp[:4]}-{stamp[4:6]}-{stamp[6:8]}",
                "t": f"{stamp[8:10]}:{stamp[10:12]}",
                "close": float(item[2]),
                "amount": float(item[2]) * float(item[5]) * 100,
            }
        )
    return rows


# ───────────────────────── 源健康状态 ─────────────────────────

class SourceState:
    """东财探测失败后冷却 5 分钟，冷却期内直接走腾讯。"""

    COOLDOWN = 300.0

    def __init__(self) -> None:
        self.source = "em"
        self.em_bad_at = 0.0

    def cooling(self) -> bool:
        return (time.time() - self.em_bad_at) < self.COOLDOWN

    def mark_em_bad(self) -> None:
        self.em_bad_at = time.time()

    def mark_em_ok(self) -> None:
        self.em_bad_at = 0.0
        self.source = "em"
