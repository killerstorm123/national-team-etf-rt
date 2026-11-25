# 国家队 ETF 分钟成交额实时看板

7 族 33 只宽基 ETF 盘中分钟成交额监控：5 KPI + 分钟柱/指数双轴（含 15 日同刻分位带）+ 族结构/超额线 + 日内累计对比 + 30 分钟槽热力 + 单只 ETF 表 + 盘后封存核对。

**数据链路（v2）**：页面默认浏览器直连（`live.js`：东财 push2his 主源 → 腾讯 ifzq 备源，首绘约 3–6 秒）；直连失败自动落 `data/*.json` 静态兜底快照（需采集器或发布流水线维护），URL 加 `?src=static` 可强制兜底。页面纯静态、ECharts 本地内嵌、零 CDN。

## 快速开始

```bash
# 1) 跑一轮采集（收盘后也可跑，取最近交易日全天）
python3 collector/collect_rt.py --once

# 2) 拉取最近 15 日 5 分钟聚合
python3 collector/collect_hist.py

# 3) 本地盯盘（web/ + data/ 合并挂载，no-cache，页面 60 秒自刷）
python3 collector/serve.py            # http://127.0.0.1:8787/

# 4) 盘中常驻 + 每 5 分钟发布一次 docs/
./run_intraday.sh                     # PUBLISH_EVERY=300 可调
```

强制走腾讯备源验证容错：`python3 collector/collect_rt.py --once --force-source tx`。

## 目录

| 路径 | 作用 |
|---|---|
| `config/pool.json` | 唯一事实来源：7 族 33 只 ETF、指数、族色 |
| `collector/sources.py` | 东财 push2his 主源、腾讯 ifzq 备源、健康状态与重试 |
| `collector/collect_rt.py` | 60 秒循环、增量合并、原子写 `data/rt.json`、熔断与退避 |
| `collector/collect_hist.py` | 15 日 5 分钟聚合 → `data/hist.json`，并归档当日 `data/archive/` |
| `collector/publish.py` | 同步 `web/` + `data/` → `docs/`，git 提交推送（4 次重试） |
| `collector/serve.py` | 本地 no-cache 服务，盯盘用 |
| `web/live.js` | 浏览器直连数据层：东财主源 + 腾讯备源 + 静态兜底，输出与 rt.json 同构 |
| `web/index.html` / `web/app.js` | 页面与图表逻辑（5 KPI、主图分位带、族结构/超额、累计对比、热力、ETF 表、封存核对） |
| `docs/` | GitHub Pages 发布目录（`index.html` + `live.js` + `data/*.json`） |

## 数据契约

**`data/rt.json`（每 60 秒覆写）**

```json
{
  "schema": 1, "date": "2026-11-06", "updated": "2026-11-06T15:00:12+08:00",
  "phase": "intraday|preopen|closed", "source": "em|tx",
  "online": 33, "totalEtfs": 33,
  "minutes": ["09:31", "..."],
  "index": {"preClose": 3624.5, "price": [3623.3, "..."]},
  "yestTotal": 1085.1,
  "groups": [{"name": "沪深300", "color": "#1a3c6e", "etfs": ["1.510300", "..."]}],
  "etf": {"1.510300": {"name": "沪深300ETF华泰柏瑞", "amt": [6.61, "..."]}}
}
```

`amt` 单位亿元，与 `minutes` 一一对应，缺测为 `null`；09:31 首根含集合竞价。

**`data/hist.json`（收盘后更新）**

```json
{
  "schema": 1, "granularity": 5,
  "days": ["2026-10-17", "..."], "bars": ["09:35", "... 48 根"],
  "total5": [[...], "..."], "fam5": {"沪深300": [[...]]},
  "index5": [[...]], "dailyTotal": [567.8, "..."], "degraded": []
}
```

## 数据链路（浏览器直连）

页面加载时优先走 `web/live.js` 直连行情接口，失败才回落静态 JSON：

1. **东财主源**：`push2his` 逐只拉分钟 K（4 只/批）；连续 8 只无响应或全批失败即判死，冷却 5 分钟。
2. **腾讯备源**：`ifzq` 分钟累计额差分（09:30 竞价并入 09:31），口径与采集器一致。
3. **静态兜底**：两者皆失败时加载 `data/rt.json` + `data/hist.json`（徽章显示「静态兜底快照」）；`?src=static` 强制兜底，用于验收与排障。

辅助缓存（localStorage）：`ntetf_names` 名称表、`ntetf_daymeta` 昨日总额/昨收、`ntetf_hist` 跨日聚合（10 分钟过期）、`ntetf_seals` 盘后封存记录（滚动 60 条）。

**盘后封存核对**：收盘且分钟数 ≥200 时自动请求日 K 合计并记录 `{当日合计, 日K合计, 偏差%}`，可导出 JSON 对账；**P90 标题闪烁**：勾选后最新分钟额进入近 15 日同刻 P90 时，标签页标题交替闪烁提醒。

## 部署（GitHub Pages）

```bash
git init && git add . && git commit -m "init"
git remote add origin git@github.com:<you>/national-team-etf-rt.git
git push -u origin main
# 仓库 Settings → Pages → Source: main / docs
python3 collector/publish.py          # 之后每次同步 + 推送
```

## 口径与取舍

- **主源/备源**：东财 `push2his`（klt=1/5/101）；探测失败或批量成功率 < 70% 时冷却 5 分钟并整段切腾讯 `ifzq`。
- **腾讯分钟**：累计额差分；09:30 竞价并入 09:31；剔除 15:00 之后的盘后残留与负增量。
- **腾讯 5 分钟**：无成交额字段，只在跨日降级时按「收盘价×量」近似。
- **跨日视图**：只存 15 日聚合（总量 + 7 族 + 指数），不存单只 ETF 明细。
- **实时性**：浏览器直连约 3–6 秒（页面 60 秒自刷拉增量）；本地 `serve.py`/静态兜底为 60 秒采集节奏；GitHub Pages CDN 额外 1–3 分钟延迟。
- **放量标注**：前 20 分钟中位数 ×2.5 或 均值+3σ，取当日最强 5 根。
- **族占比突变**：近 10 分钟 vs 前 10 分钟占比差 ≥ 4pp 且该族近 10 分钟 ≥ 5 亿时提示。
- **边界**：成交额无法区分买卖方向，放量不等于国家队进场；本板仅为盘中量能观察。

## 验收

```bash
python3 -c "import json;d=json.load(open('data/rt.json'));print(d['date'],d['online'],len(d['minutes']),len(d['etf']))"
# 期望：交易日 / 33 / ~240 / 33
```
