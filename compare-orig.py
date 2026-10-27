# -*- coding: utf-8 -*-
"""与线上原站（token.daemedia.cn）的口径对拍。

同一份日志，同时按两套口径算：
  A) 原站口径 —— 原始模型名 + 其硬编码价目表(MODEL_MERGE 只合并 glm-5.2-x) -> 预估金额（元）
  B) 本看板   —— 归一模型名 + 日志 credit 字段 -> 真实计费

原站价目表与合并表抓取于 2026-09-19，若原站后续改动需重新抓取核对。

用法：
    python compare-orig.py
"""
import os
import sys
import json
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402

ROOT = server.default_root()

# ==== 原站 PRICE 表，顺序与 JS 对象字面量一致（startsWith 首个命中即返回，顺序影响结果）====
PRICE = [
    ("deepseek-v4-flash", (1, 4, 0.2)),
    ("deepseek-v4-pro", (2, 8, 0.5)),
    ("deepseek", (2, 8, 0.5)),
    ("glm-5.3", (2, 8, 0.4)),
    ("glm-5.2-x", (1.2, 6, 0.24)),
    ("glm-5.2", (0.8, 3.2, 0.16)),
    ("glm", (1, 4, 0.2)),
    ("kimi", (1.5, 6, 0.3)),
    ("claude-opus-5", (150, 750, 15)),
    ("claude-opus-4-8", (110, 550, 11)),
    ("claude", (110, 550, 11)),
    ("qwen", (2.4, 9.6, 0.48)),
    ("hy3", (4, 16, 0.8)),
    ("hy", (4, 16, 0.8)),
    ("minimax", (1, 5, 0.2)),
    ("m3", (1, 5, 0.2)),
]
DEFAULT_P = (2, 8, 0.4)
# 原站只有这一条合并规则
MODEL_MERGE = {"glm-5.2-x": "glm-5.2"}


def price_of(name):
    n = (name or "").lower()
    for k, v in PRICE:
        if n.startswith(k):
            return v, k
    return DEFAULT_P, "(默认价)"


def orig_model(raw):
    """原站的模型名处理：仅应用 MODEL_MERGE，不做大小写/前缀/后缀归一。"""
    return MODEL_MERGE.get(raw, raw)


def cost_orig_one(x):
    """原站逐条计费：缓存命中按命中价、缓存写入按 1.25 倍输入价、其余输入按输入价、输出按输出价。"""
    p, key = price_of(orig_model(x["raw"]))
    cht = max(0.0, min(x["ch"], x["it"]))
    cwt = max(0.0, min(x["cw"], x["it"] - cht))
    return (cht * p[2] + cwt * 1.25 * p[0] + (x["it"] - cht - cwt) * p[0]
            + x["ot"] * p[1]) / 1e6, key


def collect():
    out = []
    nfiles = 0
    for dp, _dn, fns in os.walk(ROOT):
        for fn in fns:
            if not fn.endswith(".jsonl"):
                continue
            nfiles += 1
            try:
                with open(os.path.join(dp, fn), "r", encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        if '"total_tokens"' not in line and '"totalTokens"' not in line:
                            continue
                        try:
                            o = json.loads(line)
                        except Exception:
                            continue
                        if not isinstance(o, dict):
                            continue
                        r = server.grab(o)
                        if not r:
                            continue
                        ts = server.parse_ts(o.get("timestamp"))
                        if ts is None:
                            continue
                        pd = o.get("providerData") or {}
                        raw = (pd.get("model") or pd.get("requestModelId")
                               or pd.get("requestModelName") or "unknown")
                        out.append({
                            "ts": ts, "raw": raw, "norm": server.norm_model(raw),
                            "tt": r["tt"], "it": r["it"], "ot": r["ot"],
                            "ch": r["ch"], "cw": r.get("cw", 0), "cr": r.get("cr", 0),
                        })
            except OSError:
                continue
    return out, nfiles


def report(label, recs):
    if not recs:
        print(f"\n[{label}] 无数据")
        return
    s = lambda k: sum(x[k] for x in recs)          # noqa: E731
    tt, it, ot, ch, cr = s("tt"), s("it"), s("ot"), s("ch"), s("cr")
    co = sum(cost_orig_one(x)[0] for x in recs)
    dset = {time.strftime("%m-%d", time.localtime(x["ts"])) for x in recs}
    fmt = lambda t: time.strftime("%Y-%m-%d", time.localtime(t))   # noqa: E731
    print(f"\n{'=' * 64}\n[{label}]")
    print(f"  记录 {len(recs):,} 条 · 覆盖 {len(dset)} 天 · "
          f"{fmt(min(x['ts'] for x in recs))} → {fmt(max(x['ts'] for x in recs))}")
    print(f"  合计 Token {tt:,.0f}   输入 {it:,.0f}   输出 {ot:,.0f}   "
          f"缓存命中 {ch:,.0f} ({100 * ch / it if it else 0:.1f}%)   缓存写入 {s('cw'):,.0f}")
    print("  ------------------------------------------------------------------")
    print(f"  原站网页显示        预估金额  ¥{co:>10,.2f}   <-- 硬编码价目表")
    print(f"  本地看板显示        真实Credit {cr:>10,.2f}   <-- 日志 credit 字段")
    if cr:
        print(f"  差异倍数                    {co / cr:>10.4f}x   (原站估计 / 真实计费)")


def model_breakdown(recs):
    print(f"\n{'=' * 64}\n模型名写法与两种计费口径对照")
    agg = {}
    for x in recs:
        a = agg.setdefault((x["raw"], x["norm"]), {"n": 0, "tt": 0, "cost": 0.0, "cr": 0.0})
        a["n"] += 1
        a["tt"] += x["tt"]
        a["cr"] += x["cr"]
        a["cost"] += cost_orig_one(x)[0]
    rows = sorted(agg.items(), key=lambda kv: -kv[1]["tt"])
    print(f"{'原始写法':<34}{'本看板归一后':<20}{'条数':>7}{'token':>13}"
          f"{'原站¥/M':>10}{'credit/M':>10}{'倍数':>8}")
    for (raw, norm), a in rows:
        _p, key = price_of(orig_model(raw))
        mt = a["tt"] / 1e6 if a["tt"] else 0
        cpm = a["cost"] / mt if mt else 0
        rpm = a["cr"] / mt if mt else 0
        ratio = (cpm / rpm) if rpm else 0
        flag = "  <-价目表未命中" if key == "(默认价)" else ""
        print(f"{raw[:32]:<34}{norm[:18]:<20}{a['n']:>7,}{a['tt']:>13,.0f}"
              f"{cpm:>10.2f}{rpm:>10.2f}{ratio:>8.2f}{flag}")
    print(f"\n原站口径模型数 {len({orig_model(k[0]) for k in agg})} 种 · "
          f"本看板 {len({k[1] for k in agg})} 种（原始写法 {len({k[0] for k in agg})} 种）")


if __name__ == "__main__":
    t0 = time.time()
    recs, nfiles = collect()
    print(f"扫描 {nfiles} 个日志文件 · {len(recs):,} 条用量记录 · 耗时 {time.time() - t0:.1f}s")
    now = time.time()
    report(f"近 30 天（原站默认窗口，基准 {time.strftime('%Y-%m-%d %H:%M', time.localtime(now))}）",
           [x for x in recs if x["ts"] >= now - 30 * 86400])
    report("全部窗口", recs)
    model_breakdown([x for x in recs if x["ts"] >= now - 30 * 86400])
