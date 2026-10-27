#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
标准入口：部分托管平台默认执行 `python main.py`，这里转交给 server.main()。

本地使用仍然双击 `启动看板.bat` 或 `python server.py`；
本文件只是让云端沙箱能识别启动入口，逻辑全部在 server.py。
"""

from server import main

if __name__ == "__main__":
    main()
