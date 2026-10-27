/* ============================================================
   WorkBuddy Token 消耗看板 —— 前端逻辑
   数据来源：本机 WorkBuddy 会话日志（~/.workbuddy/projects/**\/*.jsonl）
   两种读取方式，产出同一份数据结构，下游渲染完全共用：
     A. 本机服务模式：GET /api/scan（服务端只抽取需要的字段，秒开）
     B. 纯浏览器模式：File System Access API 读目录，前端解析（数据不出本机）
   ============================================================ */
(function () {
'use strict';

/* ---------------- 主题色板 ---------------- */
const MC_L = ['#4e7fbc','#c8894a','#59a5a0','#b05a5a','#8172b3','#7a9a4e','#c98ba6','#9aa8bd'];
const MC_D = ['#7aa5d4','#d8a76b','#6cc0ba','#d48080','#a798cf','#9dba6e','#d8a3b8','#aab6c8'];
const RAMP_L = ['#f4f2ed','#e8eef5','#cfddeb','#aec9e0','#88abd0','#5f8cb6','#3f6b99','#2b4f73'];
const RAMP_D = ['#2e2c29','#33404d','#3a4f61','#42607a','#4b6f8f','#5682a6','#6b9abf','#8fb8d9'];
const CJL = {grid:'#f0ede7',axis:'#b5b2a9',axis2:'#c9c6be',dash:'#c9c6be',base:'#d4d1c9',dim:'#c9c6be',
             dimBar:'#e4e1da',other:'#8c8c8c',t1:'#1f2328',muted:'#9a978f'};
const CJD = {grid:'#323029',axis:'#6f6d66',axis2:'#6f6d66',dash:'#55524b',base:'#4a4842',dim:'#55524b',
             dimBar:'#3a3833',other:'#7d8b96',t1:'#f0eee9',muted:'#8a877f'};

// 默认深色；只有用户显式切到浅色（localStorage '0'）时才用浅色
let DARK = true, CJ = CJD, MC = MC_D, RAMP = RAMP_D;
try { if (localStorage.getItem('td-dark') === '0') { DARK = false; CJ = CJL; MC = MC_L; RAMP = RAMP_L; } } catch (e) {}
const modelColor = i => MC[i % MC.length];

/* ---------------- 价目表（元 / 百万 token）----------------
   [输入, 输出, 缓存命中]；仅用于「参考估价」。
   注意：日志里每条请求自带 credit 字段（真实计费），所以估价只是旁证，
   真实花费请以「真实 Credit」为准。匹配用前缀，顺序由具体到宽泛。 */
const PRICE = {
  'deepseek-v4.1-flash':[1,4,0.2], 'deepseek-v4-flash':[1,4,0.2], 'deepseek-v4-pro':[2,8,0.5],
  'deepseek':[2,8,0.5],
  'glm-5.3-flash':[0.8,3.2,0.16], 'glm-5.3':[2,8,0.4], 'glm-5.2':[0.8,3.2,0.16], 'glm':[1,4,0.2],
  'kimi':[1.5,6,0.3], 'minimax':[1,5,0.2], 'm3':[1,5,0.2],
  'hy4':[4,16,0.8], 'hy3':[4,16,0.8], 'hy':[4,16,0.8],
  'claude-opus-5':[150,750,15], 'claude-opus-4-8':[110,550,11], 'claude':[110,550,11],
  'qwen':[2.4,9.6,0.48], 'auto':[2,8,0.4]
};
function priceOf(name) {
  const n = String(name || '').toLowerCase();
  for (const k in PRICE) if (n.indexOf(k) === 0) return PRICE[k];
  return [2, 8, 0.4];
}

/* ---------------- 状态 ---------------- */
let D = null;                       // 数据集
let win = 30, customStart = 0, customEnd = 0;
let wsMult = 3, wsMode = 'ws', wsSort = 'tt', q = '';
let state = { ws: null, ses: null };
let selModel = null, hrSel = null, LASTA = null, MP = [];
let PCTX = null, SHD = new Map();
let genMs = 0, autoTimer = null, serverMode = false;

/* ---------------- 通用工具 ---------------- */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

function fmt(n) {
  n = +n || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return String(Math.round(n));
}
const nf = n => (Math.round(+n) || 0).toLocaleString('en-US');
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function money(n) {
  const v = +n || 0;
  if (v >= 1e4) return '¥' + (v / 1e4).toFixed(2) + ' 万';
  return '¥' + v.toFixed(2);
}
function creditFmt(n) {
  const v = +n || 0;
  if (v >= 1e4) return (v / 1e4).toFixed(2) + ' 万';
  if (v >= 1000) return nf(v);
  return v.toFixed(2);
}
const hm = min => new Date(min * 60000);
const pad2 = x => String(x).padStart(2, '0');
function fdate(d) { return (d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function ftime(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
const cut = () => win ? genMs - win * 86400e3 : (customStart ? customStart * 60000 : 0);
const cutHi = () => (!win && customEnd) ? customEnd * 60000 : Infinity;
const inWin = ts => ts >= cut() && ts < cutHi();

/* ---------------- 日志解析（纯浏览器模式用）----------------
   与 server.py 的抽取逻辑保持一致，字段路径来自实际日志结构。 */
const ALIAS = { 'glm-5.2-x': 'glm-5.2', 'cmcc:auto': 'auto' };
function normModel(raw) {
  let m = String(raw == null ? 'unknown' : raw).trim() || 'unknown';
  let low = m.toLowerCase();
  if (ALIAS[low]) return ALIAS[low];
  if (low.indexOf('tencent/') === 0) { m = m.slice(8); low = m.toLowerCase(); }
  if (low.indexOf(':') >= 0) { m = m.split(':')[0]; low = m.toLowerCase(); }
  return ALIAS[low] || low;
}
const num = (v, d) => { const x = parseFloat(v); return isFinite(x) ? x : (d || 0); };

function grab(rec) {
  const pd = rec.providerData;
  if (!pd || typeof pd !== 'object') return null;
  const ru = (pd.rawUsage && typeof pd.rawUsage === 'object') ? pd.rawUsage : {};
  const u = (pd.usage && typeof pd.usage === 'object') ? pd.usage : {};
  const tt = ru.total_tokens || u.totalTokens;
  if (!tt) return null;
  const ptd = (ru.prompt_tokens_details && typeof ru.prompt_tokens_details === 'object') ? ru.prompt_tokens_details : {};
  let ch = ru.prompt_cache_hit_tokens;
  if (ch == null) ch = ptd.cached_tokens || 0;
  let cw = ru.cache_creation_input_tokens;
  if (!cw) cw = ru.prompt_cache_write_tokens || ptd.cache_write_tokens || 0;
  const model = pd.model || pd.requestModelId || pd.requestModelName || 'unknown';
  return {
    tt: num(tt), it: num(ru.prompt_tokens || u.inputTokens), ot: num(ru.completion_tokens || u.outputTokens),
    ch: num(ch), cw: num(cw), cr: num(ru.credit), model: normModel(model)
  };
}
function parseTs(v) {
  if (typeof v === 'number') return v > 1e12 ? v / 1000 : v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    let d = Date.parse(s.indexOf(' ') >= 0 ? s.replace(' ', 'T') + (s.indexOf('Z') >= 0 ? '' : 'Z') : s);
    if (!isNaN(d)) return d / 1000;
    const n = parseFloat(s);
    if (!isNaN(n)) return n > 1e12 ? n / 1000 : n;
  }
  return null;
}
const RE_UQ = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;
const RE_TAG = /<[^<>]{0,120}>/g;
const SKIP = ['<system-reminder','<task-notification','<cb_summary','<command-name','<command-message',
              '<local-command','<ide_opened_file','<tool_result','<wecom_forwarded','<additional_data',
              '<user_info','<identity_context'];
const cleanText = s => String(s).replace(RE_TAG, ' ').replace(/\s+/g, ' ').trim();
function sessionTitle(rec) {
  if (rec.role !== 'user') return null;
  const c = rec.content;
  let texts;
  if (typeof c === 'string') texts = [c];
  else if (Array.isArray(c)) texts = c.filter(s => s && typeof s === 'object' && (s.type === 'input_text' || s.type === 'text')).map(s => s.text || '');
  else return null;
  for (let i = 0; i < texts.length; i++) {
    const t = String(texts[i] || '').trim();
    if (!t) continue;
    const m = RE_UQ.exec(t);
    if (m) { const s = cleanText(m[1]); if (s.length >= 2) return s.slice(0, 42); continue; }
    const low = t.toLowerCase();
    let skip = false;
    for (let k = 0; k < SKIP.length; k++) if (low.indexOf(SKIP[k]) === 0) { skip = true; break; }
    if (skip || t.charAt(0) === '<') continue;
    const s2 = cleanText(t);
    if (s2.length >= 2) return s2.slice(0, 42);
  }
  return null;
}
function shortWs(name) {
  const key = '-WorkBuddy-', i = String(name).lastIndexOf(key);
  if (i >= 0 && name.slice(i + key.length)) return name.slice(i + key.length);
  return name;
}
const bsName = p => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || null;

function buildData(files) {
  const wsIdx = {}, wsNames = [], models = [], modelIdx = {}, sessions = {};
  const t0 = Date.now();
  let records = 0;
  files.forEach(f => {
    const segs = f.segments, folder = segs[0];
    if (!(folder in wsIdx)) { wsIdx[folder] = wsNames.length; wsNames.push(shortWs(folder)); }
    const widx = wsIdx[folder];
    let stem = segs[segs.length - 1].replace(/\.jsonl$/, '');
    if (segs.length >= 3) stem = segs[1];
    const lines = String(f.text).split(/\r?\n/);
    let sid = null, title = null, cwd = null, wantTitle = true;
    const recs = [];
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (!line) continue;
      const isUsage = line.indexOf('"total_tokens"') >= 0 || line.indexOf('"totalTokens"') >= 0;
      const isUser = wantTitle && line.indexOf('"role":"user"') >= 0;
      if (!isUsage && !isUser) continue;
      let o; try { o = JSON.parse(line); } catch (e) { continue; }
      if (!o || typeof o !== 'object') continue;
      if (!sid && o.sessionId) sid = String(o.sessionId);
      if (!cwd && o.cwd) cwd = o.cwd;
      if (wantTitle && o.role === 'user') { const t = sessionTitle(o); if (t) { title = t; wantTitle = false; } }
      if (!isUsage) continue;
      const g = grab(o); if (!g) continue;
      const ts = parseTs(o.timestamp); if (ts == null) continue;
      let mi = modelIdx[g.model];
      if (mi === undefined) { mi = models.length; modelIdx[g.model] = mi; models.push(g.model); }
      recs.push([Math.floor(ts / 60), mi, g.tt, g.it, g.ot, g.ch, g.cw, g.cr]);
      records++;
    }
    if (!recs.length) return;
    recs.sort((a, b) => a[0] - b[0]);
    const key = sid || stem;
    let s = sessions[key];
    const fallback = cwd ? bsName(cwd) : null;
    if (!s) sessions[key] = { w: widx, id: String(key).slice(0, 8), t: title || fallback, r: recs };
    else { if (s.t == null) s.t = title || fallback; s.r = s.r.concat(recs); }
  });
  const sess = [];
  for (const k in sessions) { const s = sessions[k]; if (!s.r.length) continue; s.r.sort((a, b) => a[0] - b[0]); s.st = s.r[0][0]; sess.push(s); }
  sess.sort((a, b) => a.st - b.st);
  const now = new Date();
  return {
    ok: true, genMs: now.getTime(),
    gen: now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()) + ' ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes()),
    root: null, ws: wsNames, models: models, sess: sess,
    stats: { files: files.length, parsed: files.length, reused: 0, records: records, scanMs: Date.now() - t0 }
  };
}

/* ---------------- 聚合 ---------------- */
function aggregate() {
  const c = cut(), hiC = cutHi();
  const daily = {}, wsA = {}, band = [0, 0, 0, 0], hr = new Array(24).fill(0);
  const mTot = D.models.map(() => 0), mCredit = D.models.map(() => 0);
  const dm = {};
  let tot = 0, inp = 0, out = 0, ch = 0, cw = 0, cr = 0, turns = 0, nsess = 0, est = 0;
  const sessAgg = [];

  for (const s of D.sess) {
    let tt = 0, tn = 0, first = 0, last = 0;
    for (const r of s.r) {
      const ts = r[0] * 60000;
      if (ts < c || ts >= hiC) continue;
      const d = hm(r[0]), dk = fdate(d), h = d.getHours();
      const day = daily[dk] || (daily[dk] = { h: new Array(24).fill(0), hh: new Array(72).fill(0), tt: 0, cr: 0, n: 0 });
      day.h[h] += r[2]; day.tt += r[2]; day.cr += r[7]; day.n++;
      day.hh[h * 3 + Math.floor(d.getMinutes() / 20)] += r[2];
      hr[h] += r[2];
      mTot[r[1]] += r[2]; mCredit[r[1]] += r[7];
      (dm[dk] = dm[dk] || {});
      dm[dk][r[1]] = (dm[dk][r[1]] || 0) + r[2];
      const w = wsA[s.w] || (wsA[s.w] = { tt: 0, n: 0 });
      w.tt += r[2];
      band[Math.floor(h / 6)] += r[2];
      tot += r[2]; inp += r[3]; out += r[4]; ch += r[5]; cw += r[6]; cr += r[7];
      turns++; tn++; tt += r[2];
      const pp = MP[r[1]] || [2, 8, 0.4];
      const cht = Math.max(0, Math.min(r[5], r[3]));
      const cwt = Math.max(0, Math.min(r[6], r[3] - cht));
      est += (cht * pp[2] + cwt * 1.25 * pp[0] + (r[3] - cht - cwt) * pp[0] + r[4] * pp[1]) / 1e6;
      if (!first) first = r[0];
      last = r[0];
    }
    if (tn) { nsess++; (wsA[s.w] || (wsA[s.w] = { tt: 0, n: 0 })).n++; sessAgg.push({ s: s, tt: tt, tn: tn, first: first, last: last }); }
  }
  const wsArr = D.ws.map((nm, i) => ({ i: i, nm: nm, tt: (wsA[i] || { tt: 0 }).tt, cnt: (wsA[i] || { n: 0 }).n })).filter(x => x.tt > 0);
  return { daily: daily, wsArr: wsArr, band: band, tot: tot, inp: inp, out: out, ch: ch, cw: cw, cr: cr,
           est: est, turns: turns, nsess: nsess, sessAgg: sessAgg, hr: hr, mTot: mTot, mCredit: mCredit, dm: dm };
}
function rankColor(A) {
  const order = D.models.map((m, i) => i).sort((a, b) => (A.mTot[b] || 0) - (A.mTot[a] || 0));
  const map = {};
  order.forEach((mi, r) => { map[mi] = MC[r % MC.length]; });
  return map;
}
function hourData() {
  const c = cut(), hiC = cutHi();
  const vals = [], hrTot = new Array(24).fill(0);
  const mH = [], mC = [];
  for (let i = 0; i < 24; i++) { vals.push([]); mH.push({}); mC.push({}); }
  let gmax = 0;
  for (const s of D.sess) for (const r of s.r) {
    const ts = r[0] * 60000;
    if (ts < c || ts >= hiC) continue;
    const h = hm(r[0]).getHours();
    vals[h].push(r[2]); hrTot[h] += r[2];
    if (r[2] > gmax) gmax = r[2];
    mH[h][r[1]] = (mH[h][r[1]] || 0) + r[2];
    mC[h][r[1]] = (mC[h][r[1]] || 0) + 1;
  }
  return { vals: vals, hrTot: hrTot, mH: mH, mC: mC, gmax: gmax };
}

/* ---------------- 单调三次插值（Fritsch–Carlson，平滑不过冲）---------------- */
function smoothLine(pts) {
  const n = pts.length;
  if (n < 3) return 'M' + pts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L');
  const dx = [], m = [], t = new Array(n);
  for (let i = 0; i < n - 1; i++) dx.push(pts[i + 1][0] - pts[i][0]);
  for (let i = 0; i < n - 1; i++) m.push((pts[i + 1][1] - pts[i][1]) / dx[i]);
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = (m[i - 1] * m[i] <= 0) ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const f = 3 / Math.sqrt(s); t[i] = f * a * m[i]; t[i + 1] = f * b * m[i]; }
  }
  let d = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i];
    d += ' C' + (pts[i][0] + h / 3).toFixed(1) + ' ' + (pts[i][1] + t[i] * h / 3).toFixed(1) +
         ' ' + (pts[i + 1][0] - h / 3).toFixed(1) + ' ' + (pts[i + 1][1] - t[i + 1] * h / 3).toFixed(1) +
         ' ' + pts[i + 1][0].toFixed(1) + ' ' + pts[i + 1][1].toFixed(1);
  }
  return d;
}
/* 对数色阶：0 → 0 档；否则按 v/avg 在 0.001~0.35 区间取 1~7 档 */
function rampLevel(v, avgD) {
  if (!v) return 0;
  const r = v / (avgD || 1) / 0.001;
  return Math.min(7, Math.max(1, 1 + Math.floor(Math.log(r) / Math.log(350) * 7)));
}

/* ---------------- KPI ---------------- */
function renderKpis(A) {
  const days = Object.keys(A.daily).length || 1;
  const ce = A.inp ? A.ch / A.inp * 100 : 0;
  const st = D.stats || {};
  const src = serverMode ? '本机服务' : '浏览器本地';
  const rows = [
    ['合计 Token', fmt(A.tot), nf(A.tot) + ' tokens · ' + src, 0],
    ['日均（有数据天）', fmt(A.tot / days), days + ' 天有数据 · ' + nf(A.turns) + ' 轮次', 0],
    ['会话 / 工作空间', nf(A.nsess), '/' + nf(A.wsArr.length) + ' 个有数据的工作空间', 0],
    ['模型数', String(D.models.filter((m, i) => A.mTot[i] > 0).length), '窗口内出现过的模型', 0],
    ['输入 / 输出比', (A.out ? Math.round(A.inp / A.out) : 0) + ':1', '输入 ' + fmt(A.inp) + ' · 输出 ' + fmt(A.out), 0],
    ['缓存命中率', ce.toFixed(1) + '%', '命中 ' + fmt(A.ch) + ' · 缓存写入 ' + fmt(A.cw), 0],
    ['真实 Credit', creditFmt(A.cr), '日志 credit 字段累计（真实计费）', 1],
    ['参考估价', money(A.est), '按内置价目表折算 · 仅供对比', 0]
  ];
  const extra = st.files ? ('共 ' + st.files + ' 个日志文件 · 扫描 ' + st.scanMs + ' ms' + (st.reused ? '（复用缓存 ' + st.reused + '）' : '')) : '';
  $('#kpis').innerHTML = rows.map(r =>
    '<div class="kpi' + (r[3] ? ' hero' : '') + '"><div class="k">' + r[0] + '</div><div class="v">' + r[1] +
    '</div><div class="s" title="' + esc(r[2]) + '">' + esc(r[2]) + '</div></div>').join('');
  if (D.demo) {
    $('#footNote').innerHTML = '当前为线上演示：展示内置的<b>脱敏示例数据</b>。想看自己的真实用量，点右上角「读取本地日志」——' +
      '浏览器直接读取本机 WorkBuddy 日志，数据不出本机、不上传服务器。<br>页面不请求任何外部地址。';
  } else {
    $('#footNote').innerHTML = (D.root ? '日志目录：<b>' + esc(D.root) + '</b><br>' : '') + esc(extra) +
      '<br>所有解析均在本机完成，页面不请求任何外部地址。';
  }
}

/* ---------------- 日活热力图 ---------------- */
function renderHeat(A) {
  const dates = Object.keys(A.daily).sort().reverse();
  const head = $('#hhead');
  head.innerHTML = '<span style="width:42px;flex:none"></span>' +
    Array.from({ length: 72 }, (_, i) => '<span>' + (i % 3 === 0 ? (i / 3) : '') + '</span>').join('');
  const avg = A.tot / (dates.length || 1);
  let html = '';
  for (const d of dates) {
    html += '<div class="hrow"><div class="hlab">' + d + '</div>';
    const day = A.daily[d];
    for (let i = 0; i < 72; i++) {
      const v = day.hh ? day.hh[i] : 0;
      const h0 = Math.floor(i / 3), m0 = (i % 3) * 20, m1 = m0 + 20;
      const tip = d + ' ' + h0 + ':' + pad2(m0) + '–' + (m1 === 60 ? (h0 + 1) : h0) + ':' + (m1 === 60 ? '00' : pad2(m1)) +
        '\n' + nf(v) + ' token（占当日 ' + (day.tt ? (v / day.tt * 100).toFixed(1) : 0) + '%）';
      html += '<div class="hcell" style="background:' + RAMP[rampLevel(v, avg)] + '" data-tip="' + esc(tip) + '"></div>';
    }
    html += '</div>';
  }
  $('#heatWrap').innerHTML = html || '<div class="empty">该时间范围内无数据</div>';
  let lg = '<span>低</span>';
  for (let i = 1; i < 8; i++) lg += '<i style="background:' + RAMP[i] + '"></i>';
  $('#heatLegend').innerHTML = lg + '<span>高</span>';
}

/* ---------------- 时段分布 ---------------- */
function renderBand4(A) {
  const names = ['凌晨 0-6', '上午 6-12', '下午 12-18', '晚间 18-24'];
  const tot = A.band.reduce((a, b) => a + b, 0) || 1;
  $('#band4').innerHTML = A.band.map((v, i) =>
    '<div class="b4"><div class="b4k">' + names[i] + '</div><div class="b4v">' + (v / tot * 100).toFixed(1) + '%</div></div>').join('');
}

/* ---------------- 0–24 时山脊图 ---------------- */
function renderRidge(A) {
  const svg = $('#rdSvg');
  const hd = hourData();
  const mH = hd.mH;
  const W = svg.clientWidth || 800, H = 112, pL = 44, pR = 8, pT = 8, pB = 18;
  const plotH = H - pT - pB, base = pT + plotH;
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('height', H);
  const pitch = (W - pL - pR) / 24;

  const mh = {};
  for (let h = 0; h < 24; h++) for (const k in mH[h]) { const mi = +k; (mh[mi] = mh[mi] || new Array(24).fill(0))[h] = mH[h][k]; }
  let vmax = 0, vmin = Infinity;
  for (const mi in mh) for (const v of mh[mi]) if (v > 0) { if (v > vmax) vmax = v; if (v < vmin) vmin = v; }
  if (!vmax) {
    svg.innerHTML = '<text x="' + pL + '" y="40" font-size="12" fill="' + CJ.muted + '">该时间范围内无数据</text>';
    $('#rdLegend').innerHTML = '';
    return;
  }
  const lo = Math.log10(vmin), hi = Math.log10(vmax), span = Math.max(1e-9, hi - lo);
  const yv = v => pT + plotH * (1 - (Math.log10(v) - lo) / span);

  let grid = '';
  for (let k = Math.ceil(lo); k <= Math.floor(hi); k++) {
    const y = yv(Math.pow(10, k)).toFixed(1);
    grid += '<line x1="' + pL + '" y1="' + y + '" x2="' + (W - pR) + '" y2="' + y + '" stroke="' + CJ.grid + '" stroke-width="0.5"/>' +
            '<text x="' + (pL - 5) + '" y="' + (+y + 3).toFixed(1) + '" font-size="8.5" fill="' + CJ.axis2 + '" text-anchor="end">' + fmt(Math.pow(10, k)) + '</text>';
  }
  const RC = rankColor(A);
  const mis = Object.keys(mh).map(Number).sort((a, b) => {
    const ta = mh[a].reduce((x, y) => x + y, 0), tb = mh[b].reduce((x, y) => x + y, 0);
    return ta - tb;   // 用量小的先画，大的压在上面
  });
  let defs = '', curves = '';
  for (const mi of mis) {
    const a = mh[mi];
    const dim = hrSel !== null && hrSel !== mi;
    const col = dim ? CJ.dim : RC[mi];
    const runs = []; let cur = [];
    for (let h = 0; h < 24; h++) {
      if (a[h]) cur.push([pL + pitch * (h + 0.5), yv(a[h])]);
      else { if (cur.length) runs.push(cur); cur = []; }
    }
    if (cur.length) runs.push(cur);
    const tt = a.reduce((x, y) => x + y, 0);
    let pk = 0; for (let h = 1; h < 24; h++) if (a[h] > a[pk]) pk = h;
    const tip = D.models[mi] + '\n窗口合计 ' + fmt(tt) + ' token\n时段峰值 ' + pk + ' 时 · ' + fmt(a[pk]);
    defs += '<linearGradient id="rg' + mi + '" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="' + col + '" stop-opacity="0.30"/>' +
            '<stop offset="100%" stop-color="' + col + '" stop-opacity="0.02"/></linearGradient>';
    let body = '', hitD = '';
    for (const run of runs) {
      let pts;
      if (run.length === 1) {
        const x = run[0][0];
        pts = [[Math.max(pL, x - pitch * 0.5), base], [x, run[0][1]], [Math.min(W - pR, x + pitch * 0.5), base]];
      } else {
        pts = [[Math.max(pL, run[0][0] - pitch * 0.6), base]].concat(run, [[Math.min(W - pR, run[run.length - 1][0] + pitch * 0.6), base]]);
      }
      const line = smoothLine(pts);
      hitD += (hitD ? ' ' : '') + line;
      const area = line + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + base + ' L' + pts[0][0].toFixed(1) + ' ' + base + ' Z';
      body += '<path d="' + area + '" fill="url(#rg' + mi + ')"/>' +
              '<path d="' + line + '" fill="none" stroke="' + col + '" stroke-width="0.8" stroke-opacity="0.95" pointer-events="none"/>';
    }
    const hit = hitD ? '<path d="' + hitD + '" fill="none" stroke="rgba(0,0,0,0)" stroke-width="8" pointer-events="stroke" data-tip="' + esc(tip) + '"/>' : '';
    curves += '<g opacity="' + (dim ? 0.22 : 1) + '">' + body + hit + '</g>';
  }
  let xt = '';
  for (let h = 0; h < 24; h += 2) xt += '<text x="' + (pL + pitch * (h + 0.5)) + '" y="' + (H - 6) + '" font-size="9" fill="' + CJ.axis + '" text-anchor="middle">' + h + '时</text>';

  const idx = D.models.map((m, i) => i).filter(i => A.mTot[i] > 0).sort((a, b) => A.mTot[b] - A.mTot[a]).slice(0, 8);
  $('#rdLegend').innerHTML = idx.map(mi =>
    '<span data-hrm="' + mi + '" style="cursor:pointer;' + (hrSel !== null && hrSel !== mi ? 'opacity:.4' : '') + '">' +
    '<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + RC[mi] + ';margin-right:4px"></i>' +
    esc(D.models[mi]) + '</span>').join('');

  svg.innerHTML = '<defs>' + defs + '</defs>' + grid + curves + xt +
    '<line x1="' + pL + '" y1="' + base + '" x2="' + (W - pR) + '" y2="' + base + '" stroke="' + CJ.base + '"/>';
}

/* ---------------- 顶部模型卡片 ---------------- */
function renderTop5(A) {
  const order = D.models.map((m, i) => i).filter(i => A.mTot[i] > 0)
    .sort((a, b) => A.mTot[b] - A.mTot[a]).slice(0, 10);
  const RC = rankColor(A);
  $('#top5').innerHTML = order.map(mi =>
    '<div class="t5' + (selModel === mi ? ' on' : '') + '" data-dm="' + mi + '">' +
    '<div class="k" title="' + esc(D.models[mi]) + '"><i style="background:' + RC[mi] + '"></i>' + esc(D.models[mi]) + '</div>' +
    '<div class="v">' + fmt(A.mTot[mi]) + '</div></div>').join('');
}

/* ---------------- 每日模型堆叠柱 ---------------- */
function renderDailyModel(A) {
  LASTA = A;
  const svg = $('#dmSvg');
  const dates = Object.keys(A.dm).sort();
  const mx = Math.max.apply(null, dates.map(d => Object.keys(A.dm[d]).reduce((a, k) => a + A.dm[d][k], 0)).concat([1]));
  const W = svg.clientWidth || 800, H = 102, pL = 44, pR = 8, pT = 8, pB = 18;
  const n = dates.length || 1, pitch = (W - pL - pR) / n, bw = Math.max(2, pitch * 0.62);
  const top = D.models.map((m, i) => i).filter(i => A.mTot[i] > 0).sort((a, b) => A.mTot[b] - A.mTot[a]).slice(0, 8);
  const segs = top.concat(selModel !== null && selModel !== -1 && top.indexOf(selModel) < 0 ? [selModel] : []);
  const RC = rankColor(A);
  const colorOf = mi => mi === -1 ? CJ.other : RC[mi];

  let g = '', bars = '', xlabels = '';
  for (let i = 1; i < 8; i++) {
    const y = pT + (H - pT - pB) * i / 8;
    g += '<line x1="' + pL + '" y1="' + y + '" x2="' + (W - pR) + '" y2="' + y + '" stroke="' + CJ.grid + '" stroke-width="0.5"/>';
  }
  dates.forEach((d, i) => {
    const day = A.dm[d];
    const dtt = Object.keys(day).reduce((a, k) => a + day[k], 0);
    let cum = 0;
    const dayList = segs.map(mi => ({ mi: mi, v: day[mi] || 0 })).filter(o => o.v > 0).sort((a, b) => b.v - a.v);
    dayList.forEach(o => {
      const bh = o.v / mx * (H - pT - pB);
      const x = pL + pitch * i + (pitch - bw) / 2, y = H - pB - cum - bh;
      const dimmed = selModel !== null && selModel !== o.mi;
      bars += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0.5, bh).toFixed(1) +
              '" fill="' + (dimmed ? CJ.dimBar : colorOf(o.mi)) + '" fill-opacity="' + (dimmed ? '0.5' : '0.85') + '"/>';
      cum += bh;
    });
    const tip = d + ' · 合计 ' + nf(dtt) + '\n' + dayList.map(o =>
      '· ' + (o.mi === -1 ? '其他' : D.models[o.mi]) + '  ' + nf(o.v) + '（' + (dtt ? (o.v / dtt * 100).toFixed(1) : 0) + '%）').join('\n');
    bars += '<rect x="' + (pL + pitch * i).toFixed(1) + '" y="' + pT + '" width="' + pitch.toFixed(1) + '" height="' + (H - pT - pB) +
            '" fill="#fff" fill-opacity="0" pointer-events="all" data-tip="' + esc(tip) + '"/>';
    const step = Math.ceil(n / 7);
    if (i % step === 0 || i === n - 1) {
      xlabels += '<text x="' + (pL + pitch * i + pitch / 2) + '" y="' + (H - 4) + '" font-size="9" fill="' + CJ.axis + '" text-anchor="middle">' + d + '</text>';
    }
  });
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('height', H);
  svg.innerHTML = g + bars + xlabels +
    '<text x="' + (pL - 5) + '" y="' + (pT + 7) + '" font-size="9" fill="' + CJ.axis + '" text-anchor="end">' + fmt(mx) + '</text>' +
    '<text x="' + (pL - 5) + '" y="' + (H - pB) + '" font-size="9" fill="' + CJ.axis + '" text-anchor="end">0</text>';
}

/* ---------------- 单次请求大小分布 ---------------- */
function renderModelDist(A) {
  const svg = $('#mdSvg');
  const W = svg.clientWidth || 300;
  const c = cut(), hiC = cutHi();
  const bym = {};
  for (const s of D.sess) for (const r of s.r) {
    const ts = r[0] * 60000;
    if (ts < c || ts >= hiC) continue;
    (bym[r[1]] = bym[r[1]] || []).push(r[2]);
  }
  const rows = Object.keys(bym).map(Number).sort((a, b) => bym[b].length - bym[a].length).slice(0, 8);
  if (!rows.length) {
    svg.setAttribute('viewBox', '0 0 ' + W + ' 60');
    svg.setAttribute('height', 60);
    svg.innerHTML = '<text x="16" y="30" font-size="11" fill="' + CJ.muted + '">该时间范围内无数据</text>';
    $('#mdCap').textContent = '';
    return;
  }
  const st = rows.map(m => {
    const a = bym[m].slice().sort((x, y) => x - y), n = a.length;
    const p = q => a[Math.min(n - 1, Math.ceil(q * n) - 1)];
    return { m: m, n: n, p50: p(0.5), p90: p(0.9) };
  });
  const all = [];
  rows.forEach(m => { for (const v of bym[m]) all.push(v); });
  const sorted = all.slice().sort((a, b) => a - b);
  const gpct = q => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const gp50 = gpct(0.5);
  const cap = Math.max(1e5, Math.ceil(gpct(0.995) * 1.06 / 5e4) * 5e4);
  const nameW = Math.min(118, Math.max.apply(null, rows.map(m => D.models[m].length)) * 6.1 + 6);
  const cntX = nameW + 8;
  const x50 = cntX + 48, x90 = x50 + 56, lw = x90 + 76;
  const barW = 52;
  const X = v => lw + (W - lw - 6) * Math.min(1, v / cap);
  const pScale = Math.max(st.reduce((a, s) => Math.max(a, s.p90), 0), 1);
  const rh = 44, bh = 24, pT = 14;
  const axY = pT + st.length * rh + 2;

  const K = 36, cntM = st.map(() => new Array(K).fill(0));
  for (let ri = 0; ri < st.length; ri++) for (const v of bym[st[ri].m]) cntM[ri][Math.min(K - 1, Math.floor(v / cap * K))]++;
  const RC = rankColor(A);

  let out =
    '<line x1="' + X(gp50).toFixed(1) + '" y1="' + (pT - 6) + '" x2="' + X(gp50).toFixed(1) + '" y2="' + axY + '" stroke="' + CJ.dash + '" stroke-width="0.8" stroke-dasharray="3 2"/>' +
    '<text x="' + (X(gp50) + 3).toFixed(1) + '" y="' + (pT - 1) + '" font-size="9" fill="' + CJ.axis + '">全局 50% ' + fmt(gp50) + '</text>' +
    '<text x="0" y="' + (pT - 1) + '" font-size="11" fill="' + CJ.axis + '">模型</text>' +
    '<text x="' + cntX + '" y="' + (pT - 1) + '" font-size="11" fill="' + CJ.axis + '">次数</text>' +
    '<text x="' + x50 + '" y="' + (pT - 1) + '" font-size="11" fill="' + CJ.axis + '">50%</text>' +
    '<text x="' + x90 + '" y="' + (pT - 1) + '" font-size="11" fill="' + CJ.axis + '">90%</text>';

  st.forEach((s, ri) => {
    const col = RC[s.m] || modelColor(s.m);
    const baseY = pT + ri * rh + 24;
    const raw = cntM[ri], sm = raw.map((v, i) => ((raw[i - 1] || 0) + 2 * v + (raw[i + 1] || 0)) / 4);
    const mxv = Math.max.apply(null, sm.concat([1e-9]));
    let d = 'M' + lw.toFixed(1) + ' ' + baseY;
    for (let i = 0; i < K; i++) d += ' L' + (lw + (W - lw - 6) * (i + 0.5) / K).toFixed(1) + ' ' + (baseY - sm[i] / mxv * bh).toFixed(1);
    d += ' L' + (W - 6).toFixed(1) + ' ' + baseY + ' Z';
    const tip = D.models[s.m] + '\n' + nf(s.n) + ' 次 · 50% ' + fmt(s.p50) + ' · 90% ' + fmt(s.p90);
    out +=
      '<path d="' + d + '" fill="' + col + '" fill-opacity="0.3" stroke="' + col + '" stroke-width="0.8" data-tip="' + esc(tip) + '"/>' +
      '<line x1="' + X(s.p50).toFixed(1) + '" y1="' + (baseY - bh - 1) + '" x2="' + X(s.p50).toFixed(1) + '" y2="' + baseY + '" stroke="' + col + '" stroke-width="1.6" data-tip="' + esc(tip) + '"/>' +
      '<circle cx="' + X(s.p90).toFixed(1) + '" cy="' + (baseY - 4) + '" r="2" fill="' + CJ.axis + '" data-tip="' + esc(tip) + '"/>' +
      '<text x="0" y="' + (baseY - 5.5) + '" font-size="11" fill="' + CJ.t1 + '">' + esc(D.models[s.m]) + '</text>' +
      '<text x="' + cntX + '" y="' + (baseY - 5.5) + '" font-size="11" fill="' + CJ.t1 + '">' + nf(s.n) + '</text>' +
      '<text x="' + x50 + '" y="' + (baseY - 9) + '" font-size="12" fill="' + CJ.t1 + '">' + fmt(s.p50) + '</text>' +
      '<rect x="' + x50 + '" y="' + (baseY - 5) + '" width="' + barW + '" height="5" fill="' + CJ.dimBar + '" fill-opacity="0.7"/>' +
      '<rect x="' + x50 + '" y="' + (baseY - 5) + '" width="' + Math.max(1.2, s.p50 / pScale * barW).toFixed(1) + '" height="5" fill="' + col + '" fill-opacity="0.9"/>' +
      '<text x="' + x90 + '" y="' + (baseY - 9) + '" font-size="12" fill="' + CJ.t1 + '">' + fmt(s.p90) + '</text>' +
      '<rect x="' + x90 + '" y="' + (baseY - 5) + '" width="' + barW + '" height="5" fill="' + CJ.dimBar + '" fill-opacity="0.7"/>' +
      '<rect x="' + x90 + '" y="' + (baseY - 5) + '" width="' + Math.max(1.2, s.p90 / pScale * barW).toFixed(1) + '" height="5" fill="' + col + '" fill-opacity="0.45"/>';
  });

  let tks = '<line x1="' + lw + '" y1="' + axY + '" x2="' + (W - 6) + '" y2="' + axY + '" stroke="' + CJ.base + '"/>';
  const steps = [1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6, 2e6, 5e6, 1e7];
  let stepT = steps[steps.length - 1];
  for (const s of steps) if (cap / s <= 8) { stepT = s; break; }
  for (let v = 0; v <= cap + 1; v += stepT) {
    const x = X(v);
    tks += '<line x1="' + x.toFixed(1) + '" y1="' + axY + '" x2="' + x.toFixed(1) + '" y2="' + (axY + 2) + '" stroke="' + CJ.axis + '"/>' +
           '<text x="' + x.toFixed(1) + '" y="' + (axY + 12) + '" font-size="8" fill="' + CJ.axis + '" text-anchor="middle">' +
           (v === 0 ? '0' : (v / 1e4) + '万') + '</text>';
  }
  const HH = axY + 16;
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + HH);
  svg.setAttribute('height', HH);
  svg.innerHTML = out + tks;
  $('#mdCap').textContent = 'TOP ' + st.length + ' 模型 · 共 ' + nf(all.length) + ' 次';
}

/* ---------------- 模型排行（总量 / 积分，共用条形渲染） ----------------
   rowSet：决定哪些模型出现在行里（积分卡用总量集合，保证「每个模型」都有积分行，
   即使该模型 credit 为 0；这样左右两卡行数一致、高度天然对齐）。 */
function renderRankBars(A, svgSel, capSel, vals, fmtVal, unit, emptyTip, rowSet, capFn) {
  const svg = $(svgSel);
  const W = svg.clientWidth || 300;
  const rows = D.models.map((m, i) => i)
    .filter(i => (rowSet ? rowSet[i] > 0 : vals[i] > 0))
    .sort((a, b) => vals[b] - vals[a]);
  if (!rows.length) {
    svg.setAttribute('viewBox', '0 0 ' + W + ' 60');
    svg.setAttribute('height', 60);
    svg.innerHTML = '<text x="16" y="30" font-size="11" fill="' + CJ.muted + '">' + emptyTip + '</text>';
    $(capSel).textContent = '';
    return;
  }
  const RC = rankColor(A);
  const sum = rows.reduce((a, m) => a + vals[m], 0);
  const nameW = Math.max.apply(null, rows.map(m => D.models[m].length)) * 7.1 + 12;
  const valW = 80;
  const bx = nameW + 12, bw = Math.max(60, W - bx - valW);
  const rh = 30, bh = 16, pT = 6;
  const mx = vals[rows[0]];
  let out = '';
  rows.forEach((m, i) => {
    const y = pT + i * rh;
    const w = Math.max(1.5, vals[m] / mx * bw);
    const tip = D.models[m] + '\n合计 ' + nf(vals[m]) + ' ' + unit + '\n占窗口合计 ' + (sum ? (vals[m] / sum * 100).toFixed(1) : 0) + '%';
    out +=
      '<text x="0" y="' + (y + bh - 3.5) + '" font-size="12" fill="' + CJ.t1 + '" data-tip="' + esc(tip) + '">' + esc(D.models[m]) + '</text>' +
      '<rect x="' + bx.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh + '" rx="3" fill="' + CJ.dimBar + '" fill-opacity="0.5" data-tip="' + esc(tip) + '"/>' +
      '<rect x="' + bx.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + bh + '" rx="3" fill="' + RC[m] + '" fill-opacity="0.9" data-tip="' + esc(tip) + '"/>' +
      '<text x="' + W + '" y="' + (y + bh - 3.5) + '" font-size="12.5" font-weight="600" fill="' + CJ.t1 + '" text-anchor="end" data-tip="' + esc(tip) + '">' + fmtVal(vals[m]) + '</text>';
  });
  const HH = pT + rows.length * rh + 4;
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + HH);
  svg.setAttribute('height', HH);
  svg.innerHTML = out;
  $(capSel).textContent = capFn ? capFn(rows) : (rows.length + ' 个模型 · 合计 ' + fmtVal(sum) + ' ' + unit);
}

function renderModelTotals(A) {
  renderRankBars(A, '#mtSvg', '#mtCap', A.mTot, fmt, 'token', '该时间范围内无数据');
}
function renderModelCredit(A) {
  renderRankBars(A, '#mcSvg', '#mcCap', A.mCredit, creditFmt, 'credit', '该时间范围内无积分数据', A.mTot);
}
/* 性价比 = Token ÷ Credit，只有 credit>0 的模型才有意义（credit 缺失不等于免费） */
function renderModelValue(A) {
  const ratio = D.models.map((m, i) => (A.mCredit[i] > 0 ? A.mTot[i] / A.mCredit[i] : 0));
  let tt = 0, tc = 0;
  for (let i = 0; i < ratio.length; i++) { tt += A.mTot[i]; tc += A.mCredit[i]; }
  renderRankBars(A, '#mvSvg', '#mvCap', ratio, fmt, 'token/credit',
    '该时间范围内无计费数据', A.mCredit,
    rows => rows.length + ' 个模型 · 整体 ' + fmt(tc ? tt / tc : 0) + ' token/credit');
}

/* ---------------- 工作空间 / 会话面板 ---------------- */
/* 一行方块数 = 窗口天数 × 倍率。窗口很长时方块会被压到亚像素宽并被 overflow 裁掉，
   所以按 MAXCELLS 自动降级倍率（例如 140 天窗口下 3X 自动降到 1X）。 */
const MAXCELLS = 150;
function effMult(days) {
  const d = Math.max(1, days || 1);
  const room = Math.floor(MAXCELLS / d);
  return Math.max(1, Math.min(wsMult, room || 1));
}
function vizCells(m) {
  const days = PCTX ? PCTX.days : [], avgD = PCTX ? PCTX.avgD : 1;
  const mult = effMult(days.length);
  let h = '';
  for (const dk of days) {
    const arr = (m && (m[dk] || (m.get && m.get(dk)))) || new Array(24).fill(0);
    for (let k = 0; k < mult; k++) {
      const a = Math.floor(24 * k / mult), b = Math.floor(24 * (k + 1) / mult);
      let v = 0;
      for (let hh = a; hh < b; hh++) v += arr[hh] || 0;
      h += '<div class="wcell" style="background:' + RAMP[rampLevel(v, avgD)] + '" title="' + dk + ' ' + a + ':00–' + b + ':00 · ' + fmt(v) + ' token"></div>';
    }
  }
  return h || '<div class="wcell"></div>';
}
function renderCrumb() {
  const c = $('#crumb');
  if (state.ws === null) { c.style.display = 'none'; return; }
  const wn = D.ws[state.ws];
  let path, back;
  if (state.ses !== null) {
    back = '<button class="chip on" data-a="up">← 返回</button>';
    path = '<a data-a="root">' + esc(wn) + '</a><span class="sep">›</span><span class="cur">' + esc(state.ses.t || '(无标题会话)') + '</span>';
  } else {
    back = '<button class="chip on" data-a="root">← 返回列表</button>';
    path = '<span class="cur">' + esc(wn) + '</span>';
  }
  c.innerHTML = back + '<span class="path">' + path + '</span>';
  c.style.display = 'flex';
}
function renderPanel(A) {
  const p = $('#panel'), tools = $('#wsTools'), wc = $('#wsCard');
  // 折叠时工具条保持隐藏（内联 display 优先级高于 CSS，必须在这里同步）
  const folded = !!(wc && wc.classList && wc.classList.contains('collapsed'));
  const c = cut(), hiC = cutHi();
  const WHD = {}, dset = {};
  SHD = new Map();
  for (const s of D.sess) {
    let sm = null;
    for (const r of s.r) {
      const ts = r[0] * 60000;
      if (ts < c || ts >= hiC) continue;
      const d = hm(r[0]), dk = fdate(d);
      dset[dk] = 1;
      const w = s.w;
      (WHD[w] = WHD[w] || {});
      (WHD[w][dk] = WHD[w][dk] || new Array(24).fill(0));
      WHD[w][dk][d.getHours()] += r[2];
      if (!sm) { sm = {}; SHD.set(s, sm); }
      (sm[dk] = sm[dk] || new Array(24).fill(0));
      sm[dk][d.getHours()] += r[2];
    }
  }
  PCTX = { whd: WHD, days: Object.keys(dset).sort(), avgD: A.tot / (Object.keys(A.daily).length || 1) };

  if (state.ws === null) {
    tools.style.display = folded ? 'none' : 'flex';
    if (wsMode === 'ws') {
      $('#wsSorts').style.display = 'flex';
      const arr = A.wsArr.filter(x => !q || x.nm.toLowerCase().indexOf(q) >= 0);
      if (wsSort === 'tt') arr.sort((a, b) => b.tt - a.tt); else arr.sort((a, b) => b.n - a.n);
      if (!arr.length) { p.innerHTML = '<div class="empty">无匹配的工作空间</div>'; return; }
      p.innerHTML = '<div class="subgrid">' + arr.map(x =>
        '<div class="wcard" data-ws="' + x.i + '" title="' + esc(D.ws[x.i]) + '">' +
        '<div class="wc-nm">' + esc(x.nm) + '</div><div class="wc-tt">' + fmt(x.tt) + '</div>' +
        '<div class="wc-meta">' + (x.tt / A.tot * 100).toFixed(1) + '% · ' + x.cnt + ' 会话</div>' +
        '<div class="wviz">' + buildViz(x.i) + '</div></div>').join('') + '</div>';
      return;
    }
    $('#wsSorts').style.display = 'none';
    const arr = A.sessAgg.filter(x => !q || String(x.s.t || '').toLowerCase().indexOf(q) >= 0).sort((a, b) => b.tt - a.tt);
    if (!arr.length) { p.innerHTML = '<div class="empty">无匹配的会话</div>'; return; }
    p.innerHTML = '<div class="subgrid">' + arr.map(x => {
      const i = D.sess.indexOf(x.s);
      return '<div class="wcard" data-si="' + i + '" title="' + esc(x.s.t || '') + '">' +
        '<div class="wc-nm">' + esc(x.s.t || '(无标题会话)') + '</div><div class="wc-tt">' + fmt(x.tt) + '</div>' +
        '<div class="wc-meta">' + (A.tot ? (x.tt / A.tot * 100).toFixed(1) : 0) + '% · ' + x.tn + ' 轮</div>' +
        '<div class="wviz">' + vizCells(SHD.get(x.s)) + '</div></div>';
    }).join('') + '</div>';
  } else if (state.ses === null) {
    tools.style.display = 'none';
    const arr = A.sessAgg.filter(x => x.s.w === state.ws).sort((a, b) => b.tt - a.tt);
    const wsTot = arr.reduce((a, x) => a + x.tt, 0);
    if (!arr.length) { p.innerHTML = '<div class="empty">该窗口内此工作空间无数据</div>'; return; }
    p.innerHTML = arr.map(x => {
      const i = D.sess.indexOf(x.s);
      return '<div class="wcard" data-ses="' + i + '" title="' + esc(x.s.t || '') + '">' +
        '<div class="wc-nm">' + esc(x.s.t || '(无标题会话)') + '</div><div class="wc-tt">' + fmt(x.tt) + '</div>' +
        '<div class="wc-meta">' + (wsTot ? (x.tt / wsTot * 100).toFixed(1) : 0) + '% · ' + x.tn + ' 轮</div>' +
        '<div class="wviz">' + vizCells(SHD.get(x.s)) + '</div></div>';
    }).join('');
  } else {
    tools.style.display = 'none';
    const s = state.ses;
    const reqs = s.r.filter(r => inWin(r[0] * 60000));
    if (!reqs.length) { p.innerHTML = '<div class="empty">该窗口内此会话无数据</div>'; return; }
    const tt = reqs.reduce((a, r) => a + r[2], 0);
    const t0 = reqs[0][0], t1 = reqs[reqs.length - 1][0];
    p.innerHTML = '<div class="view-h"><div><div class="view-t">' + esc(s.t || '(无标题会话)') + '</div>' +
      '<div class="view-m">' + fdate(hm(t0)) + ' ' + ftime(hm(t0)) + ' → ' + fdate(hm(t1)) + ' ' + ftime(hm(t1)) +
      ' · ' + reqs.length + ' 次请求 · 合计 ' + fmt(tt) + '</div></div>' +
      '<div><button class="chip on" data-v="sc">散点</button> <button class="chip" data-v="tb">明细表</button></div></div><div id="reqView"></div>';
    drawScatter(reqs);
    const bs = p.querySelectorAll('[data-v]');
    function setV(v) { for (const b of bs) b.classList.toggle('on', b.dataset.v === v); }
    bs[0].onclick = () => { drawScatter(reqs); setV('sc'); };
    bs[1].onclick = () => { drawTable(reqs); setV('tb'); };
  }
}
function buildViz(w) {
  const pc = PCTX || { whd: {}, days: [], avgD: 1 };
  return vizCells(pc.whd[w] || {});
}
function modelLegend(reqs) {
  const set = {};
  reqs.forEach(r => { set[r[1]] = 1; });
  const RC = LASTA ? rankColor(LASTA) : null;
  return Object.keys(set).map(i =>
    '<span style="color:' + (RC ? RC[i] : modelColor(i)) + '">●</span>' + esc(D.models[i])).join('　');
}
function drawScatter(reqs) {
  const el = $('#reqView');
  const RC = LASTA ? rankColor(LASTA) : null;
  const mcol = i => RC ? RC[i] : modelColor(i);
  const W = el.clientWidth || 560, H = 240, pL = 42, pR = 12, pT = 12, pB = 26;
  const t0 = reqs[0][0], t1 = reqs[reqs.length - 1][0], span = Math.max(1, t1 - t0);
  const mx = Math.max.apply(null, reqs.map(r => r[2]).concat([1]));
  const x = v => pL + (W - pL - pR) * (v - t0) / span;
  const y = v => pT + (H - pT - pB) * (1 - Math.log(v + 1) / Math.log(mx + 1));
  let g = '';
  for (let i = 0; i < 4; i++) {
    const yy = pT + (H - pT - pB) * i / 3;
    g += '<line x1="' + pL + '" y1="' + yy + '" x2="' + (W - pR) + '" y2="' + yy + '" stroke="' + CJ.grid + '"/>';
  }
  let pts = '';
  for (const r of reqs) {
    const d = hm(r[0]);
    const tip = fdate(d) + ' ' + ftime(d) + '\n' + D.models[r[1]] +
      '\n输入 ' + nf(r[3]) + ' · 输出 ' + nf(r[4]) + '\n缓存命中 ' + nf(r[5]) + ' · 合计 ' + nf(r[2]) +
      (r[7] ? '\ncredit ' + r[7].toFixed(2) : '');
    pts += '<circle cx="' + x(r[0]).toFixed(1) + '" cy="' + y(r[2]).toFixed(1) + '" r="3.2" fill="' + mcol(r[1]) +
           '" fill-opacity=".82" data-tip="' + esc(tip) + '"/>';
  }
  const d0 = hm(t0), d1 = hm(t1);
  el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%"><g>' + g + pts +
    '<text x="' + pL + '" y="' + (pT + 8) + '" font-size="9" fill="' + CJ.axis + '">' + fmt(mx) + '</text>' +
    '<text x="' + pL + '" y="' + (H - pB) + '" font-size="9" fill="' + CJ.axis + '">1</text>' +
    '<text x="' + pL + '" y="' + (H - 6) + '" font-size="9" fill="' + CJ.axis + '">' + fdate(d0) + ' ' + ftime(d0) + '</text>' +
    '<text x="' + (W - pR) + '" y="' + (H - 6) + '" font-size="9" fill="' + CJ.axis + '" text-anchor="end">' + fdate(d1) + ' ' + ftime(d1) + '</text>' +
    '<text x="' + (pL - 8) + '" y="' + (H / 2) + '" font-size="9" fill="' + CJ.axis + '" text-anchor="end" transform="rotate(-90 ' + (pL - 8) + ' ' + (H / 2) + ')">token（对数轴）</text>' +
    '</g></svg><div class="hint" style="margin-top:6px">x = 时间 · y = 单次请求 token（对数） · 颜色 = 模型：' + modelLegend(reqs) + '</div>';
}
function drawTable(reqs) {
  const el = $('#reqView');
  let rows = '';
  for (let i = reqs.length - 1; i >= 0; i--) {
    const r = reqs[i], d = hm(r[0]);
    const tip = '输入 ' + nf(r[3]) + ' · 输出 ' + nf(r[4]) + ' · 缓存 ' + nf(r[5]) + ' · 合计 ' + nf(r[2]);
    rows += '<tr data-tip="' + esc(tip) + '"><td>' + fdate(d) + ' ' + ftime(d) + '</td>' +
      '<td style="text-align:left">' + esc(D.models[r[1]]) + '</td>' +
      '<td>' + nf(r[3]) + '</td><td>' + nf(r[4]) + '</td><td>' + nf(r[5]) + '</td>' +
      '<td>' + nf(r[2]) + '</td><td>' + (r[7] ? r[7].toFixed(3) : '—') + '</td></tr>';
  }
  el.innerHTML = '<div class="rt-wrap"><table class="rt"><thead><tr><th>时间</th><th style="text-align:left">模型</th>' +
    '<th>输入</th><th>输出</th><th>缓存命中</th><th>合计</th><th>credit</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

/* ---------------- 总渲染 ---------------- */
function render() {
  if (!D) return;
  genMs = D.genMs;
  // 线上演示模式下，把「重选目录」改成更明确的「读取本地日志」入口
  const rtxt = $('#reselectTxt'), rb = $('#reselectBtn');
  if (rtxt) rtxt.textContent = D.demo ? '读取本地日志' : '重选目录';
  if (rb) {
    rb.title = D.demo ? '用浏览器直接读取你电脑上的 WorkBuddy 日志（数据不出本机、不上传）' : '换一个日志目录';
    rb.classList.toggle('accent', !!D.demo);
  }
  MP = D.models.map(priceOf);
  const st = D.stats || {};
  if (D.demo) {
    $('#genAt').textContent = '示例数据（已脱敏）· ' + D.gen + ' · 结构与真实看板完全一致，不含个人内容';
  } else {
    $('#genAt').textContent = '数据截至 ' + D.gen + ' · 请求级真实 usage' +
      (st.files ? ' · ' + st.files + ' 个日志文件' : '') + (serverMode ? ' · 本机服务模式' : ' · 浏览器本地解析');
  }
  const db = $('#demoBar');
  if (db) db.classList.toggle('on', !!D.demo);
  $('#multHint').textContent = '';
  const A = aggregate();
  const em = effMult(Object.keys(A.daily).length);
  $('#multHint').textContent = em + (em !== wsMult ? '（窗口较长，已自动降低倍率）' : '');
  LASTA = A;
  renderKpis(A);
  renderHeat(A);
  renderBand4(A);
  renderCrumb();
  renderPanel(A);
  renderRidge(A);
  renderTop5(A);
  renderDailyModel(A);
  renderModelDist(A);
  renderModelTotals(A);
  renderModelCredit(A);
  renderModelValue(A);
  const ps = document.querySelector('.panel-scroll'), hc = $('#heatCard'), wc = $('#wsCard');
  const isFold = el => !!(el && el.classList && el.classList.contains('collapsed'));
  if (ps && hc) {
    if (isFold(hc) || isFold(wc)) {
      ps.style.maxHeight = '';
    } else {
      const card = ps.closest('.card');
      const delta = card.getBoundingClientRect().height - ps.getBoundingClientRect().height;
      ps.style.maxHeight = Math.max(180, hc.getBoundingClientRect().height - delta) + 'px';
    }
  }
}

/* ---------------- 提示气泡 ---------------- */
document.addEventListener('mousemove', function (e) {
  const t = e.target, tip = $('#tip');
  if (!tip) return;
  let txt = null;
  if (t && t.classList && t.classList.contains('hcell') && t.dataset.tip) txt = t.dataset.tip;
  else if (t && t.dataset && t.dataset.tip && (t.tagName === 'circle' || t.tagName === 'rect' || t.tagName === 'path')) txt = t.dataset.tip;
  else if (t && t.tagName === 'TD' && t.closest('tr') && t.closest('tr').dataset.tip) txt = t.closest('tr').dataset.tip;
  if (txt) {
    tip.textContent = txt;
    tip.style.opacity = 1;
    tip.style.left = (e.clientX + 12) + 'px';
    tip.style.top = (e.clientY + 12) + 'px';
  } else tip.style.opacity = 0;
});

/* ---------------- 时间窗口 ---------------- */
function applyCustom() {
  const sv = $('#dStart').value, ev = $('#dEnd').value;
  if (!sv && !ev) return;
  customStart = sv ? new Date(sv + 'T00:00:00').getTime() / 60000 : 0;
  customEnd = ev ? (new Date(ev + 'T00:00:00').getTime() + 86400e3) / 60000 : 0;
  win = 0;
  selModel = null; hrSel = null;
  $$('.pill').forEach(b => b.classList.remove('on'));
  render();
}

/* ---------------- 数据接入：本机服务 ---------------- */
function setStatus(msg) { const s = $('#scanStatus'); if (s) s.textContent = msg || ''; }
function setScanning(btn, on) {
  if (!btn) return;
  if (on) {
    if (!btn.dataset.label) btn.dataset.label = btn.innerHTML;
    btn.classList.add('scanning'); btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>扫描中…';
  } else {
    btn.classList.remove('scanning'); btn.disabled = false;
    btn.innerHTML = btn.dataset.label || '读取本机日志';
    delete btn.dataset.label;
  }
}
async function fetchServer(demo) {
  const r = await fetch('/api/scan' + (demo ? '?demo=1' : ''), { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (!j || !j.ok) throw new Error((j && j.error) || '服务端返回异常');
  return j;
}
async function probeServer() {
  if (location.protocol === 'file:') return null;
  try {
    const r = await fetch('/api/ping', { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.ok) ? j : null;
  } catch (e) { return null; }
}
function enterDash() {
  document.body.classList.remove('app-loading');
  document.body.classList.add('in-dash');
  const intro = $('#intro');
  if (intro) intro.style.display = 'none';
  $('#dash').style.display = '';
}

/* ---------------- 数据接入：纯浏览器目录 ---------------- */
function idb() {
  return new Promise((res, rej) => {
    try {
      const r = indexedDB.open('td-dir', 1);
      r.onupgradeneeded = () => { try { r.result.createObjectStore('h'); } catch (e) {} };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  });
}
async function idbGet() {
  try {
    const db = await idb();
    return await new Promise(res => {
      const g = db.transaction('h', 'readonly').objectStore('h').get('last');
      g.onsuccess = () => res(g.result || null);
      g.onerror = () => res(null);
    });
  } catch (e) { return null; }
}
async function idbSet(h) {
  try {
    const db = await idb();
    return await new Promise(res => {
      const t = db.transaction('h', 'readwrite');
      t.objectStore('h').put(h, 'last');
      t.oncomplete = () => res(true);
      t.onerror = () => res(false);
    });
  } catch (e) { return false; }
}
async function collect(handle, path, out) {
  for await (const entry of handle.entries()) {
    const name = entry[0], h = entry[1];
    const p = path.concat(name);
    if (h.kind === 'directory') await collect(h, p, out);
    else if (name.slice(-6) === '.jsonl') out.push({ segments: p, entry: h });
  }
}
async function walkEntry(entry, path, out, isRoot) {
  if (entry.isFile) {
    if (entry.name.slice(-6) === '.jsonl') {
      try {
        const f = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ segments: path.concat(entry.name), file: f });
      } catch (e) {}
    }
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  const kids = [];
  while (true) {                                   // readEntries 每次最多 100 条，必须读到空
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    kids.push.apply(kids, batch);
  }
  // 根目录自身的名字不参与路径：拖入 projects 时其子目录才是工作空间（与目录选择器语义一致）
  for (const e of kids) await walkEntry(e, isRoot ? path : path.concat(entry.name), out, false);
}

function bindDrop() {
  let depth = 0;
  document.addEventListener('dragenter', e => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    depth++;
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragover', e => { if (e.dataTransfer) e.preventDefault(); });
  document.addEventListener('dragleave', e => {
    if (!e.dataTransfer) return;
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('dragging');
  });
  document.addEventListener('drop', async e => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    const dt = e.dataTransfer, out = [];
    const entries = [];
    for (const it of Array.from(dt.items || [])) {
      if (it.kind === 'file' && it.webkitGetAsEntry) {
        const en = it.webkitGetAsEntry();
        if (en) entries.push(en);
      }
    }
    if (entries.length) {
      for (const en of entries) await walkEntry(en, [], out, true);
    } else if (dt.files) {
      for (const f of Array.from(dt.files)) {
        if (f.name.slice(-6) === '.jsonl') out.push({ segments: [f.name], file: f });
      }
    }
    if (!out.length) { setStatus('拖入的内容里没有 .jsonl 日志文件'); return; }
    await ingestHandles(out, null);
  });
}

let activePickBtn = null;
async function pickDirectory(btn) {
  btn = btn || $('#scanBtn');
  activePickBtn = btn;
  try {
    if (window.showDirectoryPicker) {
      const opts = {};
      const h0 = await idbGet();
      if (h0) opts.startIn = h0;
      let dir;
      try { dir = await window.showDirectoryPicker(opts); }
      catch (e) {
        if (e && (e.name === 'TypeError' || e.name === 'SecurityError')) dir = await window.showDirectoryPicker();
        else throw e;
      }
      setScanning(btn, true);
      setStatus('正在遍历目录…');
      const files = [];
      await collect(dir, [], files);
      await idbSet(dir);
      await ingestHandles(files, btn);
    } else {
      $('#dirInput').click();
    }
  } catch (e) {
    if (e && e.name !== 'AbortError') setStatus('扫描出错：' + ((e && e.message) || e));
    setScanning(btn, false);
  }
}
async function ingestHandles(files, btn) {
  if (!files.length) { setStatus('未找到 .jsonl 日志文件'); setScanning(btn, false); return; }
  setScanning(btn, true);
  const arr = [];
  for (let i = 0; i < files.length; i++) {
    setStatus('正在读取并解析 ' + (i + 1) + '/' + files.length + ' …');
    const f = files[i];
    let text;
    if (f.entry) text = await (await f.entry.getFile()).text();
    else text = await f.file.text();
    arr.push({ segments: f.segments, text: text });
    if (i % 20 === 19) await new Promise(r => setTimeout(r, 0));   // 让出主线程，避免页面假死
  }
  setStatus('正在聚合…');
  D = buildData(arr);
  serverMode = false;
  enterDash();
  setScanning(btn, false);
  setStatus('');
  render();
}
async function rescan() {
  const btn = $('#rescanBtn');
  if (serverMode) { await loadServer(btn, true); return; }
  const h = await idbGet();
  if (h && h.entries) {
    try {
      let perm = h.queryPermission ? await h.queryPermission({ mode: 'read' }) : 'granted';
      if (perm !== 'granted' && h.requestPermission) perm = await h.requestPermission({ mode: 'read' });
      if (perm === 'granted') {
        setScanning(btn, true);
        const files = [];
        await collect(h, [], files);
        await ingestHandles(files, btn);
        return;
      }
    } catch (e) {}
  }
  location.reload();
}
async function loadServer(btn, silent) {
  if (!silent) setScanning(btn, true);
  try {
    const j = await fetchServer();
    D = j;
    serverMode = true;
    enterDash();
    setScanning(btn, false);
    setStatus('');
    render();
  } catch (e) {
    if (!silent) { setStatus('读取本机日志失败：' + ((e && e.message) || e)); setScanning(btn, false); }
  }
}
/* 第三个入口：示例数据（走 /api/scan?demo=1，服务端返回内置的脱敏数据） */
async function loadDemo(btn) {
  setScanning(btn, true);
  try {
    const j = await fetchServer(true);
    D = j;
    D.demo = true;
    serverMode = true;
    enterDash();
    setScanning(btn, false);
    setStatus('');
    render();
  } catch (e) {
    setStatus('示例数据加载失败：' + ((e && e.message) || e));
    setScanning(btn, false);
  }
}
function setAuto(on) {
  const b = $('#autoBtn');
  if (on) {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = setInterval(async () => {
      try {
        if (serverMode) await loadServer(null, true);
        else {
          const h = await idbGet();
          if (!h || !h.entries) return;
          const perm = h.queryPermission ? await h.queryPermission({ mode: 'read' }) : 'granted';
          if (perm !== 'granted') return;
          const files = [];
          await collect(h, [], files);
          await ingestHandles(files, null);
        }
      } catch (e) { /* 静默 */ }
    }, 5 * 60 * 1000);
    if (b) b.classList.add('on');
  } else {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (b) b.classList.remove('on');
  }
  try { localStorage.setItem('td-auto', on ? '1' : '0'); } catch (e) {}
}
function defaultPath() {
  const ua = navigator.userAgent || '';
  return /Win/i.test(ua) ? '%USERPROFILE%\\.workbuddy\\projects' : '~/.workbuddy/projects';
}
/* 复制文本（剪贴板 API 失败时退回 execCommand），按钮临时显示「已复制」 */
function copyText(txt, btn) {
  const done = () => {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = '已复制'; btn.classList.add('done');
    setTimeout(() => { btn.textContent = old; btn.classList.remove('done'); }, 1400);
  };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    ta.remove();
  };
  if (!txt) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(done, () => { fallback(); done(); });
  } else { fallback(); done(); }
}
/* 返回数据源选择页（清空当前数据集，不重新探测） */
function backToIntro() {
  D = null; LASTA = null;
  state = { ws: null, ses: null };
  selModel = null; hrSel = null;
  document.body.classList.remove('in-dash');
  $('#dash').style.display = 'none';
  const intro = $('#intro');
  if (intro) intro.style.display = '';
  setStatus('');
  window.scrollTo(0, 0);
}

/* ---------------- 事件绑定 ---------------- */
function initUI() {
  const sb = $('#scanBtn'); if (sb) sb.onclick = () => pickDirectory(sb);
  const dlb = $('#demoLocalBtn'); if (dlb) dlb.onclick = () => pickDirectory(dlb);
  const dmb = $('#demoBtn'); if (dmb) dmb.onclick = () => loadDemo(dmb);
  bindDrop();
  const ssb = $('#scanServerBtn'); if (ssb) ssb.onclick = () => loadServer(ssb, false);
  const rb = $('#rescanBtn'); if (rb) rb.onclick = () => rescan();
  const rsb = $('#reselectBtn'); if (rsb) rsb.onclick = () => pickDirectory(rsb);
  const ab = $('#autoBtn'); if (ab) ab.onclick = () => setAuto(!autoTimer);
  try { if (localStorage.getItem('td-auto') === '1') setAuto(true); } catch (e) {}
  const dp = $('#defPath'); if (dp) dp.textContent = defaultPath();
  const dmp = $('#demoPath'); if (dmp) dmp.textContent = defaultPath();
  const cp = $('#copyPathBtn');
  if (cp) cp.onclick = () => copyText($('#defPath').textContent, cp);
  const cdp = $('#copyDemoPath');
  if (cdp) cdp.onclick = () => copyText($('#demoPath').textContent, cdp);
  const bb = $('#backBtn'); if (bb) bb.onclick = backToIntro;
  const di = $('#dirInput');
  if (di) di.onchange = () => {
    const files = [];
    for (const f of di.files) {
      const rp = f.webkitRelativePath || f.name;
      files.push({ segments: rp.split('/').slice(1), file: f });
    }
    ingestHandles(files, activePickBtn);
  };
  const tb = $('#themeBtn');
  if (tb) tb.onclick = () => {
    DARK = !DARK;
    CJ = DARK ? CJD : CJL; MC = DARK ? MC_D : MC_L; RAMP = DARK ? RAMP_D : RAMP_L;
    try { localStorage.setItem('td-dark', DARK ? '1' : '0'); } catch (e) {}
    document.body.classList.toggle('dark', DARK);
    if (D) render();
  };
  if (DARK) document.body.classList.add('dark');
  document.body.classList.add('app-loading');

  $$('.pill').forEach(b => b.onclick = () => {
    win = +b.dataset.w; customStart = 0; customEnd = 0;
    $('#dStart').value = ''; $('#dEnd').value = '';
    selModel = null; hrSel = null;
    $$('.pill').forEach(x => x.classList.toggle('on', x === b));
    render();
  });
  $('#dStart').addEventListener('change', applyCustom);
  $('#dEnd').addEventListener('change', applyCustom);
  $('#wsSearch').addEventListener('input', e => { q = e.target.value.trim().toLowerCase(); renderPanel(aggregate()); });
  $('#wsMult').addEventListener('change', e => { wsMult = +e.target.value; renderPanel(aggregate()); });

  document.addEventListener('click', e => {
    let el;
    if ((el = e.target.closest('.fold-t'))) {
      const card = el.closest('.card');
      if (card) { card.classList.toggle('collapsed'); if (D) render(); }
      return;
    }
    if ((el = e.target.closest('[data-hrm]'))) { const v = +el.dataset.hrm; hrSel = (hrSel === v ? null : v); if (LASTA) renderRidge(LASTA); return; }
    if ((el = e.target.closest('[data-dm]'))) { const v = +el.dataset.dm; selModel = (selModel === v ? null : v); if (LASTA) { renderDailyModel(LASTA); renderTop5(LASTA); } return; }
    if ((el = e.target.closest('[data-a]'))) {
      if (el.dataset.a === 'root') { state = { ws: null, ses: null }; render(); }
      else if (el.dataset.a === 'up' && state.ws !== null) { state = { ws: state.ws, ses: null }; render(); }
      return;
    }
    if ((el = e.target.closest('[data-ws]'))) { state = { ws: +el.dataset.ws, ses: null }; render(); return; }
    if ((el = e.target.closest('[data-si]'))) { const ss = D.sess[+el.dataset.si]; state = { ws: ss.w, ses: ss }; render(); return; }
    if ((el = e.target.closest('[data-ses]'))) { state.ses = D.sess[+el.dataset.ses]; render(); return; }
    if ((el = e.target.closest('#wsTools [data-m]'))) {
      wsMode = el.dataset.m;
      $$('#wsTools [data-m]').forEach(b => b.classList.toggle('on', b === el));
      renderPanel(aggregate()); return;
    }
    if ((el = e.target.closest('#wsSorts .chip'))) {
      wsSort = el.dataset.s;
      $$('#wsSorts .chip').forEach(b => b.classList.toggle('on', b === el));
      renderPanel(aggregate());
    }
  });

  const rzEl = document.querySelector('#dash');
  if (rzEl && typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (!D) return;
      clearTimeout(window._rzT);
      window._rzT = setTimeout(render, 150);
    }).observe(rzEl);
  }

  /* 启动：优先本机服务模式（秒开），否则进入引导页 */
  (async function boot() {
    // 只探测、不自动加载：一进页面必须由用户三选一
    const ping = await probeServer();
    const live = !!(ping && ping.ok);
    const hasLogs = !!(ping && ping.exists);
    const dot = $('#srvDot'), desc = $('#srvDesc'), tag = $('#srvTag'), btn = $('#scanServerBtn');
    const ddot = $('#demoDot'), dtag = $('#demoTag'), dbtn = $('#demoBtn');

    if (live && hasLogs) {
      dot.classList.remove('off');
      tag.textContent = '可用';
      desc.textContent = '已连接到本机服务端，可直接读取这台电脑上的 WorkBuddy 日志，秒开。';
      btn.disabled = false;
    } else if (live) {
      // 服务端在，但这台机器没有日志：这一项实际不可用，保持灰点
      tag.textContent = '无本机日志';
      desc.textContent = '服务端连上了，但这台机器上没有 WorkBuddy 日志（线上读不到你电脑上的文件）。请改用「浏览器读取」。';
      btn.disabled = true;
    } else {
      tag.textContent = '不可用';
      desc.innerHTML = '没有探测到本地服务。启动方式：双击项目里的 <code>启动看板.bat</code>，或在项目目录执行 <code>python server.py</code>。';
      btn.disabled = true;
    }

    if (live) {
      ddot.classList.remove('off');
      dtag.textContent = '可用';
      dbtn.disabled = false;
    } else {
      dtag.textContent = '需服务端';
      dbtn.disabled = true;
    }
    document.body.classList.remove('app-loading');
  })();
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI);
  else initUI();
}
})();
