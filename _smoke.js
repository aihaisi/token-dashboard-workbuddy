/* ============================================================
   WorkBuddy Token 看板 —— 无头冒烟测试
   做法：DOM 桩 + node:vm，直接加载即将交付的 index.html 里的脚本，
        并用真实的 /api/scan 数据跑完整渲染管线。
   运行：node _smoke.js   （需要先启动 server.py）
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HERE = __dirname;
const HTML_PATH = path.join(HERE, 'index.html');
const API = process.env.TD_API || 'http://127.0.0.1:8791/api/scan';

let pass = 0, fail = 0, group = '';
function head(t) { group = t; console.log('\n=== ' + t + ' ==='); }
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  → 实际 ' + JSON.stringify(extra).slice(0, 300) : '')); }
}

/* ---------------- DOM 桩 ---------------- */
function mkEl(tag) {
  tag = tag || 'div';
  const el = {
    tagName: String(tag).toUpperCase(), children: [], dataset: {}, style: {},
    textContent: '', value: '', title: '', hidden: false, disabled: false,
    clientWidth: 800, clientHeight: 400, width: 800, height: 400, _html: '',
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
      toggle(c, f) { if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (f) this._s.add(c); else this._s.delete(c); },
    },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    appendChild(c) { el.children.push(c); return c; },
    insertBefore(c) { el.children.push(c); return c; },
    removeChild() {}, remove() {}, focus() {}, blur() {}, click() {}, select() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    closest() { return mkEl(); },
    querySelector() { return mkEl(); },
    querySelectorAll() { return [mkEl(), mkEl()]; },
    matches() { return false; },
    getContext() { return ctx2d; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 400, right: 800, bottom: 400 }; },
  };
  Object.defineProperty(el, 'innerHTML', { get() { return el._html; }, set(v) { el._html = String(v); } });
  Object.defineProperty(el, 'firstChild', { get() { return el.children[0] || null; } });
  return el;
}
const ctx2d = new Proxy({}, { get(t, p) { return p in t ? t[p] : () => {}; }, set(t, p, v) { t[p] = v; return true; } });

const REG = new Map();
function sel(s) { if (!REG.has(s)) REG.set(s, mkEl(s.indexOf('svg') >= 0 ? 'svg' : 'div')); return REG.get(s); }

async function main() {
  /* ---------------- 准备真实数据 ---------------- */
  let payload = null;
  try {
    const r = await fetch(API);
    payload = await r.json();
  } catch (e) {
    console.log('!! 无法访问 ' + API + '：' + e.message);
    console.log('   请先启动服务：python server.py --no-open');
  }
  const hasData = !!(payload && payload.ok && payload.sess && payload.sess.length);

  /* ---------------- 加载交付文件里的脚本 ---------------- */
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  ok(!!m, 'index.html 中存在内联脚本');
  let src = m[1];

  const EXPORT = `
globalThis.__api={buildData:buildData,aggregate:aggregate,render:render,renderPanel:renderPanel,
  renderHeat:renderHeat,renderModelDist:renderModelDist,hourData:hourData,
  normModel:normModel,grab:grab,parseTs:parseTs,sessionTitle:sessionTitle,priceOf:priceOf,
  effMult:effMult,
  fmt:fmt,money:money,creditFmt:creditFmt,rampLevel:rampLevel,smoothLine:smoothLine,esc:esc,
  setD:function(d){D=d;},getD:function(){return D;},
  setState:function(s){state=s;},getState:function(){return state;},
  setWin:function(w,cs,ce){win=w;customStart=cs||0;customEnd=ce||0;},
  setModel:function(v){selModel=v;},setHr:function(v){hrSel=v;},
  setMult:function(v){wsMult=v;},setMode:function(v){wsMode=v;}};
`;
  const cut = src.lastIndexOf('})();');
  ok(cut > 0, '脚本尾部定位成功（用于注入导出）');
  src = src.slice(0, cut) + EXPORT + '})();';

  const store = Object.create(null);
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      readyState: 'complete',
      querySelector: sel,
      querySelectorAll: () => [mkEl(), mkEl()],
      createElement: t => mkEl(t),
      addEventListener() {}, removeEventListener() {},
      body: mkEl('body'), documentElement: mkEl('html'),
    },
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    setTimeout: (fn) => { if (typeof fn === 'function') setTimeout(fn, 0); return 0; },   // 真实推进，让 boot() 跑完
    clearTimeout: (h) => clearTimeout(h),
    setInterval: () => 0, clearInterval: () => {},
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SmokeTest/1.0', clipboard: null, webdriver: false },
    location: { protocol: 'http:', href: 'http://127.0.0.1:8791/', search: '', hash: '' },
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    indexedDB: { open() { return { onsuccess: null, onerror: null, onupgradeneeded: null }; } },
    fetch: async (url) => {
      const u = String(url);
      if (u.indexOf('/api/ping') >= 0) return { ok: true, json: async () => ({ ok: true, root: 'stub', exists: true }) };
      if (u.indexOf('/api/scan') >= 0) {
        if (!hasData) return { ok: false, status: 503, json: async () => ({ ok: false }) };
        return { ok: true, json: async () => payload };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
    Math, JSON, Date, Array, Object, Number, String, Boolean, Set, Map, WeakMap, Proxy, RegExp, Error,
    Promise, isFinite, isNaN, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, Intl,
    ArrayBuffer, Uint8Array, crypto: { getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = i & 255; return a; } },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  let threw = null;
  try { vm.runInContext(src, sandbox, { filename: 'index.html#script' }); }
  catch (e) { threw = e; }
  ok(!threw, '脚本整体加载无异常', threw && threw.message);
  if (threw) { console.log(threw.stack); process.exit(1); }

  const api = sandbox.__api;
  ok(!!api, '内部对象导出成功');

  /* ================= 1. 纯净性 / 结构自检 ================= */
  head('1. 纯净性与结构自检');
  ok(!/src\s*=\s*["']https?:/i.test(html), '无外部 src 引用');
  ok(!/href\s*=\s*["']https?:/i.test(html), '无外部 href 引用');
  ok(!/@import/i.test(html), '无 CSS @import');
  ok(!/url\(\s*["']?https?:/i.test(html), '无 CSS 远程 url()');
  ok(!/XMLHttpRequest|WebSocket|EventSource/i.test(html), '无 XHR/WebSocket/SSE');
  ok(!/analytics|gtag|umami|baidu|tongji|clarity|hm\.js/i.test(html), '无第三方统计脚本');
  ok((html.match(/fetch\(/g) || []).length <= 4, 'fetch 调用点很少（仅本地 API）', (html.match(/fetch\(/g) || []).length);
  ok(!/console\.log\(|debugger/.test(html), '无调试残留（console.log / debugger）');
  ok(!html.includes('daemedia'), '不含原站域名：这是独立实现，不是镜像');
  ok(/font-CJK|PingFang SC|Microsoft YaHei/.test(html), '包含中文字体栈');

  // 首屏信息层级：重要的模型总量排行置顶全宽，不重要的两张默认折叠
  ok(html.indexOf('class="card hero" id="mtCard"') >= 0, '模型总量排行是首屏主卡片（hero）');
  ok(html.indexOf('class="card hero" id="mcCard"') >= 0, '模型积分排行与总量排行并排（hero-grid）');
  ok(html.indexOf('class="card hero" id="mvCard"') >= 0, '模型性价比排行是第三列（三列等高）');
  ok(html.indexOf('class="hero-grid"') >= 0 && html.indexOf('class="mid-grid"') > html.indexOf('class="hero-grid"'), '中区位于模型排行区之后');
  ok(html.indexOf('class="bot-grid"') > html.indexOf('class="mid-grid"'), '工作空间/日活位于页面最下方（bot-grid）');
  ok(/id="wsCard"/.test(html) && !/class="card collapsed" id="wsCard"/.test(html), '工作空间活跃分布默认展开');
  ok(/id="heatCard"/.test(html) && !/class="card collapsed" id="heatCard"/.test(html), '日活分布默认展开');
  ok((html.match(/class="fold-t"/g) || []).length === 2, '两张卡仍可手动折叠');
  ok(!/querySelector\(['"]\.(wrap|colL|colR)['"]\)/.test(html), '代码不引用已删除的 .wrap/.colL/.colR 容器（防止 observe(null) 中断启动）');

  /* ================= 2. 纯函数单元断言 ================= */
  head('2. 解析与归一（纯函数）');
  ok(api.normModel('DeepSeek-V4-Flash') === 'deepseek-v4-flash', '大小写归一：DeepSeek-V4-Flash → deepseek-v4-flash', api.normModel('DeepSeek-V4-Flash'));
  ok(api.normModel('glm-5.2-x') === 'glm-5.2', '别名合并：glm-5.2-x → glm-5.2', api.normModel('glm-5.2-x'));
  ok(api.normModel('tencent/hy3-preview-20260421:free') === 'hy3-preview-20260421', '去供应商前缀与 :free 后缀', api.normModel('tencent/hy3-preview-20260421:free'));
  ok(api.normModel('cmcc:auto') === 'auto', 'cmcc:auto → auto');
  ok(api.normModel(undefined) === 'unknown', '缺失模型名 → unknown');

  const rec = {
    providerData: {
      model: 'auto', rawUsage: {
        prompt_tokens: 37214, completion_tokens: 273, total_tokens: 37487,
        prompt_tokens_details: { cached_tokens: 16128 },
        prompt_cache_hit_tokens: 16128, cache_creation_input_tokens: 0, credit: 4.03,
      },
    },
  };
  const g = api.grab(rec);
  ok(g && g.tt === 37487 && g.it === 37214 && g.ot === 273, 'grab() 抽取 token 三个分量', g);
  ok(g.ch === 16128, 'grab() 抽取缓存命中', g.ch);
  ok(g.cr === 4.03, 'grab() 抽取真实 credit（原站未使用该字段）', g.cr);
  ok(api.grab({ providerData: { agent: 'cli' } }) === null, '无用量记录 → null（不误判）');
  ok(api.grab({}) === null, '无 providerData → null');

  ok(api.parseTs(1783328463625) === 1783328463.625, '毫秒时间戳 → 秒');
  ok(api.parseTs(1783328463) === 1783328463, '秒时间戳保持不变');
  ok(Math.abs(api.parseTs('2026-07-06T21:35:54Z') - 1783373754) < 2, 'ISO 字符串可解析', api.parseTs('2026-07-06T21:35:54Z'));
  ok(api.parseTs(null) === null, '空时间戳 → null');

  ok(api.sessionTitle({ role: 'user', content: '<system-reminder>x</system-reminder>' }) === null, '纯系统注入 → 无标题（不产生垃圾标题）');
  const t1 = api.sessionTitle({ role: 'user', content: '<system-reminder data-role="user-context">巨大的注入块</system-reminder>\n\n<user_query>https://token.daemedia.cn/\n能不能本地复刻</user_query>' });
  ok(!!t1 && t1.indexOf('能不能本地复刻') >= 0, '从 <user_query> 里取出真实提问', t1);
  const t2 = api.sessionTitle({ role: 'user', content: [{ type: 'input_text', text: '帮我写个 Shader' }] });
  ok(t2 === '帮我写个 Shader', '数组型 content 的纯文本可作标题', t2);

  ok(api.priceOf('deepseek-v4-flash')[0] === 1, '价目表前缀匹配命中 deepseek-v4-flash');
  ok(api.priceOf('某个没见过的模型')[0] === 2, '未知模型回落到默认价');
  ok(api.rampLevel(0, 100) === 0, '色阶：0 值 → 第 0 档（灰）');
  ok(api.rampLevel(1e9, 1) === 7, '色阶：极大值 → 封顶第 7 档');
  ok(api.rampLevel(1, 1) >= 1 && api.rampLevel(1, 1) <= 7, '色阶：小正值落在 1..7', api.rampLevel(1, 1));
  api.setMult(3);
  ok(api.effMult(30) === 3, '倍率：30 天窗口下 3X 保持不变', api.effMult(30));
  ok(api.effMult(140) === 1, '倍率：140 天窗口下 3X 自动降到 1X（防色块被裁掉）', api.effMult(140));
  ok(api.effMult(5000) === 1, '倍率：极长窗口下仍 >= 1（不会降成 0 格）', api.effMult(5000));
  api.setMult(6);
  ok(api.effMult(50) === 3, '倍率：50 天窗口下 6X 降到 3X（150/50=3）', api.effMult(50));
  api.setMult(1);
  ok(api.effMult(30) === 1, '倍率：1X 不再继续降', api.effMult(30));
  api.setMult(3);
  ok(api.fmt(0) === '0' && api.fmt(12345) === '1.2 万' && api.fmt(123456789) === '1.23 亿', '数值中文缩写', [api.fmt(0), api.fmt(12345), api.fmt(123456789)]);
  ok(api.esc('<img src=x onerror=1>').indexOf('<img') < 0, 'HTML 转义生效（XSS 防护）');
  ok(api.smoothLine([[0, 0], [10, 5], [20, 0]]).indexOf('C') > 0, '插值曲线包含三次贝塞尔段');

  /* ================= 3. buildData 解析管线 ================= */
  head('3. buildData（纯浏览器模式的解析管线）');
  const mkLines = (sid, cwd, rows) => rows.map(r => JSON.stringify({
    timestamp: Date.UTC(2026, 8, 10, 10, 0) + r[0] * 1000, sessionId: sid, cwd: cwd, role: 'assistant',
    providerData: { model: r[1], rawUsage: { prompt_tokens: r[2], completion_tokens: r[3], total_tokens: r[2] + r[3], prompt_cache_hit_tokens: 0, credit: r[4] } },
  })).join('\n') + '\n' + JSON.stringify({ timestamp: Date.UTC(2026, 8, 10, 9, 0), sessionId: sid, cwd: cwd, role: 'user', content: '<user_query>测试会话标题</user_query>' });

  const files = [
    { segments: ['c-Users-x-WorkBuddy-Claw', 'aaaa1111.jsonl'], text: mkLines('aaaa1111-0000', 'C:\\Users\\x\\WorkBuddy\\Claw', [[0, 'deepseek-v4.1-flash', 100, 10, 1], [60, 'hy3', 200, 20, 0]]) },
    { segments: ['d-WBProject', 'bbbb2222.jsonl'], text: mkLines('bbbb2222-0000', 'd:\\WBProject', [[0, 'glm-5.2', 300, 30, 2]]) },
  ];
  const BD = api.buildData(files);
  ok(BD.ws.length === 2, '工作空间去重 → 2 个', BD.ws);
  ok(BD.ws[0] === 'Claw', '工作空间名剥离 -WorkBuddy- 前缀 → Claw', BD.ws[0]);
  ok(BD.models.length === 3, '模型去重 → 3 个', BD.models);
  ok(BD.sess.length === 2, '会话数 = 2', BD.sess.length);
  const flat = BD.sess.reduce((a, s) => a.concat(s.r), []);
  ok(flat.length === 3, '用量记录数 = 3', flat.length);
  ok(flat.reduce((a, r) => a + r[2], 0) === 660, '总 token = 660', flat.reduce((a, r) => a + r[2], 0));
  ok(flat.reduce((a, r) => a + r[7], 0) === 3, 'credit 汇总 = 3', flat.reduce((a, r) => a + r[7], 0));
  ok(BD.sess.every(s => s.r.length > 0 && s.st !== undefined), '每个会话都有记录且带起始时间');
  ok(BD.sess.every(s => s.t === '测试会话标题'), '会话标题被正确提取', BD.sess.map(s => s.t));
  ok(BD.sess.every(s => s.r.every((r, i, a) => i === 0 || a[i - 1][0] <= r[0])), '会话内记录按时间升序');
  const empty = api.buildData([{ segments: ['x', 'y.jsonl'], text: 'not json\n' }]);
  ok(empty.sess.length === 0 && empty.models.length === 0, '无用量文件不产生空会话（不污染统计）');
  const badLines = api.buildData([{ segments: ['x', 'z.jsonl'], text: '{"broken"\n\n   \n{"a":1}\n' }]);
  ok(badLines.sess.length === 0, '坏行被吞掉而非抛异常');

  /* ================= 4. 端到端：真实数据 + 全量渲染 ================= */
  head('4. 端到端渲染（真实日志数据）');
  if (!hasData) {
    console.log('  SKIP 未取到 /api/scan 数据，跳过端到端断言（请先启动 server.py）');
  } else {
    ok(payload.models.length > 0 && payload.ws.length > 0, '真实数据含模型与工作空间', [payload.models.length, payload.ws.length]);
    api.setD(payload);
    api.setWin(100000);                       // 窗口开到极大 = 全部数据
    api.setMult(3);

    let rErr = null;
    try { api.render(); } catch (e) { rErr = e; }
    ok(!rErr, 'render() 全量渲染无异常', rErr && (rErr.message + ' @ ' + (rErr.stack || '').split('\n')[1]));
    if (rErr) { console.log(rErr.stack); process.exit(1); }

    const A = api.aggregate();

    // 独立重算一遍总 token，与 aggregate() 对拍
    let expTok = 0, expCredit = 0, expTurns = 0, expIn = 0, expOut = 0, expCh = 0;
    for (const s of payload.sess) for (const r of s.r) {
      expTok += r[2]; expCredit += r[7]; expTurns++; expIn += r[3]; expOut += r[4]; expCh += r[5];
    }
    ok(A.tot === expTok, '合计 Token 与独立重算一致', [A.tot, expTok]);
    ok(Math.abs(A.cr - expCredit) < 1e-6, '真实 Credit 与独立重算一致', [A.cr, expCredit]);
    ok(A.turns === expTurns, '轮次与独立重算一致', [A.turns, expTurns]);
    ok(A.inp === expIn && A.out === expOut && A.ch === expCh, '输入/输出/缓存与独立重算一致');
    ok(A.cr > 0, '存在真实 credit 数据（>0）', A.cr);
    ok(A.est > 0, '参考估价 > 0', A.est);
    ok(A.nsess === payload.sess.length, '会话数与数据源一致', [A.nsess, payload.sess.length]);

    const cr = A.inp ? A.ch / A.inp * 100 : 0;
    ok(cr >= 0 && cr <= 100, '缓存命中率为合法百分比 0..100', cr);
    ok(A.inp / Math.max(1, A.out) >= 1, '输入量不小于输出量（符合 LLM 使用特征）', A.inp / Math.max(1, A.out));

    // 窗口过滤：宽窗口 ⊇ 窄窗口
    api.setWin(30); api.render(); const A30 = api.aggregate();
    api.setWin(7); api.render(); const A7 = api.aggregate();
    api.setWin(1); api.render(); const A1 = api.aggregate();
    ok(A1.tot <= A7.tot && A7.tot <= A30.tot && A30.tot <= A.tot, '窗口过滤单调：1天 ≤ 7天 ≤ 30天 ≤ 全部', [A1.tot, A7.tot, A30.tot, A.tot]);
    ok(A30.tot > 0, '近 30 天有数据', A30.tot);
    const day30 = Object.keys(A30.daily).length;
    ok(day30 > 0 && day30 <= 31, '近 30 天窗口内天数在 1..31', day30);
    ok(A30.band.reduce((a, b) => a + b, 0) === A30.tot, '四时段占比之和 = 总量（无漏算）', [A30.band.reduce((a, b) => a + b, 0), A30.tot]);
    ok(Object.keys(A30.dm).length === day30, '每日模型矩阵天数 = 有数据天数');

    // 缓存命中恒不超过输入量（定价计算依赖这个前提）
    let badCache = 0;
    for (const s of payload.sess) for (const r of s.r) if (r[5] > r[3]) badCache++;
    ok(badCache === 0, '缓存命中 token 从不超过输入 token（定价公式前提）', badCache);

    // 渲染产物落盘检查
    api.setWin(30); api.render();
    const need = ['#kpis', '#heatWrap', '#band4', '#panel', '#top5', '#mdSvg', '#mtSvg', '#mcSvg', '#mvSvg', '#rdSvg', '#dmSvg', '#hhead', '#footNote', '#rdLegend', '#heatLegend'];
    const missing = need.filter(s => !sel(s)._html || sel(s)._html.length < 20);
    ok(missing.length === 0, '所有图表容器都产出了内容', missing);
    ok(sel('#kpis')._html.indexOf('真实 Credit') >= 0, 'KPI 中含「真实 Credit」卡片');
    ok(sel('#kpis')._html.indexOf('参考估价') >= 0, 'KPI 中含「参考估价」卡片');
    ok((sel('#heatWrap')._html.match(/hcell/g) || []).length > 100, '热力图格子数量充足', (sel('#heatWrap')._html.match(/hcell/g) || []).length);
    ok(sel('#top5')._html.indexOf('class="t5') >= 0, '模型卡片已渲染');
    ok(sel('#panel')._html.indexOf('wcard') >= 0, '工作空间列表已渲染');
    // 长窗口下的方块密度：每行格数不得超过 MAXCELLS（防溢出裁切）
    (function () {
      api.setWin(100000); api.setMode('ws'); api.render();
      const m = sel('#panel')._html.match(/class="wviz">([\s\S]*?)(?=<div class="wcard"|$)/);
      const nDays = Object.keys(api.aggregate().daily).length;
      const cells = m ? (m[1].match(/wcell/g) || []).length : 0;
      ok(nDays === 0 || cells / nDays <= 150, '长窗口下每行色块数 <= 150（不会被 overflow 裁掉）', [cells, nDays, Math.round(cells / Math.max(1, nDays))]);
      api.setWin(30); api.render();
    })();
    ok(sel('#panel')._html.indexOf('NaN') < 0, '面板文案无 NaN');
    ok(sel('#kpis')._html.indexOf('NaN') < 0, 'KPI 无 NaN');
    ok(sel('#top5')._html.indexOf('undefined') < 0, '模型卡片无 undefined');
    ok(/<\/(svg|section|table)>/.test(sel('#mdSvg')._html) || sel('#mdSvg')._html.indexOf('<path') >= 0, '请求大小分布图产出 SVG 图元');

    // 模型总量排行：每行数值 = 该模型窗口内累计 token（独立重算对拍，30 天窗口）
    (function () {
      const html = sel('#mtSvg')._html;
      const cut = payload.genMs - 30 * 86400e3;
      const totBy = {};
      for (const s of payload.sess) for (const r of s.r) {
        if (r[0] * 60000 < cut) continue;
        totBy[r[1]] = (totBy[r[1]] || 0) + r[2];
      }
      const order = Object.keys(totBy).map(Number).sort((a, b) => totBy[b] - totBy[a]);
      const mismatch = [];
      for (const mi of order) {
        const nameEsc = api.esc(payload.models[mi]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const expect = api.fmt(totBy[mi]);
        // 行结构：模型名 text → 背景条 rect → 前景条 rect → 数值 text（名字后第一个 text 即数值）
        const m = new RegExp('>' + nameEsc + '</text>[\\s\\S]*?<text[^>]*>([^<]*)</text>').exec(html);
        if (!m || m[1] !== expect) mismatch.push([payload.models[mi], m ? m[1] : null, expect]);
      }
      ok(order.length > 0 && mismatch.length === 0, '模型总量排行 = 独立重算的每模型窗口累计', mismatch);
      ok((html.match(/<rect/g) || []).length >= order.length * 2, '总量排行每行有背景轨 + 前景条', (html.match(/<rect/g) || []).length);
    })();

    // 模型积分排行：数值 = 该模型窗口内 credit 累计（独立重算对拍，30 天窗口）
    (function () {
      const html = sel('#mcSvg')._html;
      const cut = payload.genMs - 30 * 86400e3;
      const crBy = {};
      for (const s of payload.sess) for (const r of s.r) {
        if (r[0] * 60000 < cut) continue;
        crBy[r[1]] = (crBy[r[1]] || 0) + r[7];
      }
      const order = Object.keys(crBy).map(Number).filter(i => crBy[i] > 0).sort((a, b) => crBy[b] - crBy[a]);
      const mismatch = [];
      for (const mi of order) {
        const nameEsc = api.esc(payload.models[mi]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const expect = api.creditFmt(crBy[mi]);
        const m = new RegExp('>' + nameEsc + '</text>[\\s\\S]*?<text[^>]*>([^<]*)</text>').exec(html);
        if (!m || m[1] !== expect) mismatch.push([payload.models[mi], m ? m[1] : null, expect]);
      }
      ok(order.length > 0 && mismatch.length === 0, '模型积分排行 = 独立重算的每模型窗口 credit 累计', mismatch);

    // 性价比排行：数值 = Token ÷ Credit（仅 credit>0 的模型，独立重算对拍）
    (function () {
      const html = sel('#mvSvg')._html;
      const cut = payload.genMs - 30 * 86400e3;
      const tk = {}, cr = {};
      for (const s of payload.sess) for (const r of s.r) {
        if (r[0] * 60000 < cut) continue;
        tk[r[1]] = (tk[r[1]] || 0) + r[2];
        cr[r[1]] = (cr[r[1]] || 0) + r[7];
      }
      const order = Object.keys(cr).map(Number).filter(i => cr[i] > 0);
      const mismatch = [];
      for (const mi of order) {
        const nameEsc = api.esc(payload.models[mi]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const expect = api.fmt(tk[mi] / cr[mi]);
        const m = new RegExp('>' + nameEsc + '</text>[\\s\\S]*?<text[^>]*>([^<]*)</text>').exec(html);
        if (!m || m[1] !== expect) mismatch.push([payload.models[mi], m ? m[1] : null, expect]);
      }
      ok(order.length > 0 && mismatch.length === 0, '性价比排行 = 独立重算的 Token÷Credit', mismatch);
    })();
      const mtRects = (sel('#mtSvg')._html.match(/<rect/g) || []).length;
      const mcRects = (html.match(/<rect/g) || []).length;
      ok(mtRects === mcRects && mtRects > 0, '总量/积分两卡行数一致（credit=0 的模型也占一行）', [mtRects, mcRects]);
    })();

    // 下钻：工作空间 → 会话 → 单请求
    const withData = A30.sessAgg[0].s;
    api.setState({ ws: withData.w, ses: null });
    let dErr = null;
    try { api.render(); } catch (e) { dErr = e; }
    ok(!dErr, '下钻到工作空间可渲染', dErr && dErr.message);
    api.setState({ ws: withData.w, ses: withData });
    dErr = null;
    try { api.render(); } catch (e) { dErr = e; }
    ok(!dErr, '下钻到会话详情可渲染', dErr && dErr.message);
    ok(sel('#reqView')._html.indexOf('<svg') >= 0, '会话详情产出散点图');
    ok(sel('#crumb')._html.indexOf('data-a="root"') >= 0, '面包屑提供返回入口');

    // 单模型高亮路径
    api.setModel(0);
    dErr = null;
    try { api.render(); } catch (e) { dErr = e; }
    ok(!dErr, '高亮单模型可渲染', dErr && dErr.message);
    api.setModel(null);

    // 按会话视图 + 倍率切换（先把下钻状态复位，回到列表视图）
    api.setState({ ws: null, ses: null });
    api.setMode('ses'); api.setMult(6);
    dErr = null;
    try { api.render(); } catch (e) { dErr = e; }
    ok(!dErr, '按会话视图 + 6X 倍率可渲染', dErr && dErr.message);
    ok(sel('#panel')._html.indexOf('wcard') >= 0, '按会话视图产出卡片');
    api.setMode('ws'); api.setMult(3);

    // 极端窗口兜底：0 天窗口不应崩
    api.setWin(0, 0, 0);
    dErr = null;
    try { api.render(); } catch (e) { dErr = e; }
    ok(!dErr, '空窗口（无数据）不崩溃', dErr && dErr.message);
    ok(sel('#heatWrap')._html.indexOf('无数据') >= 0 || sel('#heatWrap')._html.length > 0, '空窗口有兜底提示');

    // 单条记录会话：极短会话不应崩
    const mini = { ok: true, genMs: payload.genMs, gen: payload.gen, root: 'stub', ws: ['mini'], models: ['hy3'], stats: { files: 1, parsed: 1, reused: 0, records: 1, scanMs: 1 },
      sess: [{ w: 0, id: 'minisess', t: '单条测试', st: Math.floor(payload.genMs / 60000), r: [[Math.floor(payload.genMs / 60000), 0, 1234, 1000, 234, 0, 0, 0.5]] }] };
    api.setD(mini); api.setWin(10);
    dErr = null;
    try { api.render(); } catch (e) { dErr = e; }
    ok(!dErr, '单记录极简数据集可渲染（边界）', dErr && dErr.message);
    ok(api.aggregate().tot === 1234, '极简数据集总量正确', api.aggregate().tot);

    // 空数据集：必须完全静默兜底
    api.setD({ ok: true, genMs: Date.now(), gen: 'x', root: null, ws: [], models: [], sess: [], stats: {} });
    api.setWin(30);
    dErr = null;
    try { api.render(); } catch (e) { dErr = e; }
    ok(!dErr, '完全空数据集不崩溃', dErr && dErr.message);
    ok(api.aggregate().tot === 0, '空数据集总量为 0');
  }

  console.log('\n────────────────────────────');
  console.log('  通过 ' + pass + ' · 失败 ' + fail);
  console.log('────────────────────────────\n');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
