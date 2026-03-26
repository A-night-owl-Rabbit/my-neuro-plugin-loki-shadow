# 洛基之影（Shadow of Loki）

[`my-neuro`](https://github.com/morettt/my-neuro) 的 [`live-2d`](https://github.com/morettt/my-neuro) 社区插件，面向“游戏陪玩 / 游戏攻略辅助”场景设计。

它会在对话过程中配合主模型识别游戏上下文，记录当前任务、区域、Boss、章节与角色状态，并在需要时从本地攻略库与多平台来源中检索、整合信息，给出更贴近当前进度的辅助回答。



## 功能概览

- **游戏状态追踪**：通过 [`loki_shadow_track`](./index.js) 记录任务、地图、Boss、章节、角色等上下文信息。
- **攻略/剧情查询**：通过 [`loki_shadow_query`](./index.js) 查询当前游戏相关攻略、剧情、配装、Boss 打法等内容。
- **五源并行检索**：支持游民星空、B 站、TapTap、NGA、米游社等来源并行获取信息。
- **本地攻略库缓存**：优先搜索本地攻略库，降低重复抓取和重复整理成本。
- **双模型容灾**：支持主 Agent 与后备 Agent 切换。
- **会话增强搜索**：结合近期游戏状态，自动优化低质量查询词。
- **防剧透式辅助**：适合做“陪玩型”辅助，而不是简单硬贴原文攻略。

## 适用场景

- 用户正在游玩单机 / 二游 / 剧情游戏时，结合截图或聊天内容进行辅助。
- 用户卡关，希望获得**不过度剧透**的分步引导。
- 用户想讨论当前章节、任务、Boss 或角色，但不希望被未来剧情直接剧透。
- 用户需要将零碎截图信息转成结构化搜索词进行攻略查询。

## 工作流程

插件核心流程由 [`orchestrator.js`](./orchestrator.js) 编排，大致如下：

1. 检测当前游戏（或使用显式传入的游戏名）
2. 扫描本地攻略库
3. 分析已有内容是否足够回答
4. 必要时从多来源并行抓取补充资料
5. 整合结果并生成可复用攻略内容
6. 结合当前会话状态生成最终回答

## 仓库结构

| 文件 | 说明 |
| --- | --- |
| [`index.js`](./index.js) | 插件入口、工具注册、主流程接入 |
| [`orchestrator.js`](./orchestrator.js) | 核心工作流编排 |
| [`session-context.js`](./session-context.js) | 游戏会话状态管理 |
| [`sub-agent.js`](./sub-agent.js) | LLM 调用与主/后备切换 |
| [`guide-library.js`](./guide-library.js) | 本地攻略库扫描、读取、保存、去重 |
| [`window-detector.js`](./window-detector.js) | Windows 游戏窗口检测 |
| [`gamersky-crawler.js`](./gamersky-crawler.js) | 游民星空内容抓取 |
| [`bilibili-fetcher.js`](./bilibili-fetcher.js) | B 站搜索与摘要 |
| [`taptap-crawler.js`](./taptap-crawler.js) | TapTap 内容抓取 |
| [`nga-crawler.js`](./nga-crawler.js) | NGA 内容抓取 |
| [`miyoushe-crawler.js`](./miyoushe-crawler.js) | 米游社内容抓取 |
| [`retry-utils.js`](./retry-utils.js) | 通用重试工具 |
| [`logger.js`](./logger.js) | 结构化日志输出 |
| [`metadata.json`](./metadata.json) | 插件元数据 |
| [`plugin_config.json`](./plugin_config.json) | 插件配置定义 |

## 安装方式

将本仓库放入：

```text
live-2d/plugins/community/loki-shadow/
```

然后在 `live-2d` 运行依赖安装：

```bash
npm install axios cheerio
```

如果你的运行环境已经包含这些依赖，可跳过。



### 主要配置项

- **游戏攻略库路径**：默认使用相对目录 [`./game-guides`](./plugin_config.json)
- **主智能体配置**：API 地址、模型、温度、最大 Token
- **后备智能体配置**：主模型失败时自动切换
- **各来源搜索数量限制**：用于控制抓取规模
- **内容最大长度**：避免发送给模型的文本过长

### 配置建议

- `guide_library_path`：建议改为你本地实际可写目录
- `sub_agent.api_key`：填写主模型 API Key
- `fallback_agent.api_key`：可选，填写后备模型 API Key
- `max_content_length`：根据你的模型上下文能力酌情调整

## 工具说明

### `loki_shadow_track`

用于记录当前观察到的游戏状态，例如：

- 游戏名
- 当前任务
- 当前 Boss
- 当前区域
- 当前章节
- 相关角色列表

这个工具不会直接搜索攻略，但会增强后续查询质量。

### `loki_shadow_query`

用于发起正式查询，例如：

- `原神 无相之雷 打法攻略`
- `鸣潮 第三章 主线任务流程`
- `绝区零 某角色 配队思路`

建议使用**结构化关键词**，效果会明显好于零碎截图原文。

## 更新说明（公开版）

本次公开仓库更新重点包括：

- 同步最新插件代码结构
- 增加 [`session-context.js`](./session-context.js) 会话状态追踪支持
- 完整接入状态追踪与查询联动逻辑
- 保留多来源并行检索与双 Agent 容灾能力




## 依赖与环境

- Node.js
- `axios`
- `cheerio`
- Windows 环境下的 PowerShell（用于窗口检测能力）

## 致谢

- [`my-neuro`](https://github.com/morettt/my-neuro)
- 各游戏社区公开内容来源

## 许可证

本项目采用 **CC BY-NC-SA 4.0** 许可证。






