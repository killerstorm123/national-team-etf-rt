/* 浏览器直连数据层：东财 push2his 主源 + 腾讯 ifzq 备源。
   输出与 data/rt.json、data/hist.json 完全同构，静态 JSON 降级为兜底快照。
   采集端同款口径见 collector/sources.py。 */
(function () {
  'use strict';

  var POOL = {
    index: { secid: '1.000001', name: '上证指数' },
    groups: [
      { name: '沪深300', color: '#1a3c6e', etfs: ['1.510300', '1.510310', '1.510330', '1.515330', '0.159919'] },
      { name: '上证50', color: '#4f5bd5', etfs: ['1.510050', '1.510100', '1.530000'] },
      { name: '中证500', color: '#22b8a6', etfs: ['1.510500', '0.159922', '1.512500', '0.159820', '1.510580'] },
      { name: '中证1000', color: '#7e57c2', etfs: ['1.512100', '0.159845', '1.560010', '0.159633'] },
      { name: '中证A500', color: '#5c7099', etfs: ['1.563360', '0.159352', '0.159338', '0.159361', '1.512050', '1.563800'] },
      { name: '科创50', color: '#c0392b', etfs: ['1.588000', '1.588080', '1.588060', '1.588050', '1.588090'] },
      { name: '创业板', color: '#b8860b', etfs: ['0.159915', '0.159952', '0.159977', '0.159971', '0.159948'] }
    ]
  };
  var ALL_ETFS = [];
  POOL.groups.forEach(function (g) { g.etfs.forEach(function (s) { ALL_ETFS.push(s); }); });
  var INDEX = POOL.index.secid;
  var YI = 1e8;
  var EM = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
  var TX_MIN = 'https://ifzq.gtimg.cn/appstock/app/minute/query?code=';
  var TX_MK = 'https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=';
  var EM_COOLDOWN = 300000;   // 东财判死后 5 分钟内直接走腾讯
  var INC_LMT = 15;           // 增量轮只拉最近 15 分钟（容忍标签页休眠）
  var FULL_LMT = 300;
  var MK_LMT = 790;

  var state = {
    day: '', minutes: [], idxPrice: {}, etfAmt: {}, etfPx: {}, names: {},
    dayMeta: null,            // {date, preClose, yestTotal}
    emBadAt: 0, lastFullAt: 0, lastLoadAt: 0, busy: null, histAt: 0, histDay: ''
  };

  /* ── 基础工具 ── */
  function getJSON(url, timeout) {
    return new Promise(function (resolve, reject) {
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); reject(new Error('timeout ' + url)); }, timeout || 8000);
      fetch(url, { signal: ctl.signal, cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (j) { clearTimeout(timer); resolve(j); }).catch(function (e) {
        clearTimeout(timer); reject(e);
      });
    });
  }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function txCode(secid) { return (secid[0] === '1' ? 'sh' : 'sz') + secid.split('.')[1]; }
  function inSession(t) { return (t >= '09:31' && t <= '11:30') || (t >= '13:00' && t <= '15:00'); }
  function sortKey(t) { var m = +t.slice(0, 2) * 60 + +t.slice(3, 5); return m <= 690 ? m : m + 240; }
  function localISO(d) {
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T'
      + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function bjNow() { return new Date(Date.now() + (480 + new Date().getTimezoneOffset()) * 60000); }
  function bjHM() {
    var d = bjNow();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function bjDate() {
    var d = bjNow();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function phaseNow(day) {
    var m = bjHM();
    if (day && day !== bjDate()) return day < bjDate() ? 'closed' : 'preopen';
    if (!((m >= '09:15' && m <= '11:35') || (m >= '12:55' && m <= '15:05'))) {
      return m > '15:05' ? 'closed' : (m < '09:15' ? 'preopen' : 'closed');
    }
    return 'intraday';
  }
  function cacheGet(key, maxAge) {
    try {
      var v = JSON.parse(localStorage.getItem(key) || 'null');
      if (v && (!maxAge || Date.now() - v.ts < maxAge)) return v;
    } catch (e) { /* ignore */ }
    return null;
  }
  function cacheSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignore */ }
  }

  /* ── 东财 ── */
  function emKline(secid, klt, lmt, timeout) {
    var url = EM + '?secid=' + secid + '&klt=' + klt + '&fqt=1&lmt=' + lmt
      + '&end=20500101&fields1=f1,f2,f3&fields2=f51,f53,f57';
    return getJSON(url, timeout || 6000).then(function (p) {
      if (!p || p.rc !== 0 || !p.data) throw new Error('bad em resp');
      var rows = [];
      (p.data.klines || []).forEach(function (line) {
        var c = line.split(',');
        if (c.length >= 3 && c[0]) rows.push({ day: c[0].slice(0, 10), t: c[0].slice(11, 16), close: +c[1], amount: +c[2] });
      });
      if (!rows.length) throw new Error('empty em klines');
      return { name: p.data.name || secid, rows: rows };
    });
  }
  function probeEm(lmt) { return emKline(INDEX, 1, lmt || 5, 5000); }
  function emCooling() { return state.emBadAt && Date.now() - state.emBadAt < EM_COOLDOWN; }
  function emBatch(secids, klt, lmt, timeout) {
    var out = {}, names = {}, ok = 0, miss = 0;
    var batches = [];
    for (var i = 0; i < secids.length; i += 4) batches.push(secids.slice(i, i + 4));
    return batches.reduce(function (pr, batch) {
      return pr.then(function () {
        if (miss >= 8) throw new Error('em stalled');   // 连续 8 只无响应：快速失败落备源
        return Promise.all(batch.map(function (s) {
          return emKline(s, klt, lmt, timeout).then(function (r) {
            out[s] = r.rows; names[s] = r.name; ok++;
          }).catch(function () { miss++; });
        }));
      }).then(function () { return delay(500); });
    }, Promise.resolve()).then(function () {
      if (!ok) throw new Error('em all failed');
      return { rows: out, names: names, ok: ok };
    });
  }

  /* ── 腾讯 ── */
  function txMinute(secid) {
    var code = txCode(secid);
    return getJSON(TX_MIN + code, 8000).then(function (p) {
      var node = (p.data || {})[code] || {};
      var body = node.data || {};
      var lines = body.data || [];
      if (!lines.length) throw new Error('empty tx minute');
      var raw = String(body.date || '');
      var day = raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8);
      var rows = [], prev = 0, auction = null;
      lines.forEach(function (line) {
        var c = line.split(' ');
        if (c.length < 4) return;
        var t = c[0].slice(0, 2) + ':' + c[0].slice(2, 4);
        var cum = +c[3];
        var amount = cum - prev;
        prev = cum;
        if (t === '09:30') { auction = amount; return; }
        if (t === '09:31' && auction != null) { amount += auction; auction = null; }
        if (!inSession(t) || amount < 0) return;
        rows.push({ day: day, t: t, close: +c[1], amount: amount });
      });
      if (auction != null && auction > 0) {
        rows.push({ day: day, t: '09:31', close: rows.length ? rows[0].close : 0, amount: auction });
      }
      if (!rows.length) throw new Error('empty tx rows');
      var qt = (node.qt || {})[code] || [];
      return { name: qt[1] || secid, rows: rows, preClose: +qt[4] || null };
    });
  }
  function txBatch(secids, gap) {
    var out = {}, names = {}, pre = {}, ok = 0;
    var batches = [];
    for (var i = 0; i < secids.length; i += 12) batches.push(secids.slice(i, i + 12));
    return batches.reduce(function (pr, batch) {
      return pr.then(function () {
        return Promise.all(batch.map(function (s) {
          return txMinute(s).then(function (r) {
            out[s] = r.rows; names[s] = r.name;
            if (r.preClose) pre[s] = r.preClose;
            ok++;
          }).catch(function () { });
        }));
      }).then(function () { return delay(gap == null ? 150 : gap); });
    }, Promise.resolve()).then(function () {
      return { rows: out, names: names, pre: pre, ok: ok };
    });
  }
  function txMkline(secid, lmt) {
    var code = txCode(secid);
    return getJSON(TX_MK + code + ',m5,,' + (lmt || MK_LMT), 8000).then(function (p) {
      var node = (p.data || {})[code] || {};
      var raw = node.m5 || [];
      if (!raw.length) throw new Error('empty tx mkline');
      var rows = [];
      raw.forEach(function (it) {
        var stamp = String(it[0]);
        var t = stamp.slice(8, 10) + ':' + stamp.slice(10, 12);
        if (!inSession(t) || t === '13:00') return;
        rows.push({
          day: stamp.slice(0, 4) + '-' + stamp.slice(4, 6) + '-' + stamp.slice(6, 8),
          t: t, close: +it[2], amount: +it[2] * +it[5] * 100
        });
      });
      if (!rows.length) throw new Error('empty tx mk rows');
      return rows;
    });
  }

  /* ── 腾讯 m5 批量（跨日兜底聚合用）── */
  function txMkBatch(secids) {
    var out = {}, ok = 0;
    var batches = [];
    for (var i = 0; i < secids.length; i += 12) batches.push(secids.slice(i, i + 12));
    return batches.reduce(function (pr, batch) {
      return pr.then(function () {
        return Promise.all(batch.map(function (s) {
          return txMkline(s).then(function (rows) { out[s] = rows; ok++; }).catch(function () { });
        }));
      }).then(function () { return delay(150); });
    }, Promise.resolve()).then(function () { return { rows: out, ok: ok }; });
  }

  /* ── 状态合并（与 collector/collect_rt.merge 同口径）── */
  function persistNames(names) {
    var all = cacheGet('ntetf_names', 0) || {};
    var dirty = false;
    Object.keys(names).forEach(function (k) {
      if (all[k] !== names[k]) { all[k] = names[k]; dirty = true; }
    });
    if (dirty) cacheSet('ntetf_names', all);
  }
  function resetState(day) {
    state.day = day;
    state.minutes = [];
    state.idxPrice = {};
    state.etfAmt = {};
    state.etfPx = {};
    state.dayMeta = null;
  }
  function mergeIntoState(idxRows, etfRows, names) {
    var day = idxRows.length ? idxRows[idxRows.length - 1].day : '';
    if (!day) throw new Error('no day');
    if (day !== state.day) resetState(day);
    var idxMap = {}, allT = {};
    idxRows.forEach(function (r) {
      if (r.day === day && r.t && inSession(r.t)) { idxMap[r.t] = r.close; allT[r.t] = 1; }
    });
    Object.keys(idxMap).forEach(function (t) { state.idxPrice[t] = idxMap[t]; });
    ALL_ETFS.forEach(function (secid) {
      var rows = etfRows[secid];
      if (!rows || !rows.length) return;
      var m = state.etfAmt[secid] || (state.etfAmt[secid] = {});
      var px = state.etfPx[secid] || (state.etfPx[secid] = {});
      rows.forEach(function (r) {
        if (r.day !== day || !r.t || !inSession(r.t)) return;
        m[r.t] = r.amount / YI;
        px[r.t] = r.close;
        allT[r.t] = 1;
      });
    });
    if (names) { Object.keys(names).forEach(function (k) { state.names[k] = names[k]; }); persistNames(names); }
    state.minutes = Object.keys(allT).sort();
  }

  /* ── 生成 rt（与 data/rt.json 同构，附 px 分钟价）── */
  function buildRt(ok, source) {
    var minutes = state.minutes;
    var prices = [], last = null;
    minutes.forEach(function (t) {
      if (state.idxPrice[t] != null) last = state.idxPrice[t];
      prices.push(last == null ? 0 : last);
    });
    var allNames = cacheGet('ntetf_names', 0) || {};
    var series = {};
    ALL_ETFS.forEach(function (secid) {
      var m = state.etfAmt[secid] || {}, px = state.etfPx[secid] || {};
      var amt = [], pxa = [];
      minutes.forEach(function (t) {
        amt.push(m[t] != null ? Math.round(m[t] * 10000) / 10000 : null);
        pxa.push(px[t] != null ? px[t] : null);
      });
      series[secid] = {
        name: state.names[secid] || allNames[secid] || secid,
        amt: amt, px: pxa
      };
    });
    var meta = state.dayMeta;
    return {
      schema: 1, date: state.day, updated: localISO(bjNow()),
      phase: phaseNow(state.day), source: source,
      online: ok, totalEtfs: ALL_ETFS.length,
      minutes: minutes,
      index: { preClose: (meta && meta.preClose) || null, price: prices },
      yestTotal: (meta && meta.yestTotal) || null,
      groups: POOL.groups, etf: series, live: true
    };
  }

  /* ── 昨收 + 昨日全天合计（EM 日 K，一天一次，localStorage 缓存）── */
  function ensureDayMeta(day) {
    var cached = cacheGet('ntetf_daymeta', 0);
    if (cached && cached.date === day && cached.yestTotal != null) {
      state.dayMeta = cached;
      return Promise.resolve(cached);
    }
    return Promise.all([
      emKline(INDEX, 101, 4).catch(function () { return null; }),
      emBatch(ALL_ETFS, 101, 4)
    ]).then(function (res) {
      var idxRows = res[0] ? res[0].rows : [];
      var r = res[1];
      var prev = idxRows.filter(function (x) { return x.day < day; });
      var preClose = prev.length ? prev[prev.length - 1].close : null;
      var total = 0, got = 0;
      ALL_ETFS.forEach(function (s) {
        var rows = r.rows[s];
        if (!rows) return;
        var pv = rows.filter(function (x) { return x.day < day; });
        if (pv.length) { total += pv[pv.length - 1].amount; got++; }
      });
      if (got < ALL_ETFS.length * 0.7) throw new Error('meta insufficient');
      var meta = { date: day, preClose: preClose, yestTotal: Math.round(total / YI * 100) / 100, ts: Date.now() };
      cacheSet('ntetf_daymeta', meta);
      state.dayMeta = meta;
      if (Object.keys(r.names).length) { Object.keys(r.names).forEach(function (k) { state.names[k] = r.names[k]; }); persistNames(r.names); }
      return meta;
    }).catch(function () {
      if (state.txPreClose) {
        var m = { date: day, preClose: state.txPreClose, yestTotal: null, ts: Date.now() };
        state.dayMeta = m;
        return m;
      }
      return null;
    });
  }

  /* ── 跨日聚合（与 collector/collect_hist.collect 同构）── */
  function assembleHist(raw, idxRows, approx) {
    var daySet = {};
    Object.keys(raw).forEach(function (s) {
      Object.keys(raw[s]).forEach(function (d) { daySet[d] = 1; });
    });
    var days = Object.keys(daySet).sort().slice(-15);
    if (!days.length) throw new Error('no hist days');
    var labelSet = {};
    days.forEach(function (d) {
      Object.keys(raw).forEach(function (s) {
        var by = raw[s][d];
        if (by) Object.keys(by).forEach(function (t) { labelSet[t] = 1; });
      });
    });
    var bars = Object.keys(labelSet).sort(function (a, b) { return sortKey(a) - sortKey(b); });
    var idxBy = {};
    idxRows.forEach(function (x) {
      if (days.indexOf(x.day) >= 0) idxBy[x.day + ' ' + x.t] = x.close;
    });
    var total5 = [], dailyTotal = [], fam5 = {};
    POOL.groups.forEach(function (g) { fam5[g.name] = []; });
    days.forEach(function (d) {
      var rowT = bars.map(function (t) {
        var v = 0;
        Object.keys(raw).forEach(function (s) { v += (raw[s][d] && raw[s][d][t]) || 0; });
        return Math.round(v * 10000) / 10000;
      });
      total5.push(rowT);
      dailyTotal.push(Math.round(rowT.reduce(function (a, b) { return a + b; }, 0) * 100) / 100);
      POOL.groups.forEach(function (g) {
        var rowF = bars.map(function (t) {
          var v = 0;
          g.etfs.forEach(function (s) { v += (raw[s] && raw[s][d] && raw[s][d][t]) || 0; });
          return Math.round(v * 10000) / 10000;
        });
        fam5[g.name].push(rowF);
      });
    });
    var index5 = days.map(function (d) {
      return bars.map(function (t) { return Math.round((idxBy[d + ' ' + t] || 0) * 1000) / 1000; });
    });
    return {
      schema: 1, updated: localISO(bjNow()), granularity: 5,
      days: days, bars: bars, total5: total5, fam5: fam5, index5: index5,
      dailyTotal: dailyTotal, degraded: ALL_ETFS.filter(function (s) { return !raw[s]; }),
      approx: approx, live: true
    };
  }
  function rawFromRows(rowsMap) {
    var raw = {};
    Object.keys(rowsMap).forEach(function (s) {
      var by = {};
      rowsMap[s].forEach(function (x) { (by[x.day] = by[x.day] || {})[x.t] = x.amount / YI; });
      raw[s] = by;
    });
    return raw;
  }
  function buildHistEm() {
    return Promise.all([
      emKline(INDEX, 5, 725).then(function (r) { return r.rows; }).catch(function () { return []; }),
      emBatch(ALL_ETFS, 5, 725)
    ]).then(function (res) {
      var r = res[1];
      if (!r.ok) throw new Error('hist em failed');
      return assembleHist(rawFromRows(r.rows), res[0], false);
    });
  }
  function buildHistTx() {
    return Promise.all([
      txMkline(INDEX).catch(function () { return []; }),
      txMkBatch(ALL_ETFS)
    ]).then(function (res) {
      if (!res[1].ok) throw new Error('hist tx failed');
      return assembleHist(rawFromRows(res[1].rows), res[0], true);
    });
  }
  function ensureHist(day, phase, force) {
    var cached = cacheGet('ntetf_hist', 600000);
    if (!force && cached && cached.payload) {
      var p = cached.payload;
      var hasToday = p.days.indexOf(day) >= 0;
      var complete = p.days.length && p.days[p.days.length - 1] === day && phase === 'closed';
      if (hasToday || complete) return Promise.resolve(p);
    }
    return buildHistEm().catch(function () { return buildHistTx(); })
      .then(function (payload) {
        cacheSet('ntetf_hist', { ts: Date.now(), payload: payload });
        return payload;
      }).catch(function () { return null; });
  }

  /* ── 一轮取数（EM 主源，失败/不足 70% 自动落腾讯）── */
  function txRound() {
    state.emBadAt = Date.now();
    return txMinute(INDEX).then(function (idxTx) {
      if (idxTx.preClose) state.txPreClose = idxTx.preClose;
      return txBatch(ALL_ETFS).then(function (r) {
        if (!r.ok) throw new Error('tx all failed');
        mergeIntoState(idxTx.rows, r.rows, r.names);
        return { source: 'tx', ok: r.ok };
      });
    });
  }
  function doLoad(full) {
    var lmt = full ? FULL_LMT : INC_LMT;
    var probe = emCooling() ? Promise.resolve(null) : probeEm(lmt).catch(function () { return null; });
    return probe.then(function (idxR) {
      if (idxR && idxR.rows.length) {
        state.emBadAt = 0;
        return emBatch(ALL_ETFS, 1, lmt).then(function (r) {
          if (r.ok < ALL_ETFS.length * 0.7) throw new Error('em partial ' + r.ok);
          mergeIntoState(idxR.rows, r.rows, r.names);
          return { source: 'em', ok: r.ok };
        }).catch(function () { return txRound(); });
      }
      return txRound();
    }).then(function (res) {
      state.lastLoadAt = Date.now();
      if (full) state.lastFullAt = Date.now();
      var phase = phaseNow(state.day);
      var histNeeded = full || !cacheGet('ntetf_hist', 600000) || (phase === 'closed' && state.histDay !== state.day);
      var histP = histNeeded
        ? ensureHist(state.day, phase, false).then(function (h) {
            if (h) state.histDay = h.days[h.days.length - 1];
            return h;
          })
        : Promise.resolve(null);
      var rtObj = null;
      /* 日 K 元数据不阻塞首绘：最多等 12s；晚到则回填 rt，下次渲染生效 */
      var metaP = ensureDayMeta(state.day).catch(function () { return null; });
      return Promise.race([metaP, delay(12000)]).then(function () {
        rtObj = buildRt(res.ok, res.source);
        metaP.then(function (meta) {
          if (meta && rtObj && rtObj.yestTotal == null) {
            rtObj.yestTotal = meta.yestTotal;
            if (meta.preClose && !rtObj.index.preClose) rtObj.index.preClose = meta.preClose;
          }
        });
        return { rt: rtObj, histPromise: histP, full: full };
      });
    });
  }
  function load() {
    if (state.busy) return state.busy;
    var nowT = Date.now();
    var full = !state.day
      || (nowT - state.lastFullAt > 15 * 60 * 1000)
      || (nowT - state.lastLoadAt > 5 * 60 * 1000);
    state.busy = doLoad(full).then(
      function (res) { state.busy = null; return res; },
      function (err) { state.busy = null; throw err; }
    );
    return state.busy;
  }

  /* ── 盘后封存：当日分钟合计 vs 东财日 K 核对 ── */
  function sealToday(rt) {
    var day = rt.date;
    var sum = 0;
    ALL_ETFS.forEach(function (s) {
      var e = rt.etf[s];
      if (!e) return;
      e.amt.forEach(function (v) { if (v != null) sum += v; });
    });
    var rec = { date: day, total: Math.round(sum * 100) / 100, minutes: rt.minutes.length,
                savedAt: localISO(bjNow()), dayKTotal: null, diffPct: null };
    return emBatch(ALL_ETFS, 101, 4).then(function (r) {
      var kt = 0, got = 0;
      ALL_ETFS.forEach(function (s) {
        var rows = r.rows[s];
        if (!rows) return;
        var cur = rows.filter(function (x) { return x.day === day; });
        if (cur.length) { kt += cur[cur.length - 1].amount / YI; got++; }
      });
      if (got >= ALL_ETFS.length * 0.7) {
        rec.dayKTotal = Math.round(kt * 100) / 100;
        rec.diffPct = Math.round((rec.total - rec.dayKTotal) / rec.dayKTotal * 10000) / 100;
      }
      return rec;
    }).catch(function () { return rec; });
  }

  window.LiveData = {
    load: load,
    sealToday: sealToday,
    isTradingNow: function () {
      var m = bjHM();
      return (m >= '09:15' && m <= '11:35') || (m >= '12:55' && m <= '15:05');
    }
  };
})();
