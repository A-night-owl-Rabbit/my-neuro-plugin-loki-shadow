# 洛基之影（Shadow of Loki） v3.0.0

**my-neuro** 生态下的 **live-2d 社区插件**，面向"游戏陪玩 / 游戏攻略辅助"场景：通过窗口检测识别游戏，跨会话记忆任务/Boss/章节/区域等状态，并把所有攻略/剧情类问题一站式委托给 Kimi 联网 AI 搜索（[`kimi-search`](https://github.com/A-night-owl-Rabbit) 同生态插件）作答。

**仓库地址：** [https://github.com/A-night-owl-Rabbit/my-neuro-plugin-loki-shadow](https://github.com/A-night-owl-Rabbit/my-neuro-plugin-loki-shadow)

---

## v3.0.0 重大更新（检索引擎换骨）

> **TL;DR**：洛基之影从「自带多源爬虫 + 双 LLM 整合 + 本地攻略库 + 向量检索」的重型架构，瘦身为「窗口检测 + 状态追踪 + 跨会话记忆 + Kimi 一站式联网搜索」的轻量架构。**插件本身不再承担检索整合，专注于"游戏会话上下文"+"工具调用门面"，把答案生成完全交给 Kimi。**

### 移除（这些功能不再需要在本插件配置）

- ❌ **本地攻略库 / `game-guides` 目录**：v3.0 起不再扫描或读取本地 txt 攻略库；`guide_library_path` 配置项也已删除。仓库内保留的 `game-guides/` 目录仅作为社区历史档案保留，便于回退到 v2.x 的用户继续使用，**v3.0+ 运行时不会读取该目录**。
- ❌ **向量召回 / Embedding 模型**：删除 `vector-store.js`、`.vector-cache`、`vector_*` 配置项与对硅基流动 Embedding 接口的依赖。
- ❌ **多源并行爬虫**：删除 `gamersky-crawler.js`、`bilibili-fetcher.js`、`taptap-crawler.js`、`nga-crawler.js`、`miyoushe-crawler.js` 与 `orchestrator.js`。
- ❌ **Sub-Agent 双 LLM 体系**：删除 `sub-agent.js`、`retry-utils.js`、主 Agent（DeepSeek 系）/ 后备 Agent（Qwen 系）切换逻辑、相关 `sub_agent` / `fallback_agent` 配置块。
- ❌ **`axios`、`cheerio` 等运行时依赖**：v3.0 `package.json` 已是空依赖（`"dependencies": {}`），无需再 `npm install`。

### 保留 / 强化

- ✅ **游戏窗口检测**（`window-detector.js`）：Windows 下基于 PowerShell 检测前台/全部带窗口标题的进程，匹配 `GAME_KEYWORDS` 中已知游戏作品。
- ✅ **状态追踪工具 `loki_shadow_track`**：游戏名、主线任务、当前步骤、Boss、区域、章节、剧透偏好（`spoiler_comfort`）、玩家备注（`companion_note`）。
- ✅ **跨会话记忆**：在 `persist_dir`（默认插件目录下 `.runtime/`）写入 `.loki-shadow-persist.json`，按游戏名恢复任务槽位与剧透偏好。
- ✅ **`game_name` 守卫**：拒绝把哔哩哔哩 / 浏览器 / 播放器等应用名当作游戏名传入，避免污染主线任务槽位。
- ✅ **陪玩 / 防剧透协议注入**：`onLLMRequest` 阶段把陪玩协议、`query` 调用门槛、防剧透处理、节奏控制、内部决策禁止外显等硬约束注入主对话模型的 system 消息。
- ✅ **结构化步骤日志**（`logger.js`）：每次 `query` 自带会话 ID 与执行摘要。

### 新机制：`loki_shadow_query` → `kimi_web_search` 委托

```
主对话模型
   │
   │  loki_shadow_query({ game_name, query })
   ▼
[loki-shadow]
   │  Step1: 游戏窗口检测（如未指定 game_name）
   │  Step2: 拼接极简 query：「游戏名 + 原始问题」
   │  Step3: 调用 pluginManager.executeTool('kimi_web_search', {...})
   ▼
[kimi-search] ───► Kimi 联网 AI 搜索
   │
   ▼
答案（含来源整合）→ 主对话模型按 spoiler_comfort 过滤后转述给用户
```

**优点**：

- 速度快、来源整合好，不必在插件层维护多站爬虫规则。
- Kimi 失败时返回 `status: no_reliable_info` + 行动建议，主对话模型自然降级为"基于截图与对话陪聊"。
- 主对话模型若直接持有 `kimi_web_search` 工具，可在 query 失败时自行重试，互为冗余。

**前置条件**：

- 必须同时启用同生态的 `kimi-search` 插件并配置好 Kimi API Key，否则 `loki_shadow_query` 会直接返回 `kimi_unavailable` 失败提示。

---

## 功能概览（v3.0）

| 能力              | 说明                                                                                |
| --------------- | --------------------------------------------------------------------------------- |
| **游戏窗口检测**      | Windows / PowerShell 实现，60s 缓存；支持鸣潮、绝区零、原神、星穹铁道、黑神话：悟空、艾尔登法环、只狼等数十款游戏关键词         |
| **游戏状态追踪**      | `loki_shadow_track` 记录任务/Boss/章节/区域 + 陪玩偏好；层级联动清除（章节变 → 主线/步骤/Boss 清空）             |
| **跨会话记忆**       | `persist_dir` 下 `.loki-shadow-persist.json`，按游戏名恢复槽位                              |
| **AI 联网检索**     | `loki_shadow_query` 一站式委托 `kimi_web_search`，支持 `silent` 与 `deep_research` 默认值      |
| **`game_name` 守卫** | denylist 拒绝哔哩哔哩 / Chrome / VS Code / 微信等非游戏作品名                                    |
| **陪玩协议**        | system 注入：启用条件、截图信息提取、track/query 独立、query 调用门槛、防剧透与节奏控制、内部决策禁止外显                  |
| **失败降级**        | Kimi 不可用时返回结构化"安全陪聊方向"提示，避免硬编剧情                                                   |

---

## 环境要求

- **Node.js**（与 my-neuro live-2d 一致）
- **依赖**：v3.0.0 起 **无运行时 npm 依赖**，无需再 `npm install`。
- **Windows**：窗口检测依赖 PowerShell。
- **必备同生态插件**：`kimi-search`（提供 `kimi_web_search` 工具）。

---

## 安装方式

将整个插件目录放到 my-neuro 的社区插件路径下：

```text
live-2d/plugins/community/loki-shadow/
```

目录内应包含 `index.js`、`metadata.json`、`plugin_config.json` 及其他模块文件。无需额外执行 `npm install`。

确认 `kimi-search` 插件已启用且配置了有效的 Kimi API Key，然后在 my-neuro 中启用本插件并重启或热重载即可。

---

## 配置说明（`plugin_config.json`）

v3.0 配置非常简洁，仅 5 项可配，全部为非敏感本地行为开关：

| 配置项                              | 类型    | 默认            | 说明                                                                                                                                                       |
| -------------------------------- | ----- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                        | bool  | `true`        | 是否启用插件                                                                                                                                                   |
| `session_context_ttl_ms`         | int   | `60000`       | 内存游戏状态有效期（毫秒）。超过该时间未调用 track 则清空内存槽位；持久化文件仍保留。可增大以降低"换场景丢状态"感                                                                                          |
| `enable_cross_session_memory`    | bool  | `true`        | 是否启用跨会话记忆                                                                                                                                                |
| `persist_dir`                    | string | `""`          | 跨会话记忆 `.loki-shadow-persist.json` 存放目录。留空使用插件目录下的 `.runtime/`。Windows 路径需转义反斜杠。**该文件包含玩家进度，不要提交到公共仓库**                                                  |
| `kimi_silent`                    | bool  | `true`        | 调用 `kimi_web_search` 时是否传 `silent=true`（屏蔽 Kimi 搜索/思考过程，只返回最终答案）                                                                                          |
| `kimi_deep_research`             | bool  | `false`       | 是否默认启用 Kimi 探索版（更慢但更全面）。普通查询保持 `false`；主对话模型在需要深度调研时可绕过此默认直接调用 `kimi_web_search`                                                                          |

> 注意：v2.x 时代的 `sub_agent`、`fallback_agent`、`guide_library_path`、`vector_*`、`gamersky_download_limit`、`bilibili_search_limit`、`max_content_length` 等配置项 **在 v3.0 已全部移除**，UI 上若仍残留旧字段，可在升级后清理对应 JSON。

### 编辑 JSON 时的编码

若使用记事本等保存为 UTF-8 带 BOM，可能导致主程序解析 `plugin_config.json` 报错。建议使用 VS Code 等编辑器保存为 UTF-8（无 BOM），或使用已包含 BOM 自动剥离逻辑的较新版 my-neuro 主程序。

### 隐私 / 敏感数据

- v3.0 `plugin_config.json` 中 **不再包含任何 `api_key` 字段**，无需脱敏。
- `.runtime/.loki-shadow-persist.json` 包含玩家正在玩的游戏、任务进度、聊天偏好等个人状态，**已通过 `.gitignore` 排除**，请勿手动添加。
- 若你希望把跨会话记忆放到其他路径，请确保该路径不会被提交到公开仓库。

---

## 仓库结构（v3.0）

| 文件 / 目录                | 说明                                       |
| --------------------- | ---------------------------------------- |
| `index.js`            | 插件入口、工具注册（`loki_shadow_track` / `loki_shadow_query`）、陪玩协议注入、`kimi_web_search` 委托 |
| `session-context.js`  | 游戏会话状态（槽位制 + 来源门控 + 层级联动 + 历史回溯）         |
| `persist-store.js`    | 跨会话记忆持久化（`.loki-shadow-persist.json`）    |
| `game-name-guard.js`  | 拒绝把哔哩哔哩 / 浏览器 / 播放器等应用名当作游戏名             |
| `window-detector.js`  | Windows PowerShell 游戏窗口检测                |
| `logger.js`           | 结构化步骤日志                                  |
| `metadata.json`       | 插件元数据（v3.0.0）                            |
| `package.json`        | 空依赖（v3.0 不需要 axios / cheerio 等）          |
| `plugin_config.json`  | 配置模板（仅本地行为开关，无任何 API Key 字段）             |
| `game-guides/`        | **v2.x 社区共建 txt 攻略库（v3.0 不再读取，作为档案保留）** |
| `.github/`            | PR 模板等                                   |
| `.gitignore`          | 排除 `.runtime/`、`node_modules/`、`*.log`、`.vector-cache` 等本地工件 |

---

## 工具说明

### `loki_shadow_track`

上报当前观察到的游戏状态。**不触发搜索**，仅更新内存槽位与跨会话记忆。

参数：

| 参数                | 类型     | 必填 | 说明                                                                                |
| ----------------- | ------ | -- | --------------------------------------------------------------------------------- |
| `game_name`       | string | ✅  | 游戏作品正式名（如 鸣潮 / 原神）。禁止哔哩哔哩、Chrome 等应用名                                              |
| `source`          | string | ✅  | `screenshot` / `conversation` / `user_confirmed`。`main_quest` 仅接受前者与后者              |
| `main_quest`      | string |    | 主线任务名。仅在 `source=screenshot` 或 `user_confirmed` 时记录                                |
| `current_step`    | string |    | 当前子步骤（如"与椿对话"）。可频繁更新                                                              |
| `current_boss`    | string |    | 当前 Boss 名                                                                         |
| `current_area`    | string |    | 当前区域 / 地图 / 场景                                                                    |
| `current_chapter` | string |    | 当前章节                                                                              |
| `spoiler_comfort` | string |    | `strict` / `mild` / `full`，默认 `strict`                                            |
| `companion_note`  | string |    | 玩家陪玩偏好短备注，如"想自己探索"                                                                |

### `loki_shadow_query`

发起正式攻略 / 剧情类查询。内部委托给 `kimi_web_search`，并强制要求主对话模型对返回答案做防剧透处理。

参数：

| 参数          | 类型     | 必填 | 说明                                                                          |
| ----------- | ------ | -- | --------------------------------------------------------------------------- |
| `game_name` | string |    | 游戏作品正式名。可省略，由窗口检测自动识别                                                       |
| `query`     | string | ✅  | 必须是具体问题，如"这个 Boss 二阶段怎么处理？"。**禁止空泛词如"搜一下剧情"，也不要直接塞 NPC 原话碎片**             |

返回示例：

```text
【鸣潮 · 洛基之影 · Kimi联网】
原问题：远航星 第二章 怎么继续推进

…（Kimi 整合后的答案正文）…

---
【提示】以上由 Kimi 联网 AI 搜索整合，请按 spoiler_comfort 与玩家进度做防剧透处理后再转述给用户。
```

Kimi 不可用时则返回：

```text
【洛基之影 · 未检索到可靠资料】
status: no_reliable_info
game_name: …
query: …
reason: kimi_unavailable | …

当前游戏上下文：
…

给主对话模型的行动建议：
1. 不要硬讲剧情答案，先基于当前截图和用户刚才的话继续陪聊
2. 可以评论画面里的角色表情、场景氛围、战斗压力、演出张力
…
```

---

## 版本记录

### v3.0.0（2026-05 检索引擎换骨）

- **架构换骨**：移除本地攻略库 / 向量召回 / 多源爬虫 / Sub-Agent 双 LLM 整合。
- **新检索路径**：`loki_shadow_query` 一站式委托给 `kimi-search` 提供的 `kimi_web_search`，发给 Kimi 的 query 极简化为"游戏名 + 原始问题"，由 Kimi 全力召回。
- **运行时零依赖**：`package.json` 清空依赖，无需 `npm install axios cheerio`。
- **配置大幅简化**：`plugin_config.json` 从 ~170 行的 v2.4.2 模板缩减到 ~45 行；删除所有 `api_key` 字段，不再含敏感字段。
- **保留**：游戏窗口检测、`track` 状态追踪 + 跨会话记忆 + 来源门控 + 层级联动、`game_name` 守卫、陪玩 / 防剧透 / 节奏控制 / 内部决策禁止外显协议、结构化步骤日志。
- **Kimi 失败降级**：返回 `status: no_reliable_info` + 行动建议，主对话模型可自行调用 `kimi_web_search` 重试或转为陪聊。
- **`game-guides/` 目录**：保留为 v2.x 社区档案，v3.0 不再读取；后续仓库不强制更新此目录。

### v2.4.2（2026-04-23）

- 移除 characters 角色栏追踪。
- 2.4.1 起：移除剧情被动注入，强化主对话硬约束（禁止外显内部决策/提纲/陪玩小抄等）。
- 2.3.x 起：跨会话文件 `.loki-shadow-persist.json`、剧透/任务偏好、`game_name` 校验与向量辅助检索等。

### v2.0.x

- 2.0.1：修复 UTF-8 BOM 问题；完善中文 README。
- 2.0.0：会话状态追踪与查询联动、多源并行与双 Agent 容灾。

---

## 升级提示（v2.x → v3.0）

1. **删除旧依赖**：可在插件目录下删除 `node_modules/`，v3.0 不再需要。
2. **清理旧配置**：`plugin_config.json` 中的 `sub_agent`、`fallback_agent`、`guide_library_path`、`vector_*`、`gamersky_download_limit`、`bilibili_search_limit`、`max_content_length`、`per_source_context_chars`、`vector_top_k` 等字段在 v3.0 已无效，可保留也可删除（保留不会报错）。
3. **新增 `kimi-search` 依赖**：必须同时启用 `kimi-search` 插件并配置 Kimi API Key，否则 `loki_shadow_query` 会一直返回 `kimi_unavailable`。
4. **跨会话记忆**：v3.0 默认存放路径从"攻略库根目录"改为插件目录下 `.runtime/`。如需迁移旧数据，可手动复制旧 `.loki-shadow-persist.json` 到新路径，或在 `plugin_config.json` 中通过 `persist_dir` 指定旧路径。
5. **移除的工具**：v3.0 不再注册 `loki_shadow_record_plot` 等剧情注入相关工具。如果你的主对话模型 prompt 里还提到这些已不存在的工具，请清理一下。

---

## 想邀请你，做这只小牛的"云饲养员"

做这个桌宠的初衷，其实是因为自己一个人工作学习的时候，总觉得屏幕里空落落的。看到大家都在使用，我就觉得熬夜写代码、调教 AI 的日子都亮闪闪的。

不过，肥牛现在还在长身体（其实是我想给它做更多有趣的插件），养一只数字小牛其实也挺"费草"的哈哈。

如果你在这只小肥牛这里获得过哪怕一秒钟的治愈，或者觉得它算个合格的桌面搭子，要不要考虑成为它的"云饲养员"呀？

你的每一次充电，都不是在打赏我，而是在给这只肥牛注入一点点魔法值。让它能变得更聪明、更通人性、能听懂你更多的碎碎念。

不用有压力哦！你愿意打开它，就是对我最大的鼓励啦。如果刚好有余力，就请肥牛喝瓶快乐水叭，它会记住你的味道的！

爱发电 [https://ifdian.net/a/0923A](https://ifdian.net/a/0923A)

---

## 许可证

本项目采用 **CC BY-NC-SA 4.0** 许可证。
