#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WorkBuddy Token 看板 —— 本地服务端

职责：
  1. 静态托管 index.html（同目录）
  2. GET /api/scan  服务端直读本机 WorkBuddy 会话日志，抽取 token 用量后返回紧凑 JSON

为什么要有服务端：
  纯前端方案需要浏览器把 100+ 个 jsonl（本机约 140 MB）全部读进内存再逐行 JSON.parse，
  首屏要等十几秒、峰值内存到 GB 级。这里在服务端只抽取需要的字段（约 200 KB），
  并用 (路径, mtime, 大小) 做增量缓存，重扫基本是毫秒级。

数据不出本机：只监听 127.0.0.1，不请求任何外部地址。
"""

import argparse
import json
import os
import re
import socket
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
DEMO_FILE = os.path.join(HERE, "demo-scan.json")

# ---------------------------------------------------------------- 演示数据
# 线上部署（或本机尚未产生日志）时没有真实日志可读，回退到内置的脱敏示例数据：
#   - 工作空间名、会话标题已全部匿名化（见 _make-demo.py）
#   - 每次请求把时间轴整体平移到「现在」，保证任何日期访问都有近 30 天数据
def load_demo() -> dict:
    with open(DEMO_FILE, "r", encoding="utf-8") as fh:
        d = json.load(fh)
    recs = [r for s in d.get("sess", []) for r in s.get("r", [])]
    if recs:
        shift = int(time.time() // 60) - max(r[0] for r in recs)
        if shift:
            for s in d["sess"]:
                for r in s["r"]:
                    r[0] += shift
                if s["r"]:
                    s["st"] = s["r"][0][0]
    now = time.time()
    d["genMs"] = int(now * 1000)
    d["gen"] = time.strftime("%Y-%m-%d %H:%M", time.localtime(now))
    d["root"] = ""
    d["demo"] = True
    return d


# ---------------------------------------------------------------- 日志根目录

def default_root() -> str:
    env = os.environ.get("WORKBUDDY_PROJECTS")
    if env:
        return os.path.expandvars(os.path.expanduser(env))
    return os.path.join(os.path.expanduser("~"), ".workbuddy", "projects")


# ---------------------------------------------------------------- 模型名归一
# 归一的目的：同一模型在日志里有多种写法（大小写、带供应商前缀、带 :free 后缀），
# 不归一会被统计成多个模型，按模型的图表就废了。
ALIAS_PREFIX = "tencent/"
ALIAS_EXACT = {
    "glm-5.2-x": "glm-5.2",           # 同一代模型的变体，合并
    "cmcc:auto": "auto",
}


def norm_model(raw: str) -> str:
    m = (raw or "unknown").strip()
    low = m.lower()
    if low in ALIAS_EXACT:
        return ALIAS_EXACT[low]
    if low.startswith(ALIAS_PREFIX):
        m = m[len(ALIAS_PREFIX):]
        low = m.lower()
    # 去掉 ":free" / ":xxx" 后缀（保留主体模型名）
    if ":" in low:
        m = m.split(":", 1)[0]
        low = m.lower()
    if low in ALIAS_EXACT:
        return ALIAS_EXACT[low]
    return low          # 统一小写，避免 DeepSeek-V4-Flash / deepseek-v4-flash 被拆开


# ---------------------------------------------------------------- 用量抽取

def _num(v, d=0.0):
    try:
        if v is None:
            return d
        return float(v)
    except (TypeError, ValueError):
        return d


def grab(rec: dict):
    """从一条日志记录里抽出用量；抽不到返回 None。

    字段路径来自 WorkBuddy 会话日志的实际结构：
      providerData.rawUsage.total_tokens / prompt_tokens / completion_tokens
      providerData.rawUsage.prompt_cache_hit_tokens（或 prompt_tokens_details.cached_tokens）
      providerData.rawUsage.cache_creation_input_tokens（缓存写入）
      providerData.rawUsage.credit（真实计费值，原站没有用到）
    """
    pd = rec.get("providerData")
    if not isinstance(pd, dict):
        return None
    ru = pd.get("rawUsage")
    if not isinstance(ru, dict):
        ru = {}
    u = pd.get("usage")
    if not isinstance(u, dict):
        u = {}

    total = ru.get("total_tokens") or u.get("totalTokens")
    if not total:
        return None

    ptd = ru.get("prompt_tokens_details") or {}
    if not isinstance(ptd, dict):
        ptd = {}
    hit = ru.get("prompt_cache_hit_tokens")
    if hit is None:
        hit = ptd.get("cached_tokens", 0)
    write = ru.get("cache_creation_input_tokens")
    if not write:
        write = ru.get("prompt_cache_write_tokens") or ptd.get("cache_write_tokens", 0)

    model = pd.get("model") or pd.get("requestModelId") or pd.get("requestModelName") or "unknown"

    return {
        "tt": _num(total),
        "it": _num(ru.get("prompt_tokens") or u.get("inputTokens")),
        "ot": _num(ru.get("completion_tokens") or u.get("outputTokens")),
        "ch": _num(hit),
        "cw": _num(write),
        "cr": _num(ru.get("credit")),
        "model": norm_model(str(model)),
    }


def parse_ts(v):
    """时间戳统一成「秒」。日志里是毫秒整数，但兼容 ISO 字符串 / 秒整数。"""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v) / 1000.0 if v > 1e12 else float(v)
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        try:
            import datetime
            if " " in s:
                s2 = s.replace(" ", "T")
                if not s2.endswith("Z"):
                    s2 += "Z"
            else:
                s2 = s
            dt = datetime.datetime.fromisoformat(s2.replace("Z", "+00:00"))
            return dt.timestamp()
        except Exception:
            pass
        try:
            n = float(s)
            return n / 1000.0 if n > 1e12 else n
        except ValueError:
            return None
    return None


# 用户真正的输入被包在 <user_query> 里，外面还套着巨大的 <system-reminder>。
# 原站只看「是否以 < 开头」，导致所有会话标题都取不到；这里先解 <user_query>，
# 再显式跳过各类系统注入块。
_RE_USER_QUERY = re.compile(r"<user_query>\s*(.*?)\s*</user_query>", re.S)
_RE_TAG = re.compile(r"<[^<>]{0,120}>")
_SKIP_BLOCKS = (
    "<system-reminder", "<task-notification", "<cb_summary", "<command-name",
    "<command-message", "<local-command", "<ide_opened_file", "<tool_result",
    "<wecom_forwarded", "<additional_data", "<user_info", "<identity_context",
)


def _clean(s: str) -> str:
    return " ".join(_RE_TAG.sub(" ", s).split())


def session_title(rec: dict):
    """取会话标题：用户真正输入的前 42 字。"""
    if rec.get("role") != "user":
        return None
    c = rec.get("content")
    if isinstance(c, str):
        texts = [c]
    elif isinstance(c, list):
        texts = [(seg.get("text") or "") for seg in c
                 if isinstance(seg, dict) and seg.get("type") in ("input_text", "text")]
    else:
        return None

    for t in texts:
        t = (t or "").strip()
        if not t:
            continue
        # 1) 优先取 <user_query> 包裹的真实提问
        m = _RE_USER_QUERY.search(t)
        if m:
            q = _clean(m.group(1))
            if len(q) >= 2:
                return q[:42]
            continue
        # 2) 系统注入块直接跳过
        low = t.lower()
        if any(low.startswith(p) for p in _SKIP_BLOCKS):
            continue
        if t.startswith("<"):
            continue
        # 3) 普通纯文本
        q = _clean(t)
        if len(q) >= 2:
            return q[:42]
    return None


def short_ws(name: str) -> str:
    """c-Users-17876-WorkBuddy-Claw → Claw"""
    key = "-WorkBuddy-"
    i = name.rfind(key)
    if i >= 0 and name[i + len(key):]:
        return name[i + len(key):]
    return name


# ---------------------------------------------------------------- 扫描 + 增量缓存

# 单个文件的解析结果缓存：路径 -> (mtime, size, [(minute, model, tt, it, ot, ch, cw, cr)], sessionId, title, cwd)
_FILE_CACHE: dict = {}
_CACHE_LOCK = threading.Lock()

STATS = {"files": 0, "parsed": 0, "reused": 0, "bytes": 0, "records": 0, "lastMs": 0}


def parse_file(path: str):
    st = os.stat(path)
    with _CACHE_LOCK:
        cached = _FILE_CACHE.get(path)
    if cached and cached[0] == st.st_mtime and cached[1] == st.st_size:
        STATS["reused"] += 1
        return cached[2], cached[3], cached[4], cached[5]
    STATS["parsed"] += 1
    STATS["bytes"] += st.st_size

    recs = []          # [minute, model, tt, it, ot, ch, cw, cr]
    sid = None
    title = None
    cwd = None
    want_title = True
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                # 用量记录与用户消息是两类行，都要看
                is_usage = '"total_tokens"' in line or '"totalTokens"' in line
                if not is_usage and not (want_title and '"role":"user"' in line):
                    continue
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if not isinstance(o, dict):
                    continue
                if sid is None and o.get("sessionId"):
                    sid = o["sessionId"]
                if cwd is None and o.get("cwd"):
                    cwd = o["cwd"]
                if want_title and o.get("role") == "user":
                    t = session_title(o)
                    if t:
                        title = t
                        want_title = False
                if not is_usage:
                    continue
                r = grab(o)
                if not r:
                    continue
                ts = parse_ts(o.get("timestamp"))
                if ts is None:
                    continue
                recs.append([int(ts // 60), r["model"], r["tt"], r["it"], r["ot"], r["ch"], r["cw"], r["cr"]])
    except OSError:
        return [], sid, title, cwd

    recs.sort(key=lambda x: x[0])
    if not title and cwd:                     # 兜底：用工作目录名当标题
        title = os.path.basename(cwd.rstrip("\\/")) or None
    with _CACHE_LOCK:
        _FILE_CACHE[path] = (st.st_mtime, st.st_size, recs, sid, title, cwd)
    return recs, sid, title, cwd


def scan(root: str) -> dict:
    t0 = time.time()
    STATS.update(files=0, parsed=0, reused=0, bytes=0, records=0)

    # 收集 .jsonl
    paths = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules")]
        for fn in filenames:
            if fn.endswith(".jsonl"):
                paths.append(os.path.join(dirpath, fn))
    paths.sort()

    ws_of = {}         # 目录名 -> 索引
    ws_names = []
    model_of = {}
    models = []
    sessions = {}      # sid -> dict

    for p in paths:
        STATS["files"] += 1
        rel = os.path.relpath(p, root)
        segs = rel.split(os.sep)
        folder = segs[0]
        if folder not in ws_of:
            ws_of[folder] = len(ws_names)
            ws_names.append(short_ws(folder))
        widx = ws_of[folder]
        stem = os.path.splitext(segs[-1])[0]
        if len(segs) >= 3:
            stem = segs[1]      # 非标准深度：用中间目录名当会话 id（与原站一致）

        recs, sid, title, cwd = parse_file(p)
        if not recs:
            continue
        STATS["records"] += len(recs)
        sid = str(sid) if sid else stem

        out = []
        for x in recs:
            m = x[1]
            if m not in model_of:
                model_of[m] = len(models)
                models.append(m)
            out.append([x[0], model_of[m], x[2], x[3], x[4], x[5], x[6], x[7]])

        cwd_name = os.path.basename(cwd.rstrip("\\/")) if cwd else None
        s = sessions.get(sid)
        if s is None:
            sessions[sid] = {"w": widx, "id": sid[:8], "t": title or cwd_name or None, "r": out}
        else:
            if s.get("t") is None:
                s["t"] = title or cwd_name or None
            s["r"].extend(out)

    sess_list = [s for s in sessions.values() if s["r"]]
    for s in sess_list:
        s["r"].sort(key=lambda x: x[0])
        s["st"] = s["r"][0][0]
    sess_list.sort(key=lambda s: s["st"])

    now = time.time()
    STATS["lastMs"] = int((time.time() - t0) * 1000)

    return {
        "ok": True,
        "genMs": int(now * 1000),
        "gen": time.strftime("%Y-%m-%d %H:%M", time.localtime(now)),
        "root": root,
        "ws": ws_names,
        "models": models,
        "sess": sess_list,
        "stats": {
            "files": STATS["files"],
            "parsed": STATS["parsed"],
            "reused": STATS["reused"],
            "records": STATS["records"],
            "scanMs": STATS["lastMs"],
        },
    }


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "TokenDashboard/1.0"
    root_dir = "."

    def log_message(self, fmt, *args):
        if os.environ.get("TOKEN_DASH_VERBOSE"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, body: bytes, ctype="application/json; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/scan":
            try:
                if os.path.isdir(self.server.log_root) and not self._force_demo(parsed):
                    data = scan(self.server.log_root)
                else:
                    data = load_demo()
                self._json(data)
            except Exception as e:                       # 扫描失败也要给出可读原因
                self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, 500)
            return
        if path == "/api/ping":
            exists = os.path.isdir(self.server.log_root)
            self._json({"ok": True, "root": self.server.log_root,
                        "exists": exists, "demo": (not exists) or self._force_demo(parsed)})
            return
        self._static(path)

    @staticmethod
    def _force_demo(parsed):
        return "demo=1" in (parsed.query or "")

    def do_HEAD(self):
        self.do_GET()

    def _static(self, path):
        if path in ("/", "", "/index.html"):
            path = "/index.html"
        rel = path.lstrip("/").replace("/", os.sep)
        fp = os.path.normpath(os.path.join(self.root_dir, rel))
        if not fp.startswith(os.path.normpath(self.root_dir)):
            self._send(403, b"forbidden", "text/plain; charset=utf-8")
            return
        if not os.path.isfile(fp):
            self._send(404, "404 Not Found".encode("utf-8"), "text/plain; charset=utf-8")
            return
        ext = os.path.splitext(fp)[1].lower()
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon",
        }.get(ext, "application/octet-stream")
        with open(fp, "rb") as fh:
            self._send(200, fh.read(), ctype)


def free_port(prefer=8791) -> int:
    for port in [prefer] + list(range(prefer + 1, prefer + 40)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return prefer


def main():
    ap = argparse.ArgumentParser(description="WorkBuddy Token 看板 本地服务")
    ap.add_argument("--port", type=int, default=0, help="端口（默认自动挑选 8791 起；云端读 PORT 环境变量）")
    ap.add_argument("--host", default=None, help="监听地址（默认 127.0.0.1；存在 PORT 环境变量时 0.0.0.0）")
    ap.add_argument("--root", default=None, help="WorkBuddy 日志根目录（默认 %%USERPROFILE%%\\.workbuddy\\projects）")
    ap.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    args = ap.parse_args()

    root = os.path.abspath(os.path.expandvars(os.path.expanduser(args.root))) if args.root else default_root()
    Handler.root_dir = HERE

    # 云端：平台注入 PORT，必须绑 0.0.0.0；本地：只绑回环地址，不暴露到局域网
    env_port = (os.environ.get("PORT") or "").strip()
    port = args.port or (int(env_port) if env_port.isdigit() else 0) or free_port()
    host = args.host or ("0.0.0.0" if env_port else "127.0.0.1")

    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    httpd.log_root = root

    url = "http://%s:%d/" % ("127.0.0.1" if host == "0.0.0.0" else host, port)
    print()
    print("  WorkBuddy Token 看板 已启动")
    print("  --------------------------------------------------------")
    print("  地址    : %s" % url)
    print("  监听    : %s:%d" % (host, port))
    print("  日志目录: %s" % root)
    print("  数据源  : %s" % ("本机日志" if os.path.isdir(root) else "内置示例数据（脱敏，%s）" % os.path.basename(DEMO_FILE)))
    print()
    print("  按 Ctrl+C 停止服务")
    print()

    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
