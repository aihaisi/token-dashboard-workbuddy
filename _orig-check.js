// 用「原站源码里的原始逻辑」在 node 里跑一遍，得到原站口径的聚合结果。
// grab / parse_ts / MODEL_MERGE / 过滤规则 全部照抄 orig.html，不做任何改动。
const fs = require('fs'), path = require('path'), os = require('os');

const MODEL_MERGE = { 'glm-5.2-x': 'glm-5.2' };

function parse_ts(v) {
  if (typeof v === 'number') { return v > 1e12 ? v / 1000 : v; }
  if (typeof v === 'string') {
    let d = Date.parse(v.indexOf(' ') >= 0 ? v.replace(' ', 'T') + (v.includes('Z') ? '' : 'Z') : v);
    if (!isNaN(d)) return d / 1000;
    const n = parseFloat(v); if (!isNaN(n)) return n / 1000;
  }
  return null;
}

function grab(o) {
  const pd = o.providerData;
  if (!pd || typeof pd !== 'object') return null;
  const ru = pd.rawUsage || {}; const u = pd.usage || {};
  const tt = ru.total_tokens || u.totalTokens;
  if (!tt) return null;
  const model = pd.model || pd.requestModelId || pd.requestModelName || 'unknown';
  const ptd = ru.prompt_tokens_details || {};
  let ch = ru.prompt_cache_hit_tokens;
  if (ch == null) ch = ptd.cached_tokens || 0;
  const cw = ptd.cached_creation_tokens || ptd.cache_write_tokens || 0;
  return { tt: +tt, it: +(ru.prompt_tokens || u.inputTokens || 0), ot: +(ru.completion_tokens || u.outputTokens || 0), ch: +(ch || 0), cw: +(cw || 0), model };
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const ROOT = path.join(os.homedir(), '.workbuddy', 'projects');
const files = walk(ROOT, []);
const models = new Set();
let n = 0, tt = 0, it = 0, ot = 0, ch = 0, cw = 0, noTs = 0;

for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    if (!o || typeof o !== 'object') continue;
    const r = grab(o); if (!r) continue;
    r.model = MODEL_MERGE[r.model] || r.model;
    const ts = parse_ts(o.timestamp); if (ts == null) { noTs++; continue; }
    models.add(r.model);
    n++; tt += r.tt; it += r.it; ot += r.ot; ch += r.ch; cw += r.cw;
  }
}

console.log(JSON.stringify({
  files: files.length, records: n, skipped_no_ts: noTs,
  total_tokens: tt, input: it, output: ot, cache_hit: ch, cache_write: cw,
  models: models.size, model_list: [...models].sort()
}, null, 2));
