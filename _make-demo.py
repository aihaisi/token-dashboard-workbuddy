#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从本地 /api/scan 快照生成脱敏演示数据 demo-scan.json

脱敏规则（对外发布用，投稿/分享场景）：
  - 工作空间名 → 按类型归并成「桌面项目 01」「开发项目 03」这类中性名
  - 会话标题   → 循环填充通用研发事务标题，绝不保留任何真实提问
  - root       → 清空
  - 保留：模型名、token/credit 数值、时间分布、会话与工作空间结构

用法：
  curl -s http://127.0.0.1:8791/api/scan -o _raw-scan.json
  python _make-demo.py
"""

import json
import re
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "_raw-scan.json")
DST = os.path.join(HERE, "demo-scan.json")

TITLES = [
    "梳理项目目录结构", "排查接口报错", "调整图表样式", "整理数据字段",
    "重构工具函数", "补写单元测试", "检查构建产物", "整理需求文档",
    "优化渲染性能", "复核统计口径", "配置本地环境", "整理发布清单",
    "对比两版方案", "排查样式错位", "补充边界处理", "清理调试日志",
    "统一命名规范", "拆分公共模块", "验证缓存策略", "记录改动说明",
]

WS_RULES = [
    ("desktop", "桌面项目"),
    ("d-develop", "开发项目"),
    ("d-software", "开发项目"),
    ("unityproject", "Unity 项目"),
    ("automation", "自动任务"),
    ("workbuddy", "工作区"),
]


def ws_name(orig, idx):
    low = orig.lower()
    for key, base in WS_RULES:
        if key in low:
            return "%s %02d" % (base, idx)
    if re.match(r"^20\d{6,}", orig) or re.match(r"^20\d{2}-\d{2}-\d{2}", orig):
        return "会话归档 %02d" % idx
    return "工作空间 %02d" % idx


def main():
    with open(SRC, "r", encoding="utf-8") as fh:
        d = json.load(fh)

    d["ws"] = [ws_name(n, i + 1) for i, n in enumerate(d["ws"])]
    d["root"] = ""
    d["demo"] = True
    for i, s in enumerate(d.get("sess", [])):
        s["t"] = TITLES[i % len(TITLES)]

    with open(DST, "w", encoding="utf-8") as fh:
        json.dump(d, fh, ensure_ascii=False, separators=(",", ":"))

    size = os.path.getsize(DST)
    print("demo-scan.json: %.1f KB · %d 模型 · %d 工作空间 · %d 会话 · %d 条记录"
          % (size / 1024.0, len(d["models"]), len(d["ws"]), len(d["sess"]), d["stats"]["records"]))
    print("工作空间示例:", d["ws"][:6])
    print("会话标题示例:", [s["t"] for s in d["sess"][:6]])


if __name__ == "__main__":
    main()
