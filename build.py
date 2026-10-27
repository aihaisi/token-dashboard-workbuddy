#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 src/ 下的三段源码内联成单文件 index.html。

单文件的好处：可以直接双击用浏览器打开（或用服务端托管），
把整站拷给别人也只有一个文件，不依赖任何外部资源。

用法：python build.py
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
OUT = os.path.join(HERE, "index.html")

TITLE = "WorkBuddy Token 消耗看板"
DESC = ("纯本机扫描 WorkBuddy 会话日志，统计各模型 Token 用量、缓存命中与计费。"
        "数据不上传任何服务器，页面不请求任何外部地址。")

HEAD = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · AI 大模型用量统计</title>
<meta name="description" content="{desc}">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%235f8cb6'/%3E%3Crect x='7' y='17' width='4' height='8' rx='1.5' fill='%23fff'/%3E%3Crect x='14' y='12' width='4' height='13' rx='1.5' fill='%23fff' opacity='.8'/%3E%3Crect x='21' y='7' width='4' height='18' rx='1.5' fill='%23fff' opacity='.6'/%3E%3C/svg%3E">
<style>
{styles}
</style>
</head>
<body>
{body}
<script>
{app}
</script>
</body>
</html>
"""


def read(name):
    with open(os.path.join(SRC, name), "r", encoding="utf-8") as fh:
        return fh.read()


def main():
    styles = read("styles.css")
    body = read("body.html")
    app = read("app.js")

    # 安全护栏：内联脚本里绝不能出现 </script>，否则 HTML 会被提前截断
    if re.search(r"</script", app, re.I) or re.search(r"</script", styles, re.I):
        raise SystemExit("ERROR: 内联内容里出现了 </script>，会导致 HTML 被截断，请先处理。")

    html = HEAD.format(title=TITLE, desc=DESC, styles=styles.strip(), body=body.strip(), app=app.strip())
    with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(html)
    print("built -> %s  (%.1f KB)" % (OUT, len(html.encode("utf-8")) / 1024))


if __name__ == "__main__":
    main()
