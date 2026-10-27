# WorkBuddy Token 消耗看板（本地版）

把你本机 `~/.workbuddy/projects/**/*.jsonl` 里的真实用量读出来，做成一个可交互的看板：
各模型 Token 用量、缓存命中、真实计费、时间分布、工作空间/会话下钻。

**数据全程只在本机流转**——服务端只监听 `127.0.0.1`，页面不请求任何外部地址（已用冒烟测试断言）。

> 项目位置：`D:\Software\token-dashboard`

---

## 快速开始

**方式一：双击启动（推荐）**

双击 `启动看板.bat`。脚本会自动找到本机 Python、启动服务、打开浏览器。
服务模式下一次扫描约 0.5 秒，之后靠增量缓存重扫是毫秒级。

**方式二：纯浏览器（不需要 Python）**

直接双击 `index.html`，用「选择日志目录」按钮选到 `%USERPROFILE%\.workbuddy\projects`。
所有解析在浏览器里完成，同样不上传任何数据。代价是首次要解析 100+ 个日志文件（约 140 MB），需要十几秒。

> 注意：Windows 下选目录时先按 `Alt → V → H` 显示隐藏文件夹，否则看不到 `.workbuddy`。

---

## 命令行

```bash
python server.py                          # 自动挑端口（8791 起），自动开浏览器
python server.py --port 9000              # 指定端口
python server.py --root "D:\\logs\\wb"    # 换一个日志根目录
python server.py --no-open                # 不自动开浏览器
```

环境变量 `WORKBUDDY_PROJECTS` 也可以指定日志根目录。

---

## 文件说明

| 文件 | 作用 |
|---|---|
| `index.html` | **成品**：单文件看板，CSS/JS 全部内联，零外部依赖 |
| `server.py` | 本机服务：静态托管 `index.html` + `GET /api/scan` 读取日志 |
| `启动看板.bat` | 一键启动（内容为纯 ASCII，任何代码页都不会乱码） |
| `start-dashboard.bat` | 同上，ASCII 文件名的副本（给不方便输入中文的场景） |
| `src/styles.css` `src/body.html` `src/app.js` | 源码分段（改这三份，然后重新构建） |
| `build.py` | 把 `src/` 三段内联成 `index.html` |
| `_smoke.js` | 无头冒烟测试（109 条断言） |
| `compare-orig.py` | 与线上原站的口径对拍（同一份日志跑两套算法） |
| `_orig-check.js` | node 侧交叉核验：原站原始 JS 逻辑逐字照抄，未经改写 |

改了 `src/` 下的文件之后要重新构建：

```bash
python build.py
```

---

## 首屏布局（按信息优先级）

页面分三个对齐的行区块（均为 50/50 两列网格，窄屏 <1100px 自动降为单列）：

| 区块 | 布局 |
|---|---|
| 上半区（hero-grid） | 模型总量排行 / 模型积分排行 / 模型性价比排行 —— 三列等高 |
| 中区（mid-grid） | 左：单次请求大小分布（跨两行）· 右：每日模型用量比例 + 0–24 时分布 |
| 下区（bot-grid） | 工作空间活跃分布 / 日活分布 两列 |

性价比 = `Token ÷ Credit`（每 1 积分换来的 Token，越大越划算），只统计 `credit > 0` 的模型
（credit 缺失不等于免费，混进来会出现大量假 ∞）。

- 上半区两卡行集合相同（Token>0 的模型），credit 为 0 的模型也显示 `0.00`，所以行数一致、高度天然对齐；同一模型两卡颜色相同。
- 中区靠 `#mdCard{grid-row:1 / span 2}` 让左卡跨两行，右两卡拼成一列，三卡边界严丝合缝（实测 551 = 282 + 251 + 18）。
- 下区两卡默认**展开**、等高（实测 377px）：日活热力图限高 215px，工作空间面板由 JS 联动算高度对齐。
- 三个区都可手动折叠（点标题），折叠时工具条/图例由 `renderPanel` 与 CSS 同步隐藏（JS 内联 `display` 优先级高于 CSS，必须两边一起处理）。
- ⚠️ 布局容器只改 `src/body.html` 时，别留下指向旧容器的 `document.querySelector('.xxx')`——`ResizeObserver.observe(null)` 会抛错并中断整个启动流程（页面会停在引导页）。冒烟测试有静态断言防这个回归。

---

## 线上演示（分享链接）

线上地址：<https://token-dashboard-workbuddy.app.workbuddy.host/?sharecode=OFWEUQ52C7>

`demo-scan.json` 是一份**脱敏**示例数据：工作空间名归并为「桌面项目 01」「开发项目 03」这类中性名，
会话标题全部替换为通用研发事务，`root` 清空。数值、模型名、时间分布保持真实结构。

`server.py` 在日志目录不存在时自动回退到它，并把时间轴整体平移到「当前」，
所以任何日期打开都有近 30 天数据、全窗口也能看到完整分布。
服务端同时适配云端：存在 `PORT` 环境变量时绑定 `0.0.0.0` 并读该端口；本机启动仍只绑 `127.0.0.1`。

重新生成示例数据（生成后务必删除 `_raw-scan.json`，它含真实内容）：

```bash
curl -s http://127.0.0.1:8791/api/scan -o _raw-scan.json
python _make-demo.py
```

---

## 接口

`GET /api/ping` → `{"ok":true,"root":"...","exists":true}`

`GET /api/scan` → 看板直接消费的数据结构：

```jsonc
{
  "ok": true,
  "genMs": 1789...,          // 本次扫描时刻（毫秒），前端时间窗口以此为基准
  "gen": "2026-09-19 19:20",
  "root": "C:\\Users\\...\\.workbuddy\\projects",
  "ws":    ["Claw", "d-WBProject", ...],          // 工作空间名（已剥离 -WorkBuddy- 前缀）
  "models":["auto", "deepseek-v4.1-flash", ...],  // 模型名（已归一）
  "sess": [
    { "w": 45,                // ws 下标
      "id": "4ca88ec7",
      "t": "我的邮箱里有什么有信息的邮件吗",
      "st": 29633125,         // 起始时间（分钟）
      "r": [ /* [分钟, 模型下标, 合计, 输入, 输出, 缓存命中, 缓存写入, credit], ... */ ] }
  ],
  "stats": { "files": 111, "records": 5190, "parsed": 111, "reused": 0, "scanMs": 503 }
}
```

---

## 从日志里读的字段

每条带用量的记录里都有 `providerData`，实际用到的字段：

| 来源 | 含义 |
|---|---|
| `providerData.rawUsage.total_tokens` | 合计 Token |
| `providerData.rawUsage.prompt_tokens` | 输入 |
| `providerData.rawUsage.completion_tokens` | 输出 |
| `providerData.rawUsage.prompt_cache_hit_tokens`（或 `prompt_tokens_details.cached_tokens`） | 缓存命中 |
| `providerData.rawUsage.cache_creation_input_tokens` | 缓存写入（Claude 系） |
| `providerData.rawUsage.credit` | **真实计费值** |
| `providerData.model` / `requestModelId` | 模型名 |
| `timestamp`（毫秒） | 请求时间 |
| `sessionId` / `cwd` | 会话归属与工作目录 |

### 相比原站做的几处修正

1. **用了 `credit` 字段。** 日志每条请求自带真实计费值（本机 5190 条里 5189 条都有，累计 6083），
   所以看板的「真实 Credit」是实测值；原站只有一个硬编码价目表，算出来的是估算。
   两者都保留：「参考估价」作为旁证，并明确标注仅供参考。
2. **会话标题能取到了。** 用户输入被包在 `<system-reminder>` 和 `<user_query>` 里，
   只看「是否以 `<` 开头」会让 100% 的会话退化成「(无标题会话)」。
   现在先解 `<user_query>`，再显式跳过各类系统注入块，兜底用 `cwd` 目录名。本机 88 个会话标题覆盖 88/88。
3. **模型名归一。** 同一模型在日志里有 `DeepSeek-V4-Flash` / `deepseek-v4-flash`、
   `tencent/hy3-preview-20260421:free` / `hy3-preview-20260421` 等写法，不归一会被拆成多个模型。
   归一后本机模型数从 16 降到 13，按模型的图表才有意义。
4. **不做任何外部请求。** 去掉了访问统计上报和推广链接，`fetch` 只打本地 API。
5. **服务端抽取代替浏览器全量解析。** 只传需要的字段（本机约 315 KB），并有 `(路径, mtime, size)` 增量缓存。

---

## 与线上原站的口径差异（2026-09-19 实测对拍）

跑 `python compare-orig.py` 可复现。本机实测（111 个日志文件 / 5,278 条记录）：

| 指标 | 线上原站 | 本看板 |
|---|---|---|
| 记录数 / 合计 Token / 输入 / 输出 / 缓存命中 | 516,134,537 tokens | **完全相同** |
| 缓存写入 | **0** | 7,239,226 |
| 模型数（全部窗口） | 16 | 13 |
| 金额 | 预估金额 **¥344.17** | 真实 Credit **6,095.87** |
| 会话标题 | 全部「(无标题会话)」 | 88/88 可读 |

四处差异的成因：

1. **缓存写入**——原站读 `prompt_tokens_details.cached_creation_tokens`，本机日志里该路径不存在
   （真实值在 `rawUsage.cache_creation_input_tokens`），所以原站这一项恒为 0，其估价也少算了这部分。
2. **模型数**——原站的合并表只有 `glm-5.2-x` 一条；本看板还归一大小写、`tencent/` 前缀、`:free` 后缀。
3. **金额**——见下，两种不同口径。
4. **会话标题**——原站只判断「是否以 `<` 开头」，而真实提问被包在 `<system-reminder>` 里。

### 金额为什么对不上

不是同一件事：

| | 来源 | 本机实测（全部窗口） |
|---|---|---|
| 原站「预估金额」 | 作者手写价目表（元/百万 token）× token 数 | ¥344.17 |
| 本看板「真实 Credit」 | 日志 `credit` 字段逐条累加 | 6,095.87 |
| 本看板「参考估价」 | 内置价目表折算 | 介于两者之间（价目表较原站更细） |

倍数在不同模型间从 0.02x 到 0.34x 不等，**不是固定汇率**，说明两者不是同一计价体系。
若要回答「到底扣了多少」，看 **Credit**；要按公开 API 价目表估算成本，才看估价。

---

## 关于「auto」这个模型名

本机 5190 条记录里有 2055 条（40%）模型名是 `auto`——因为会话用的是「自动选择模型」。
日志里没有记录它最终落到了哪个模型，所以这部分请求**无法归属到具体模型**，看板会单独显示为 `auto`。
这不是看板的 bug，是日志本身的信息缺失。

---

## 测试

```bash
python server.py --no-open      # 另开一个窗口
node _smoke.js                  # 109 条断言
```

`_smoke.js` 用 DOM 桩 + node `vm` 直接加载**交付的那份 `index.html` 里的脚本**，
再喂真实的 `/api/scan` 数据跑完整渲染管线。覆盖：

- 纯净性：无外部资源引用 / 无第三方统计 / 无 XHR·WebSocket / 无调试残留
- 纯函数：模型归一、用量抽取、时间戳解析、标题提取、色阶边界、XSS 转义
- 解析管线：`buildData` 的工作空间/模型/会话去重、坏行吞噬、空文件不污染统计
- 端到端：总量与独立重算对拍、窗口过滤单调性、四时段占比守恒、缓存量不超过输入量、
  全部图表容器产出内容、无 `NaN`/`undefined`、下钻与高亮路径、空窗口与空数据集兜底

---

## 已知边界

- 「auto」请求无法归属模型（见上）。
- 缓存写入（`cache_creation_input_tokens`）只有 Claude 系模型会填，其他模型恒为 0。
- 目录选择需要 Chrome/Edge；其他浏览器会退化成 `webkitdirectory` 文件框，可用但体验差一些。
- `showDirectoryPicker` 要求安全上下文（`https` 或 `127.0.0.1`）。用 `file://` 打开时走的是文件框回退。
