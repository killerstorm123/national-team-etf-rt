/* 国家队 ETF 分钟成交额实时看板 · 前端渲染
   数据链路：live.js 浏览器直连（东财主源+腾讯备源）→ 失败落 data/*.json 静态兜底（?src=static 强制）。 */
(function () {
  'use strict';

  var S = { rt: null, hist: null, view: 'today', mode: 'total', shareMode: 'share', heatMode: 'pct',
            charts: {}, timer: null, cd: 60, paused: false, histLoadedAt: 0, error: '',
            src: 'live', p90flash: false, p0: null, flashOn: false, sealing: false };
  var $ = function (id) { return document.getElementById(id); };
  var INK = '#1a3c6e', ORANGE = '#e07b39', RED = '#c0392b', TEAL = '#0e7c86';
  var BASE_TITLE = document.title;
  var FMT = function (x, d) {
    if (x == null || isNaN(x)) return '--';
    d = d == null ? 1 : d;
    return Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(d);
  };

  /* ── 时间轴工具：压掉午休，09:31=0，15:00=240 ── */
  function offsetOf(t) {
    var m = parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10);
    return m <= 690 ? m - 571 : m - 660;
  }
  var TIME_AT = (function () {
    var arr = [];
    for (var off = 0; off <= 240; off++) {
      var m = off <= 119 ? 571 + off : 660 + off;
      arr.push(pad(Math.floor(m / 60)) + ':' + pad(m % 60));
    }
    return arr;
  })();
  function pad(n) { return String(n).padStart(2, '0'); }
  function timeAt(off) { return TIME_AT[Math.round(off)] || ''; }

  /* ── 数据派生 ── */
  function derive(rt) {
    var fam = {};
    rt.groups.forEach(function (g) {
      fam[g.name] = new Array(rt.minutes.length).fill(0);
    });
    rt.groups.forEach(function (g) {
      g.etfs.forEach(function (sec) {
        var e = rt.etf[sec];
        if (!e) return;
        e.amt.forEach(function (v, i) {
          if (v != null && fam[g.name][i] != null) fam[g.name][i] += v;
        });
      });
    });
    var total = rt.minutes.map(function (_, i) {
      var s = 0;
      rt.groups.forEach(function (g) { s += fam[g.name][i]; });
      return s;
    });
    return { fam: fam, total: total };
  }

  function lastIndex(arr) {
    for (var i = arr.length - 1; i >= 0; i--) if (arr[i] > 0) return i;
    return -1;
  }

  function median(a) {
    if (!a.length) return 0;
    var b = a.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(b.length / 2);
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  }

  function quantile(a, q) {
    if (!a.length) return 0;
    var b = a.slice().sort(function (x, y) { return x - y; });
    var pos = (b.length - 1) * q, base = Math.floor(pos), rest = pos - base;
    return b[base + 1] !== undefined ? b[base] + rest * (b[base + 1] - b[base]) : b[base];
  }

  /* ── 跨日槽统计 ── */
  /* 参与历史对比的交易日索引：盘中剔除今日（未完），收盘后含今日 */
  function histDayIdx() {
    var rt = S.rt, h = S.hist;
    if (!rt || !h) return [];
    var out = [];
    h.days.forEach(function (day, di) {
      if (rt.phase === 'closed' || day < rt.date) out.push(di);
    });
    return out;
  }
  /* 槽 k = 5 分钟段；分钟偏移 → 槽索引 */
  function slotAt(off) {
    return Math.max(0, Math.min(47, Math.floor((off - 4) / 5)));
  }
  function slotStats() {
    var h = S.hist;
    var di = histDayIdx();
    if (!h || !di.length || !h.bars) return null;
    var med = [], p90 = [], p10 = [];
    h.bars.forEach(function (_, k) {
      var vals = di.map(function (d) { return h.total5[d][k]; }).filter(function (v) { return v > 0; });
      med.push(vals.length >= 3 ? median(vals) / 5 : null);
      p90.push(vals.length >= 3 ? quantile(vals, .9) / 5 : null);
      p10.push(vals.length >= 3 ? quantile(vals, .1) / 5 : null);
    });
    return { med: med, p90: p90, p10: p10 };
  }
  /* 最新分钟额在近15日同槽分布中的分位 */
  function latestPct() {
    var rt = S.rt, h = S.hist;
    if (!rt || !h) return null;
    var d = derive(rt);
    var i = lastIndex(d.total);
    if (i < 0) return null;
    var k = slotAt(offsetOf(rt.minutes[i]));
    var di = histDayIdx();
    if (!di.length) return null;
    var vals = di.map(function (x) { return h.total5[x][k]; }).filter(function (v) { return v > 0; });
    if (vals.length < 5) return null;
    var cur5 = d.total[i] * 5;   // 与 5 分钟槽同尺度比较（排名不受缩放影响）
    var rank = vals.filter(function (v) { return v <= cur5; }).length / vals.length * 100;
    return { i: i, k: k, rank: rank, med: median(vals) / 5, p90: quantile(vals, .9) / 5 };
  }
  /* 族同槽累计中位（跨日） */
  function slotCumMedian(daysIdx, famName) {
    var h = S.hist, out = [];
    for (var k = 0; k < h.bars.length; k++) {
      var vals = daysIdx.map(function (d) {
        var row = h.fam5[famName] && h.fam5[famName][d];
        if (!row) return 0;
        var run = 0;
        for (var j = 0; j <= k; j++) run += row[j] || 0;
        return run;
      });
      out.push(median(vals));
    }
    return out;
  }
  /* 槽内线性插值：分钟偏移 → 历史同刻累计基准 */
  function interpCum(cum, off) {
    if (off < 4) return 0;
    var k = Math.min(47, Math.floor((off - 4) / 5) + 1);
    var startOff = 5 * (k - 1) + 4, endOff = 5 * k + 4;
    var prev = k > 0 ? cum[k - 1] : 0;
    if (endOff <= startOff) return cum[k];
    var frac = Math.max(0, Math.min(1, (off - startOff) / (endOff - startOff)));
    return prev + (cum[k] - prev) * frac;
  }

  /* 增强①：放量分钟 + 主导族归因 */
  function detectSpikes(total, minutes, fam, groups) {
    var out = [], n = total.length;
    for (var i = 20; i < n; i++) {
      var win = total.slice(i - 20, i).filter(function (v) { return v > 0; });
      if (win.length < 10) continue;
      var med = median(win);
      var mean = win.reduce(function (a, b) { return a + b; }, 0) / win.length;
      var sd = Math.sqrt(win.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / win.length);
      var th = Math.max(med * 2.5, mean + 3 * sd);
      if (total[i] >= th && total[i] > 0) {
        var lead = '', leadV = 0;
        groups.forEach(function (g) {
          if (fam[g.name][i] > leadV) { leadV = fam[g.name][i]; lead = g.name; }
        });
        out.push({ i: i, t: minutes[i], v: total[i], ratio: med ? total[i] / med : 0, fam: lead });
      }
    }
    return out.sort(function (a, b) { return b.v - a.v; }).slice(0, 5)
      .sort(function (a, b) { return a.i - b.i; });
  }

  /* 增强②：族占比突变（近 10 分钟 vs 前 10 分钟） */
  function detectShifts(total, minutes, fam, groups) {
    var out = [], n = total.length;
    for (var i = 20; i < n; i++) {
      var sumA = 0, sumB = 0;
      for (var j = i - 9; j <= i; j++) sumA += total[j] || 0;
      for (var k = i - 19; k <= i - 10; k++) sumB += total[k] || 0;
      if (sumA < 5) continue;
      groups.forEach(function (g) {
        var a = 0, b = 0;
        for (var j2 = i - 9; j2 <= i; j2++) a += fam[g.name][j2] || 0;
        for (var k2 = i - 19; k2 <= i - 10; k2++) b += fam[g.name][k2] || 0;
        var pa = sumA ? a / sumA * 100 : 0;
        var pb = sumB ? b / sumB * 100 : 0;
        if (pa - pb >= 4) out.push({ i: i, t: minutes[i], fam: g.name, from: pb, to: pa, amt: a });
      });
    }
    var seen = {}, keep = [];
    out.reverse().forEach(function (x) {
      if (seen[x.fam]) return;
      seen[x.fam] = 1;
      keep.push(x);
    });
    return keep.slice(0, 2);
  }

  /* ── 图表公共 ── */
  function chartOf(el) {
    return S.charts[el.id] || (S.charts[el.id] = echarts.init(el, null, { renderer: 'canvas' }));
  }
  function idxAxisRange(preClose, prices) {
    var dev = 20;
    prices.forEach(function (p) { if (p != null) dev = Math.max(dev, Math.abs(p - preClose)); });
    return { min: preClose - dev * 1.25, max: preClose + dev * 1.25 };
  }
  function gridBase() {
    return { left: 52, right: 58, top: 34, bottom: 62 };
  }
  var baseTooltip = {
    trigger: 'axis',
    axisPointer: { type: 'shadow' },
    backgroundColor: 'rgba(255,255,255,.97)',
    borderColor: '#dfe6f1',
    textStyle: { color: '#222', fontSize: 12 },
    extraCssText: 'box-shadow:0 4px 18px rgba(20,40,80,.10);border-radius:8px;'
  };

  /* ── 图 1：今日（含 15 日同刻分位带） ── */
  function optionMainToday() {
    var rt = S.rt, d = derive(rt), minutes = rt.minutes, total = d.total;
    var series = [];
    if (S.mode === 'total') {
      series.push({
        name: '33只合计', type: 'bar', data: total.map(function (v) { return +v.toFixed(2); }),
        barMaxWidth: 12, itemStyle: { color: INK, borderRadius: [2, 2, 0, 0] }, z: 3
      });
    } else {
      rt.groups.forEach(function (g) {
        series.push({
          name: g.name, type: 'bar', stack: 'amt', barMaxWidth: 12,
          data: d.fam[g.name].map(function (v) { return +v.toFixed(2); }),
          itemStyle: { color: g.color }, z: 3
        });
      });
    }

    /* 15 日同刻分位带：5 分钟槽中位/P90 ÷5 折算每分钟，逐分钟铺到当根槽位 */
    var st = slotStats();
    if (st) {
      var lower = [], width = [], any = false;
      minutes.forEach(function (t) {
        var k = slotAt(offsetOf(t));
        if (st.med[k] == null) { lower.push(null); width.push(null); return; }
        any = true;
        lower.push(+st.med[k].toFixed(2));
        width.push(+Math.max(0, st.p90[k] - st.med[k]).toFixed(2));
      });
      if (any) {
        series.push({ name: '15日分位带(中位–P90)', type: 'line', stack: 'band', z: 1,
          showSymbol: false, silent: true, lineStyle: { opacity: 0 },
          areaStyle: { color: 'rgba(0,0,0,0)' }, tooltip: { show: false }, data: lower });
        series.push({ name: '15日分位带(中位–P90)', type: 'line', stack: 'band', z: 1,
          showSymbol: false, silent: true, lineStyle: { opacity: 0 },
          areaStyle: { color: 'rgba(26,60,110,.08)' }, tooltip: { show: false }, data: width });
      }
    }

    var preClose = rt.index.preClose || 0;
    if (!preClose) {
      var first = (rt.index.price || []).filter(function (v) { return v > 0; })[0];
      preClose = first || 0;
    }
    var range = preClose ? idxAxisRange(preClose, rt.index.price) : null;
    series.push({
      name: '上证指数', type: 'line', yAxisIndex: 1, data: rt.index.price,
      showSymbol: false, silent: true, z: 6,
      lineStyle: { width: 1.4, color: ORANGE }, itemStyle: { color: ORANGE }
    });

    var spikes = detectSpikes(total, minutes, d.fam, rt.groups);
    series.push({
      name: '放量', type: 'scatter', yAxisIndex: 0, z: 8,
      symbolSize: 15,
      itemStyle: { color: 'rgba(255,255,255,.15)', borderColor: RED, borderWidth: 1.4 },
      label: {
        show: true, position: 'top', distance: 4,
        color: RED, fontSize: 10,
        formatter: function (p) { return p.data && p.data.ratio ? '×' + p.data.ratio.toFixed(1) : ''; }
      },
      data: spikes.map(function (s) {
        return { value: [s.t, +s.v.toFixed(2)], ratio: s.ratio, fam: s.fam };
      })
    });

    var idxMap = {};
    minutes.forEach(function (t, i) { idxMap[t] = i; });

    return {
      animation: false,
      grid: gridBase(),
      legend: { top: 4, left: 8, itemWidth: 10, itemHeight: 8, textStyle: { fontSize: 11 } },
      tooltip: Object.assign({}, baseTooltip, {
        formatter: function (ps) {
          var key = ps[0] && ps[0].axisValue;
          var i = idxMap[key];
          if (i == null) return key;
          var lines = ['<b>' + key + '</b>'];
          if (S.mode === 'total') {
            lines.push('33只合计：<b>' + FMT(total[i]) + '</b> 亿');
          } else {
            rt.groups.forEach(function (g) {
              if (d.fam[g.name][i] > 0) lines.push(g.name + '：' + FMT(d.fam[g.name][i]) + ' 亿');
            });
            lines.push('合计：<b>' + FMT(total[i]) + '</b> 亿');
          }
          var p = rt.index.price[i];
          if (preClose && p) lines.push('上证指数：' + p.toFixed(2) + '（' + ((p / preClose - 1) * 100).toFixed(2) + '%）');
          var k = slotAt(offsetOf(key));
          if (st && st.med[k] != null) {
            lines.push('同刻中位 ' + FMT(st.med[k]) + ' · P90 ' + FMT(st.p90[k]) + '（亿/分钟）');
          }
          spikes.forEach(function (s) {
            if (s.i === i) lines.push('<span style="color:' + RED + '">放量 ×' + s.ratio.toFixed(1) + ' · 主导 ' + s.fam + '</span>');
          });
          return lines.join('<br>');
        }
      }),
      xAxis: {
        type: 'category', data: minutes, boundaryGap: true,
        axisLine: { lineStyle: { color: '#dfe6f1' } },
        axisLabel: { color: '#667', fontSize: 10, interval: Math.max(1, Math.floor(minutes.length / 12)) },
        axisTick: { show: false }
      },
      yAxis: [
        {
          type: 'value', name: '亿', nameTextStyle: { color: '#889', fontSize: 11 },
          splitLine: { lineStyle: { color: '#f0f2f5' } },
          axisLabel: { color: '#667', fontSize: 10 }
        },
        {
          type: 'value', name: '上证', nameTextStyle: { color: '#889', fontSize: 11 },
          min: range ? range.min : 'dataMin',
          max: range ? range.max : 'dataMax',
          splitLine: { show: false },
          axisLabel: { color: '#a99', fontSize: 10, formatter: function (v) { return v.toFixed(0); } }
        }
      ],
      dataZoom: [
        { type: 'inside', start: 0, end: 100 },
        { type: 'slider', height: 16, bottom: 12, borderColor: 'transparent',
          backgroundColor: '#f7f8fa', fillerColor: 'rgba(26,60,110,.10)',
          handleStyle: { color: INK }, textStyle: { color: '#889', fontSize: 10 } }
      ],
      series: series
    };
  }

  /* ── 图 1：跨日（3/5/10/15） ── */
  function optionMainHist(nDays) {
    var h = S.hist;
    var idxs = [];
    for (var i = Math.max(0, h.days.length - nDays); i < h.days.length; i++) idxs.push(i);
    var x = [], boundary = [];
    idxs.forEach(function (di) {
      var day = h.days[di];
      h.bars.forEach(function (b, bi) {
        x.push(day.slice(5) + ' ' + b);
        if (bi === 0 && x.length > 1) boundary.push(day.slice(5) + ' ' + b);
      });
    });

    var series = [];
    if (S.mode === 'total') {
      series.push({
        name: '5分钟合计', type: 'bar', barMaxWidth: 8,
        itemStyle: { color: INK, borderRadius: [2, 2, 0, 0] },
        data: idxs.reduce(function (acc, di) { return acc.concat(h.total5[di].map(function (v) { return +v.toFixed(2); })); }, [])
      });
    } else {
      Object.keys(h.fam5).forEach(function (name) {
        var color = (S.rt.groups.filter(function (g) { return g.name === name; })[0] || {}).color || '#888';
        series.push({
          name: name, type: 'bar', stack: 'amt', barMaxWidth: 8, itemStyle: { color: color },
          data: idxs.reduce(function (acc, di) { return acc.concat(h.fam5[name][di].map(function (v) { return +v.toFixed(2); })); }, [])
        });
      });
    }
    var idxSeries = idxs.reduce(function (acc, di) { return acc.concat(h.index5[di]); }, []);
    var valid = idxSeries.filter(function (v) { return v > 0; });
    series.push({
      name: '上证指数', type: 'line', yAxisIndex: 1, data: idxSeries, showSymbol: false, z: 6,
      lineStyle: { width: 1.2, color: ORANGE }, itemStyle: { color: ORANGE },
      markLine: {
        silent: true, symbol: 'none',
        lineStyle: { color: '#cfd6e0', width: 1, type: 'dashed' },
        label: { show: false },
        data: boundary.map(function (b) { return { xAxis: b }; })
      }
    });

    return {
      animation: false,
      grid: gridBase(),
      legend: { top: 4, left: 8, itemWidth: 10, itemHeight: 8, textStyle: { fontSize: 11 } },
      tooltip: Object.assign({}, baseTooltip, {
        formatter: function (ps) {
          var head = '<b>' + (ps[0] ? ps[0].axisValue : '') + '</b>';
          var lines = [head];
          ps.forEach(function (p) {
            if (p.seriesName === '放量' || p.value == null) return;
            lines.push(p.marker + p.seriesName + '：' + FMT(p.value) + (p.seriesName === '上证指数' ? '' : ' 亿'));
          });
          return lines.join('<br>');
        }
      }),
      xAxis: {
        type: 'category', data: x, boundaryGap: true,
        axisLine: { lineStyle: { color: '#dfe6f1' } },
        axisLabel: {
          color: '#667', fontSize: 10,
          interval: function (idx) { return x[idx].indexOf('09:35') >= 0; },
          formatter: function (v) { return v.slice(6); }
        },
        axisTick: { show: false }
      },
      yAxis: [
        { type: 'value', name: '亿', nameTextStyle: { color: '#889', fontSize: 11 },
          splitLine: { lineStyle: { color: '#f0f2f5' } }, axisLabel: { color: '#667', fontSize: 10 } },
        { type: 'value', name: '上证', nameTextStyle: { color: '#889', fontSize: 11 },
          min: valid.length ? Math.min.apply(null, valid) : undefined,
          max: valid.length ? Math.max.apply(null, valid) : undefined,
          splitLine: { show: false }, axisLabel: { color: '#a99', fontSize: 10, formatter: function (v) { return v.toFixed(0); } } }
      ],
      dataZoom: [
        { type: 'inside' },
        { type: 'slider', height: 16, bottom: 12, borderColor: 'transparent',
          backgroundColor: '#f7f8fa', fillerColor: 'rgba(26,60,110,.10)',
          handleStyle: { color: INK }, textStyle: { color: '#889', fontSize: 10 } }
      ],
      series: series
    };
  }

  /* ── 图 2a：族结构 100% 堆叠 ── */
  function optionShare() {
    var rt = S.rt, d = derive(rt), total = d.total;
    var series = rt.groups.map(function (g) {
      return {
        name: g.name, type: 'bar', stack: 'share', barMaxWidth: 12,
        itemStyle: { color: g.color },
        data: d.fam[g.name].map(function (v, i) {
          return total[i] ? +(v / total[i] * 100).toFixed(2) : 0;
        })
      };
    });
    return {
      animation: false,
      grid: { left: 44, right: 20, top: 28, bottom: 30 },
      legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 8, textStyle: { fontSize: 11 } },
      tooltip: Object.assign({}, baseTooltip, {
        formatter: function (ps) {
          var i = ps[0] ? ps[0].dataIndex : 0;
          var lines = ['<b>' + rt.minutes[i] + '</b>'];
          rt.groups.forEach(function (g) {
            if (d.fam[g.name][i] > 0) {
              lines.push(g.name + '：' + FMT(d.fam[g.name][i]) + ' 亿 · '
                + (total[i] ? (d.fam[g.name][i] / total[i] * 100).toFixed(1) : '0') + '%');
            }
          });
          lines.push('合计：<b>' + FMT(total[i]) + '</b> 亿');
          return lines.join('<br>');
        }
      }),
      xAxis: {
        type: 'category', data: rt.minutes, boundaryGap: true,
        axisLine: { lineStyle: { color: '#dfe6f1' } },
        axisLabel: { color: '#667', fontSize: 10, interval: Math.max(1, Math.floor(rt.minutes.length / 6)) },
        axisTick: { show: false }
      },
      yAxis: {
        type: 'value', max: 100, name: '%', nameTextStyle: { color: '#889', fontSize: 11 },
        splitLine: { lineStyle: { color: '#f0f2f5' } },
        axisLabel: { color: '#667', fontSize: 10, formatter: '{value}%' }
      },
      series: series
    };
  }

  /* ── 图 2b：族超额线（今日累计 − 近15日同刻中位累计） ── */
  function optionExcess() {
    var rt = S.rt, h = S.hist;
    var d = derive(rt);
    var di = histDayIdx();
    var hasBase = h && di.length ? true : false;
    var series = rt.groups.map(function (g) {
      var data = [];
      if (hasBase) {
        var medCum = slotCumMedian(di, g.name);
        var run = 0;
        rt.minutes.forEach(function (t, i) {
          run += d.fam[g.name][i] || 0;
          var off = offsetOf(t);
          data.push([off, +(run - interpCum(medCum, off)).toFixed(2)]);
        });
      }
      return {
        name: g.name, type: 'line', showSymbol: false, z: 3,
        lineStyle: { width: 1.6, color: g.color }, itemStyle: { color: g.color },
        data: data
      };
    });
    series.push({
      name: '零线', type: 'line', silent: true, z: 1, data: [],
      markLine: {
        silent: true, symbol: 'none',
        lineStyle: { color: '#c9d2dd', width: 1, type: 'dashed' },
        label: { show: false },
        data: [{ yAxis: 0 }]
      }
    });
    return {
      animation: false,
      grid: { left: 50, right: 20, top: 28, bottom: 30 },
      legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 8, textStyle: { fontSize: 11 } },
      tooltip: Object.assign({}, baseTooltip, {
        axisPointer: { type: 'line', lineStyle: { color: '#c9d2dd' } },
        formatter: function (ps) {
          var off = ps[0] && ps[0].value ? ps[0].value[0] : 0;
          var lines = ['<b>' + timeAt(off) + '</b> · 超额 = 今日累计 − 近15日同刻中位'];
          ps.forEach(function (p) {
            if (!p.value || p.seriesName === '零线') return;
            var v = p.value[1];
            lines.push(p.marker + p.seriesName + '：' + (v > 0 ? '+' : '') + FMT(v) + ' 亿');
          });
          return lines.join('<br>');
        }
      }),
      xAxis: {
        type: 'value', min: 0, max: 240, splitNumber: 6,
        axisLine: { lineStyle: { color: '#dfe6f1' } },
        axisLabel: { color: '#667', fontSize: 10, formatter: function (v) { return timeAt(v); } },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value', name: '亿', nameTextStyle: { color: '#889', fontSize: 11 },
        splitLine: { lineStyle: { color: '#f0f2f5' } },
        axisLabel: { color: '#667', fontSize: 10, formatter: function (v) { return (v > 0 ? '+' : '') + v; } }
      },
      series: series
    };
  }

  /* ── 图 3：日内累计叠加 + 5 日均值带 ── */
  function optionCum() {
    var rt = S.rt, h = S.hist, d = derive(rt);
    var prevDays = h ? h.days.filter(function (day) { return day < rt.date; }) : [];
    var yday = prevDays.length ? prevDays[prevDays.length - 1] : null;

    var cum = [], run = 0;
    rt.minutes.forEach(function (t, i) {
      run += d.total[i] || 0;
      cum.push([offsetOf(t), +run.toFixed(2)]);
    });

    function histCum(di) {
      var run2 = 0, arr = [];
      h.total5[di].forEach(function (v, bi) {
        run2 += v;
        arr.push([offsetOf(h.bars[bi]), +run2.toFixed(2)]);
      });
      return arr;
    }

    var grey = prevDays.map(function (day) {
      return { name: '近15日', type: 'line', showSymbol: false, silent: true, z: 2,
        legendHoverLink: false,
        lineStyle: { width: 1, color: '#9aa3ad', opacity: .35 },
        itemStyle: { color: '#9aa3ad' },
        data: histCum(h.days.indexOf(day)) };
    });

    var base = prevDays.slice(-5);
    var lower = [], width = [];
    if (h) h.bars.forEach(function (b, bi) {
      var vals = base.map(function (day) {
        var di = h.days.indexOf(day), run3 = 0;
        for (var k = 0; k <= bi; k++) run3 += h.total5[di][k] || 0;
        return run3;
      });
      if (!vals.length) return;
      var mean = vals.reduce(function (a, b2) { return a + b2; }, 0) / vals.length;
      var sd = Math.sqrt(vals.reduce(function (a, b2) { return a + (b2 - mean) * (b2 - mean); }, 0) / vals.length);
      lower.push([offsetOf(b), +Math.max(0, mean - sd).toFixed(2)]);
      width.push([offsetOf(b), +(sd * 2).toFixed(2)]);
    });

    var series = grey.slice();
    series.push({
      name: '5日均值带', type: 'line', stack: 'band', showSymbol: false, silent: true, z: 1,
      lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(0,0,0,0)' },
      tooltip: { show: false }, data: lower
    });
    series.push({
      name: '5日均值带', type: 'line', stack: 'band', showSymbol: false, silent: true, z: 1,
      lineStyle: { opacity: 0 },
      areaStyle: { color: 'rgba(26,60,110,.12)' },
      tooltip: { show: false }, data: width
    });
    if (yday) {
      series.push({
        name: '昨日 ' + yday.slice(5), type: 'line', showSymbol: false, z: 4,
        lineStyle: { width: 1.4, color: ORANGE }, itemStyle: { color: ORANGE },
        data: histCum(h.days.indexOf(yday))
      });
    }
    series.push({
      name: '今日', type: 'line', showSymbol: false, z: 5,
      lineStyle: { width: 2.6, color: INK }, itemStyle: { color: INK },
      data: cum
    });

    return {
      animation: false,
      grid: { left: 50, right: 22, top: 30, bottom: 34 },
      legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 8, textStyle: { fontSize: 11 },
        data: ['今日', yday ? '昨日 ' + yday.slice(5) : '昨日', '5日均值带'].concat(
          grey.length ? ['近15日'] : []) },
      tooltip: Object.assign({}, baseTooltip, {
        axisPointer: { type: 'line', lineStyle: { color: '#c9d2dd' } },
        formatter: function (ps) {
          var off = ps[0] ? ps[0].value[0] : 0;
          var lines = ['<b>' + timeAt(off) + '</b>'];
          ps.forEach(function (p) {
            if (p.seriesName === '5日均值带' || p.seriesName === '近15日' || p.value == null) return;
            lines.push(p.marker + p.seriesName + '：' + FMT(p.value[1]) + ' 亿');
          });
          return lines.join('<br>');
        }
      }),
      xAxis: {
        type: 'value', min: 0, max: 240, splitNumber: 6,
        axisLine: { lineStyle: { color: '#dfe6f1' } },
        axisLabel: { color: '#667', fontSize: 10, formatter: function (v) { return timeAt(v); } },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value', name: '亿', nameTextStyle: { color: '#889', fontSize: 11 },
        splitLine: { lineStyle: { color: '#f0f2f5' } },
        axisLabel: { color: '#667', fontSize: 10 }
      },
      series: series
    };
  }

  /* ── 图 4：30 分钟槽 × 近15日热力 ── */
  function optionHeat() {
    var rt = S.rt, h = S.hist;
    if (!h || !h.days || !h.days.length || !h.total5) return null;
    var di = histDayIdx();
    if (!di.length) return null;
    var slots = [];
    for (var s = 0; s < 8; s++) slots.push(timeAt(5 * (6 * s + 5) + 4));
    var yLabels = [], data = [], maxV = 0;
    di.forEach(function (d, ri) {
      var row = h.total5[d], daySum = 0, k;
      for (k = 0; k < row.length; k++) daySum += row[k] || 0;
      yLabels.push(h.days[d].slice(5));
      for (var s2 = 0; s2 < 8; s2++) {
        var v = 0;
        for (k = s2 * 6; k < s2 * 6 + 6 && k < row.length; k++) v += row[k] || 0;
        var val = S.heatMode === 'pct'
          ? (daySum ? +(v / daySum * 100).toFixed(2) : 0)
          : +v.toFixed(1);
        if (val > maxV) maxV = val;
        data.push([s2, ri, val]);
      }
    });
    var todayInHist = h.days.indexOf(rt.date) >= 0;
    if (!todayInHist) {
      var d2 = derive(rt), bySlot = [0, 0, 0, 0, 0, 0, 0, 0], todaySum = 0;
      rt.minutes.forEach(function (t, i) {
        var s30 = Math.min(7, Math.floor(offsetOf(t) / 30));
        var v = d2.total[i] || 0;
        bySlot[s30] += v; todaySum += v;
      });
      if (todaySum > 0) {
        var ri2 = yLabels.length;
        yLabels.push('今日');
        for (var s3 = 0; s3 < 8; s3++) {
          if (!bySlot[s3]) continue;
          var val2 = S.heatMode === 'pct'
            ? +(bySlot[s3] / todaySum * 100).toFixed(2)
            : +bySlot[s3].toFixed(1);
          if (val2 > maxV) maxV = val2;
          data.push({ value: [s3, ri2, val2],
            itemStyle: { borderColor: ORANGE, borderWidth: 1.6 } });
        }
      }
    }
    return {
      animation: false,
      grid: { left: 66, right: 24, top: 14, bottom: 64 },
      tooltip: {
        position: 'top',
        backgroundColor: 'rgba(255,255,255,.97)',
        borderColor: '#dfe6f1',
        textStyle: { color: '#222', fontSize: 12 },
        extraCssText: 'box-shadow:0 4px 18px rgba(20,40,80,.10);border-radius:8px;',
        formatter: function (p) {
          if (!p.value) return '';
          var v = p.value[2];
          return '<b>' + (yLabels[p.value[1]] || '') + '</b> · ' + slots[p.value[0]]
            + '<br>' + (S.heatMode === 'pct' ? '占当日 ' + v.toFixed(2) + '%' : '合计 ' + FMT(v) + ' 亿');
        }
      },
      xAxis: {
        type: 'category', data: slots,
        splitArea: { show: true },
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#667', fontSize: 10 }
      },
      yAxis: {
        type: 'category', data: yLabels,
        splitArea: { show: true },
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#667', fontSize: 10 }
      },
      visualMap: {
        min: 0, max: maxV || 1, calculable: true, orient: 'horizontal',
        left: 'center', bottom: 2, itemWidth: 12, itemHeight: 56,
        textStyle: { fontSize: 10, color: '#889' },
        inRange: { color: ['#eef3fa', '#a9c5e1', '#e8a06a', '#c0392b'] }
      },
      series: [{
        name: '30分钟槽', type: 'heatmap', data: data,
        label: { show: true, fontSize: 9, color: 'rgba(30,30,30,.72)',
          formatter: function (p) {
            return S.heatMode === 'pct' ? p.value[2].toFixed(1)
              : p.value[2] >= 10 ? String(Math.round(p.value[2])) : p.value[2].toFixed(1);
          } },
        itemStyle: { borderColor: '#fff', borderWidth: 1, borderRadius: 3 },
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,.25)' } }
      }]
    };
  }

  /* ── 渲染：KPI ── */
  function renderKpis() {
    var rt = S.rt, d = derive(rt), total = d.total;
    var sum = total.reduce(function (a, b) { return a + (b || 0); }, 0);
    var last = lastIndex(total);
    var peak = 0, peakAt = -1;
    total.forEach(function (v, i) { if (v > peak) { peak = v; peakAt = i; } });

    $('kpiTotal').textContent = FMT(sum, 1);
    $('kpiTotalSub').textContent = rt.yestTotal
      ? '昨日全天 ' + FMT(rt.yestTotal, 1) + ' 亿 · ' + rt.minutes.length + ' 个分钟'
      : rt.minutes.length + ' 个分钟';

    if (last >= 0) {
      $('kpiLast').textContent = FMT(total[last], 1);
      $('kpiLastSub').textContent = rt.minutes[last] + ' · 占今日 '
        + (sum ? (total[last] / sum * 100).toFixed(1) : '0') + '%';
    }

    if (peakAt >= 0) {
      var lead = '', leadV = 0;
      rt.groups.forEach(function (g) {
        if (d.fam[g.name][peakAt] > leadV) { leadV = d.fam[g.name][peakAt]; lead = g.name; }
      });
      $('kpiPeak').textContent = FMT(peak, 1);
      $('kpiPeakSub').textContent = rt.minutes[peakAt] + ' · 主导 ' + lead;
    }

    /* 领投族 */
    var famSum = rt.groups.map(function (g) {
      var s = 0;
      d.fam[g.name].forEach(function (v) { s += v || 0; });
      return { name: g.name, sum: s };
    }).sort(function (a, b) { return b.sum - a.sum; });
    if (famSum.length && famSum[0].sum > 0) {
      $('kpiFam').textContent = famSum[0].name;
      $('kpiFamSub').textContent = '累计 ' + FMT(famSum[0].sum) + ' 亿 · 占 '
        + (sum ? (famSum[0].sum / sum * 100).toFixed(0) : '--') + '%';
    }

    /* 同刻分位（vs 近15日） */
    var p0 = latestPct();
    S.p0 = p0;
    var el0 = $('kpiP0');
    if (p0) {
      el0.textContent = 'P' + Math.round(p0.rank);
      el0.className = p0.rank >= 90 ? 'up' : p0.rank <= 10 ? 'down' : '';
      $('kpiP0Sub').textContent = rt.minutes[p0.i] + ' 分钟 · 中位 ' + FMT(p0.med)
        + ' · P90 ' + FMT(p0.p90);
    } else {
      el0.textContent = '--';
      el0.className = '';
      $('kpiP0Sub').textContent = S.hist ? '跨日样本不足（需 ≥5 日）' : '跨日数据未加载';
    }
  }

  function renderAlerts() {
    var rt = S.rt, d = derive(rt);
    var shifts = detectShifts(d.total, rt.minutes, d.fam, rt.groups);
    var box = $('alerts');
    box.innerHTML = '';
    shifts.forEach(function (s) {
      var el = document.createElement('div');
      el.className = 'alert';
      el.textContent = s.fam + ' 占比 ' + s.from.toFixed(0) + '%→' + s.to.toFixed(0)
        + '% · ' + s.t + ' · 近10分钟 ' + FMT(s.amt) + ' 亿';
      el.addEventListener('click', function () {
        var chart = S.charts.chartMain;
        if (!chart || S.view !== 'today') return;
        chart.dispatchAction({ type: 'dataZoom', startValue: Math.max(0, s.i - 30), endValue: Math.min(rt.minutes.length - 1, s.i + 15) });
      });
      box.appendChild(el);
    });
  }

  function renderStatus() {
    var rt = S.rt;
    if (!rt) {
      $('badgeClock').textContent = S.error || '加载中…';
      $('badgeClock').className = 'badge warn';
      return;
    }
    var phase = rt.phase === 'intraday' ? '盘中' : rt.phase === 'preopen' ? '未开盘' : '已收盘';
    var ph = $('badgePhase');
    ph.textContent = phase + ' · ' + rt.date.slice(5);
    ph.className = 'badge ' + (rt.phase === 'intraday' ? 'ok' : '');

    var src = $('badgeSource');
    if (!rt.live) { src.textContent = '静态兜底快照'; src.className = 'badge warn'; }
    else {
      src.textContent = '直连 · ' + (rt.source === 'em' ? '东财主源' : '腾讯备源');
      src.className = 'badge ok';
    }

    var on = $('badgeOnline');
    on.textContent = '在线 ' + rt.online + '/' + rt.totalEtfs;
    on.className = 'badge ' + (rt.online >= rt.totalEtfs ? 'ok' : rt.online >= rt.totalEtfs * .7 ? 'warn' : 'bad');

    if (S.error) {
      $('badgeClock').textContent = S.error;
      $('badgeClock').className = 'badge bad';
      return;
    }
    var age = Math.max(0, Math.round((Date.now() - new Date(rt.updated).getTime()) / 1000));
    var cls = age > 600 ? 'bad' : age > 180 ? 'warn' : 'ok';
    var lag = (rt.phase === 'intraday' && age > 180) ? ' · 滞后 ' + Math.round(age / 60) + ' 分钟' : '';
    $('badgeClock').textContent = rt.updated.slice(11, 19) + ' · ' + S.cd + 's 后刷新' + lag;
    $('badgeClock').className = 'badge ' + (rt.phase === 'intraday' ? cls : '');
  }

  /* ── 单只 ETF 表 ── */
  function sparkSvg(vals, color) {
    var n = vals ? vals.length : 0;
    if (n < 2) return '<span style="color:#bbb">--</span>';
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < n; i++) {
      var v = vals[i];
      if (v == null || isNaN(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === Infinity) return '<span style="color:#bbb">--</span>';
    var rng = max - min || 1;
    var pts = [];
    vals.forEach(function (v, i2) {
      if (v == null || isNaN(v)) return;
      pts.push((i2 / (n - 1) * 106 + 2).toFixed(1) + ',' + (24 - (v - min) / rng * 21 + 1).toFixed(1));
    });
    return '<svg width="110" height="26" style="vertical-align:middle">'
      + '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + color
      + '" stroke-width="1.3"/></svg>';
  }

  function renderEtfTable() {
    var rt = S.rt, d = derive(rt);
    var sum = d.total.reduce(function (a, b) { return a + (b || 0); }, 0);
    var rows = [];
    rt.groups.forEach(function (g) {
      g.etfs.forEach(function (sec) {
        var e = rt.etf[sec];
        if (!e) return;
        var amt = 0;
        e.amt.forEach(function (v) { amt += v || 0; });
        var px = e.px || [];
        var f = px.filter(function (v) { return v > 0; });
        var chg = f.length >= 2 ? (f[f.length - 1] / f[0] - 1) * 100 : null;
        rows.push({ sec: sec, name: e.name || sec, fam: g.name, color: g.color,
          amt: amt, chg: chg, px: px });
      });
    });
    rows.sort(function (a, b) { return b.amt - a.amt; });
    $('etfBody').innerHTML = rows.map(function (r) {
      var chgTxt = r.chg == null ? '--' : (r.chg > 0 ? '+' : '') + r.chg.toFixed(2) + '%';
      var chgCls = r.chg == null ? '' : r.chg > 0 ? 'chg-up' : r.chg < 0 ? 'chg-down' : '';
      var sparkColor = r.chg != null && r.chg < 0 ? '#1f8a70' : '#c0392b';
      return '<tr>'
        + '<td>' + r.sec.split('.')[1] + ' ' + r.name + '</td>'
        + '<td><span class="famdot" style="background:' + r.color + '"></span>' + r.fam + '</td>'
        + '<td><b>' + FMT(r.amt) + '</b></td>'
        + '<td>' + (sum ? (r.amt / sum * 100).toFixed(1) : '--') + '%</td>'
        + '<td class="' + chgCls + '">' + chgTxt + '</td>'
        + '<td>' + sparkSvg(r.px, sparkColor) + '</td>'
        + '</tr>';
    }).join('');
    $('etfFoot').textContent = '共 ' + rows.length + ' 只 · 涨跌 = 现价 / 开盘价 − 1（静态快照无分钟价，此列显示 --）';
  }

  function renderFoots() {
    var rt = S.rt, h = S.hist;
    $('mainHint').textContent = S.view === 'today'
      ? '柱 = 33 只当分钟合计（亿元）· 蓝带 = 近15日同刻中位–P90 · 线 = 上证指数（右轴，昨收居中）'
      : '5 分钟粒度 · 竖虚线 = 天分隔 · 悬停看当日明细';

    if (S.view === 'today') {
      $('mainFoot').textContent = '口径：09:31 首根含集合竞价 · 数据 ' + rt.updated.slice(11, 19)
        + ' · 源 ' + (!rt.live ? '静态兜底 data/*.json'
          : rt.source === 'em' ? '东财 push2his（浏览器直连）' : '腾讯 ifzq（直连备源）')
        + ' · 在线 ' + rt.online + '/' + rt.totalEtfs + ' 只';
      if (S.shareMode === 'share') {
        $('shareHint').textContent = '每分钟 7 族成交额占比 100% 堆叠 · 占比抬升 = 该族相对发力';
        $('shareFoot').textContent = '占比 = 该分钟族成交额 / 33 只当分钟合计 · 悬停看各族绝对额';
      } else {
        var di0 = histDayIdx();
        $('shareHint').textContent = '各族今日累计 − 近15日同刻中位累计 · 零线上方 = 相对历史更发力';
        $('shareFoot').textContent = h && di0.length
          ? '中位基准来自 ' + di0.length + ' 个交易日（5 分钟槽累计，槽内线性插值）'
          : '族超额需要跨日数据（直连历史或 data/hist.json）';
      }
      $('cumFoot').textContent = h
        ? '灰线 ' + Math.max(0, h.days.filter(function (day) { return day < rt.date; }).length)
          + ' 个交易日（5 分钟粒度）· 蓝带 = 前 5 日均值 ±1σ'
        : '跨日数据未加载';
    } else {
      if (!h) { $('mainFoot').textContent = '跨日数据未加载'; return; }
      var n = S.view === 'd3' ? 3 : S.view === 'd5' ? 5 : S.view === 'd10' ? 10 : 15;
      var idxs = [];
      for (var i = Math.max(0, h.days.length - n); i < h.days.length; i++) idxs.push(i);
      $('mainFoot').textContent = '每日合计（亿）：' + idxs.map(function (di) {
        return h.days[di].slice(5) + ' ' + FMT(h.dailyTotal[di]);
      }).join(' · ');
      $('shareFoot').textContent = '族结构仅在「今日」视图可用（跨日为聚合额）';
      $('cumFoot').textContent = '切回「今日」查看日内累计叠加';
    }

    if (h && h.days && h.days.length) {
      var di2 = histDayIdx();
      $('heatFoot').textContent = '槽 = 30 分钟（标注为槽尾时刻）· 覆盖 ' + di2.length + ' 个交易日'
        + (h.approx ? ' · 腾讯 m5 备源近似（额 = 收盘价 × 量 × 100）' : '')
        + ' · 橙框行 = 今日（仅已完成槽）';
    } else {
      $('heatFoot').textContent = '跨日数据未加载，热力图待跨日数据就绪';
    }
  }

  /* ── 盘后封存（localStorage，滚动约 60 日） ── */
  function seals() {
    try { return JSON.parse(localStorage.getItem('ntetf_seals') || '[]'); }
    catch (e) { return []; }
  }
  function saveSeals(arr) {
    try { localStorage.setItem('ntetf_seals', JSON.stringify(arr.slice(-60))); } catch (e) { }
  }
  function maybeSeal() {
    var rt = S.rt;
    if (S.src !== 'live' || !rt || rt.live !== true) return;
    if (rt.phase !== 'closed' || !rt.minutes || rt.minutes.length < 200) return;
    if (S.sealing) return;
    if (seals().some(function (x) { return x.date === rt.date; })) return;
    if (!window.LiveData || !LiveData.sealToday) return;
    S.sealing = true;
    Promise.resolve(LiveData.sealToday(rt)).then(function (rec) {
      S.sealing = false;
      if (!rec || !rec.date) return;
      var arr = seals();
      arr.push(rec);
      saveSeals(arr);
      renderSeal();
    }).catch(function () { S.sealing = false; });
  }
  function renderSeal() {
    var arr = seals();
    var rt = S.rt;
    var st = $('sealStatus');
    if (rt) {
      var today = arr.filter(function (x) { return x.date === rt.date; })[0];
      if (today) {
        var chk = today.dayKTotal != null
          ? ' · 日K ' + FMT(today.dayKTotal) + ' 亿 · 差 '
            + (today.diffPct >= 0 ? '+' : '') + today.diffPct.toFixed(2) + '%'
          : ' · 日K核对不可用';
        st.innerHTML = '今日 ' + today.date + ' 已封存：合计 <b>' + FMT(today.total)
          + '</b> 亿（' + today.minutes + ' 分钟）' + chk;
      } else if (rt.phase === 'closed') {
        st.textContent = '今日 ' + rt.date + ' 已收盘，封存将在直连数据就绪后自动进行（需直连模式）';
      } else {
        st.textContent = '收盘后自动封存当日合计并与东财日 K 核对（直连模式下进行，存浏览器本地）';
      }
    }
    var list = arr.slice(-8).reverse();
    $('sealList').innerHTML = list.map(function (x) {
      var d = x.diffPct;
      var chk = d == null
        ? '<span style="color:var(--warn)">日K缺失</span>'
        : '<span style="color:' + (Math.abs(d) <= 2 ? 'var(--good)' : 'var(--warn)')
          + '">差 ' + (d >= 0 ? '+' : '') + d.toFixed(2) + '%</span>';
      return '<div class="seal-row"><b>' + x.date + '</b>'
        + '<span>合计 ' + FMT(x.total) + ' 亿 · ' + (x.minutes || 240) + ' 分钟</span>'
        + (x.dayKTotal != null ? '<span>日K ' + FMT(x.dayKTotal) + ' 亿</span>' : '')
        + '<span>' + chk + '</span>'
        + (x.savedAt ? '<span>' + x.savedAt.slice(11, 19) + '</span>' : '')
        + '</div>';
    }).join('');
    if (!arr.length) $('sealList').innerHTML = '<div class="seal-row">暂无封存记录</div>';
  }
  function exportSeals() {
    var arr = seals();
    var payload = { exportedAt: new Date().toISOString(), board: 'national-team-etf-rt', seals: arr };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ntetf-seals-' + (S.rt ? S.rt.date : 'all') + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  /* ── 标题闪烁：最新分钟超 P90 ── */
  function renderTitle() {
    var hot = S.p90flash && S.rt && S.rt.phase === 'intraday' && S.p0 && S.p0.rank >= 90;
    if (!hot) {
      if (document.title !== BASE_TITLE) document.title = BASE_TITLE;
      S.flashOn = false;
      return;
    }
    S.flashOn = !S.flashOn;
    document.title = S.flashOn ? '🔴⚠️ 放量超P90 · 国家队ETF' : BASE_TITLE;
  }

  /* ── 总渲染 ── */
  function render() {
    if (!S.rt) return;
    renderKpis();
    renderAlerts();
    renderStatus();
    renderFoots();
    renderTitle();
    renderSeal();
    var main = chartOf($('chartMain'));
    if (S.view === 'today') {
      main.setOption(optionMainToday(), true);
      chartOf($('chartShare')).setOption(S.shareMode === 'share' ? optionShare() : optionExcess(), true);
      chartOf($('chartCum')).setOption(optionCum(), true);
    } else {
      if (!S.hist) { S.view = 'today'; render(); return; }
      var n = S.view === 'd3' ? 3 : S.view === 'd5' ? 5 : S.view === 'd10' ? 10 : 15;
      main.setOption(optionMainHist(n), true);
      chartOf($('chartShare')).clear();
      chartOf($('chartCum')).clear();
    }
    var heat = optionHeat();
    var chHeat = chartOf($('chartHeat'));
    if (heat) chHeat.setOption(heat, true); else chHeat.clear();
    renderEtfTable();
  }

  /* ── 数据加载：直连优先，静态兜底 ── */
  function getJSON(url) {
    return fetch(url + '?v=' + Date.now(), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
      return r.json();
    });
  }

  function loadStatic(forceHist) {
    var wantHist = forceHist || !S.hist || (Date.now() - S.histLoadedAt > 600000);
    return Promise.all([
      getJSON('./data/rt.json'),
      wantHist ? getJSON('./data/hist.json') : Promise.resolve(S.hist)
    ]).then(function (res) {
      S.rt = res[0];
      S.rt.live = false;
      if (res[1]) { S.hist = res[1]; S.histLoadedAt = Date.now(); }
      S.error = '';
      S.cd = S.rt.phase === 'intraday' ? 60 : 300;
      render();
    });
  }

  function load(forceHist) {
    if (S.src !== 'live' || typeof window.LiveData === 'undefined') {
      return loadStatic(forceHist).catch(function (err2) {
        S.error = '数据加载失败：' + (err2 && err2.message ? err2.message : err2);
        renderStatus();
        console.error(err2);
      });
    }
    return LiveData.load().then(function (res) {
      S.rt = res.rt;
      S.error = '';
      S.cd = S.rt.phase === 'intraday' ? 60 : 300;
      render();
      maybeSeal();
      if (res.histPromise) {
        return res.histPromise.then(function (h) {
          if (h) { S.hist = h; S.histLoadedAt = Date.now(); }
          render();
        });
      }
    }).catch(function (err) {
      console.warn('直连失败，落静态兜底：', err);
      return loadStatic(forceHist).catch(function (err2) {
        S.error = '数据加载失败：' + (err2 && err2.message ? err2.message : err2);
        renderStatus();
        console.error(err2);
      });
    });
  }

  function tick() {
    if (S.paused || document.hidden) return;
    S.cd -= 1;
    if (S.cd <= 0) { S.cd = S.rt && S.rt.phase === 'intraday' ? 60 : 300; load(false); }
    if (S.rt) { renderStatus(); renderTitle(); }
  }

  function segBind(id, attr, fn) {
    $(id).addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      Array.prototype.forEach.call(this.querySelectorAll('button'), function (b) { b.classList.remove('on'); });
      btn.classList.add('on');
      fn(btn.getAttribute(attr));
    });
  }

  function bind() {
    segBind('segView', 'data-view', function (v) { S.view = v; render(); });
    segBind('segMode', 'data-mode', function (m) { S.mode = m; render(); });
    segBind('segShare', 'data-share', function (m) { S.shareMode = m; render(); });
    segBind('segHeat', 'data-heat', function (m) { S.heatMode = m; render(); });
    $('chkP90').addEventListener('change', function () {
      S.p90flash = this.checked;
      try { localStorage.setItem('ntetf_p90flash', S.p90flash ? '1' : '0'); } catch (e) { }
      if (!S.p90flash) { S.flashOn = false; document.title = BASE_TITLE; }
    });
    $('btnSealExport').addEventListener('click', exportSeals);
    $('badgeClock').style.cursor = 'pointer';
    $('badgeClock').title = '点击立即刷新';
    $('badgeClock').addEventListener('click', function () { S.cd = 0; load(true); });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { S.cd = Math.min(S.cd, 5); }
    });
    window.addEventListener('resize', function () {
      Object.keys(S.charts).forEach(function (k) { S.charts[k].resize(); });
    });
  }

  /* ── 初始化 ── */
  var URLSRC = '';
  try { URLSRC = new URLSearchParams(location.search).get('src') || ''; } catch (e) { }
  S.src = (URLSRC === 'static' || typeof window.LiveData === 'undefined') ? 'static' : 'live';
  try { S.p90flash = localStorage.getItem('ntetf_p90flash') === '1'; } catch (e) { }

  document.addEventListener('DOMContentLoaded', function () {
    $('chkP90').checked = S.p90flash;
    bind();
    load(true).then(function () {
      S.timer = setInterval(tick, 1000);
    });
  });
})();
