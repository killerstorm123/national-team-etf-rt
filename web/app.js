/* 国家队 ETF 分钟成交额实时看板 · 前端渲染
   数据契约见 README：data/rt.json（60s 快照）+ data/hist.json（15 日 5 分钟聚合） */
(function () {
  'use strict';

  var S = { rt: null, hist: null, view: 'today', mode: 'total', charts: {}, timer: null,
            cd: 60, paused: false, histLoadedAt: 0, error: '' };
  var $ = function (id) { return document.getElementById(id); };
  var INK = '#1a3c6e', ORANGE = '#e07b39', RED = '#c0392b';
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

  /* ── 图 1：今日 ── */
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

  /* ── 图 1：跨日（3/5/10/15）── */
  function optionMainHist(nDays) {
    var h = S.hist;
    var idxs = [];
    for (var i = Math.max(0, h.days.length - nDays); i < h.days.length; i++) idxs.push(i);
    var x = [], boundary = [], dayLabels = [];
    idxs.forEach(function (di) {
      var day = h.days[di];
      h.bars.forEach(function (b, bi) {
        x.push(day.slice(5) + ' ' + b);
        if (bi === 0 && x.length > 1) boundary.push(day.slice(5) + ' ' + b);
      });
      dayLabels.push(day.slice(5) + ' · ' + FMT(h.dailyTotal[di]) + '亿');
    });

    var series = [];
    if (S.mode === 'total') {
      series.push({
        name: '5分钟合计', type: 'bar', barMaxWidth: 8,
        itemStyle: { color: INK, borderRadius: [2, 2, 0, 0] },
        data: idxs.reduce(function (acc, di) { return acc.concat(h.total5[di].map(function (v) { return +v.toFixed(2); })); }, [])
      });
    } else {
      var keys = Object.keys(h.fam5);
      keys.forEach(function (name) {
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
          interval: function (idx) {
            var v = x[idx];
            return v.indexOf('09:35') >= 0;
          },
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

  /* ── 图 2：族结构 100% 堆叠 ── */
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

  /* ── 图 3：日内累计叠加 + 5 日均值带 ── */
  function optionCum() {
    var rt = S.rt, h = S.hist, d = derive(rt);
    var prevDays = h ? h.days.filter(function (day) { return day < rt.date; }) : [];
    var yday = prevDays.length ? prevDays[prevDays.length - 1] : null;

    /* 今日：1 分钟累计 */
    var cum = [], run = 0;
    rt.minutes.forEach(function (t, i) {
      run += d.total[i] || 0;
      cum.push([offsetOf(t), +run.toFixed(2)]);
    });

    /* 历史日：5 分钟累计 */
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

    /* 5 日均值 ±1σ 带 */
    var base = prevDays.slice(-5);
    var lower = [], width = [];
    h && h.bars.forEach(function (b, bi) {
      var vals = base.map(function (day) {
        var di = h.days.indexOf(day), run3 = 0;
        for (var k = 0; k <= bi; k++) run3 += h.total5[di][k];
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
        trigger: 'axis',
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

  /* ── 渲染 ── */
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
      $('kpiLastSub').textContent = rt.minutes[last] + ' · 占今日 ' + (sum ? (total[last] / sum * 100).toFixed(1) : '0') + '%';
    }

    if (peakAt >= 0) {
      var lead = '', leadV = 0;
      rt.groups.forEach(function (g) {
        if (d.fam[g.name][peakAt] > leadV) { leadV = d.fam[g.name][peakAt]; lead = g.name; }
      });
      $('kpiPeak').textContent = FMT(peak, 1);
      $('kpiPeakSub').textContent = rt.minutes[peakAt] + ' · 主导 ' + lead;
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
        if (!chart) return;
        if (S.view === 'today') {
          chart.dispatchAction({ type: 'dataZoom', startValue: Math.max(0, s.i - 30), endValue: Math.min(rt.minutes.length - 1, s.i + 15) });
        }
      });
      box.appendChild(el);
    });
  }

  function renderFoots() {
    var rt = S.rt, h = S.hist;
    $('mainHint').textContent = S.view === 'today'
      ? '柱 = 33 只当分钟合计（亿元）· 线 = 上证指数（右轴，昨收居中）· 圆圈 = 放量分钟（前 20 分钟中位数 ×2.5 或 均值+3σ）'
      : '5 分钟粒度 · 竖虚线 = 天分隔 · 底部脚注为每日合计（东财 klt=5 精确额）';

    if (S.view === 'today') {
      $('mainFoot').textContent = '口径：09:31 首根含集合竞价 · 数据 ' + rt.updated.slice(11, 19)
        + ' · 源 ' + (rt.source === 'em' ? '东财 push2his' : '腾讯 ifzq（备源）')
        + ' · 在线 ' + rt.online + '/' + rt.totalEtfs + ' 只';
      $('shareFoot').textContent = '占比 = 该分钟族成交额 / 33 只当分钟合计 · 悬停看各族绝对额';
      $('cumFoot').textContent = h ? '灰线 ' + Math.max(0, h.days.length - 1) + ' 个交易日（5 分钟粒度）· 蓝带 = 前 5 日均值 ±1σ' : '跨日数据未加载';
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
  }

  function renderStatus() {
    var rt = S.rt;
    var phase = rt.phase === 'intraday' ? '盘中' : rt.phase === 'preopen' ? '未开盘' : '已收盘';
    var ph = $('badgePhase');
    ph.textContent = phase + ' · ' + rt.date.slice(5);
    ph.className = 'badge ' + (rt.phase === 'intraday' ? 'ok' : '');

    var src = $('badgeSource');
    src.textContent = rt.source === 'em' ? '东财主源' : '腾讯备源';
    src.className = 'badge ' + (rt.source === 'em' ? 'ok' : 'warn');

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

  function render() {
    if (!S.rt) return;
    renderKpis();
    renderAlerts();
    renderStatus();
    renderFoots();
    var main = chartOf($('chartMain'));
    if (S.view === 'today') {
      main.setOption(optionMainToday(), true);
      chartOf($('chartShare')).setOption(optionShare(), true);
      chartOf($('chartCum')).setOption(optionCum(), true);
    } else {
      if (!S.hist) { S.view = 'today'; render(); return; }
      var n = S.view === 'd3' ? 3 : S.view === 'd5' ? 5 : S.view === 'd10' ? 10 : 15;
      main.setOption(optionMainHist(n), true);
      chartOf($('chartShare')).clear();
      chartOf($('chartCum')).clear();
    }
  }

  /* ── 数据加载与轮询 ── */
  function getJSON(url) {
    return fetch(url + '?v=' + Date.now(), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
      return r.json();
    });
  }

  function load(forceHist) {
    var now = Date.now();
    var wantHist = forceHist || !S.hist || (now - S.histLoadedAt > 600000);
    return Promise.all([
      getJSON('./data/rt.json'),
      wantHist ? getJSON('./data/hist.json') : Promise.resolve(S.hist)
    ]).then(function (res) {
      S.rt = res[0];
      if (res[1]) { S.hist = res[1]; S.histLoadedAt = Date.now(); }
      S.error = '';
      S.cd = S.rt.phase === 'intraday' ? 60 : 300;
      render();
    }).catch(function (err) {
      S.error = '数据加载失败：' + (err && err.message ? err.message : err);
      renderStatus();
      console.error(err);
    });
  }

  function tick() {
    if (S.paused || document.hidden) return;
    S.cd -= 1;
    if (S.cd <= 0) { S.cd = S.rt && S.rt.phase === 'intraday' ? 60 : 300; load(false); }
    if (S.rt) renderStatus();
  }

  function bind() {
    $('segView').addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      Array.prototype.forEach.call(this.querySelectorAll('button'), function (b) { b.classList.remove('on'); });
      btn.classList.add('on');
      S.view = btn.getAttribute('data-view');
      render();
    });
    $('segMode').addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      Array.prototype.forEach.call(this.querySelectorAll('button'), function (b) { b.classList.remove('on'); });
      btn.classList.add('on');
      S.mode = btn.getAttribute('data-mode');
      render();
    });
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

  document.addEventListener('DOMContentLoaded', function () {
    bind();
    load(true).then(function () {
      S.timer = setInterval(tick, 1000);
    });
  });
})();
