# 洛基之影 (Shadow of Loki)

[my-neuro](https://github.com/morettt/my-neuro) live-2d 游戏陪玩智能插件 v2.0。自动检测当前游戏、搜索本地攻略库，从 **5 个来源并行下载** 攻略，通过 DeepSeek 主 Agent + Qwen 后备 Agent 编排全流程，返回精准游戏攻略与剧情答案。

**主对话模型集成**：通过 `onLLMRequest` 钩子自动注入游戏陪玩行为协议，主模型可根据截图画面分析游戏状态，智能提问并防剧透式引导用户。

## 特性

- 🎮 **自动游戏检测** - 通过 PowerShell 窗口进程识别当前游戏
- 📚 **本地攻略库缓存** - 基于语义标签快速检索，避免重复下载
- 🌐 **5 源并行下载** - 游民星空 / B站 / TapTap / NGA / 米游社
- 🤖 **双 Agent 容灾** - DeepSeek 主力 + Qwen 后备，自动切换
- 🔄 **指数退避重试** - 所有网络请求与 LLM 调用支持自动重试
- 🛡️ **防剧透协议** - 注入主模型的行为指令，像朋友一样引导而不是念攻略
- 📸 **截图联动** - 主模型分析游戏截图后自动调用洛基之影获取信息

## 快速开始

1. 将本仓库克隆到 `live-2d/plugins/community/loki-shadow/` 目录
2. 在插件配置页面设置 **API Key** 和 **游戏攻略库路径**
3. 确保已安装依赖：`cheerio`、`axios`（在 live-2d 目录执行 `npm install cheerio axios`）
4. 启用插件即可

## 配置说明

| 配置项 | 说明 |
|--------|------|
| 游戏攻略库路径 | 本地攻略文件保存目录的绝对路径 |
| 主智能体 (DeepSeek) | API Key / 地址 / 模型 / 温度 / Token 上限 |
| 后备智能体 (Qwen) | API Key / 地址 / 模型 / 温度 / Token 上限（主 Agent 失败时自动切换） |
| 游民星空下载数量 | 每次下载的攻略数量上限 |
| B站搜索数量 | B站视频搜索返回的结果数量 |
| TapTap搜索数量 | TapTap 攻略搜索返回的数量上限 |
| NGA搜索数量 | NGA 论坛攻略搜索返回的数量上限 |
| 米游社搜索数量 | 米游社攻略搜索返回的数量上限（仅米哈游系游戏有效） |
| 内容最大长度 | 单个文档最大字符数，防止 token 超限 |

## 工作流程

对外只暴露一个工具 `loki_shadow_query`，内部由下级智能体编排 7 个步骤：

1. **游戏检测** — 通过 PowerShell 检测窗口进程识别当前游戏
2. **攻略库检索** — 在攻略库中按标签和文件名进行匹配搜索
3. **内容分析** — Agent 判断现有攻略是否能回答问题
4. **信息下载** — 不足时从 5 个来源异步并行获取新攻略
5. **内容整合** — Agent 综合多源信息，生成带语义标签的攻略文件保存到库中
6. **生成答案** — Agent 生成精准详细的最终答案
7. **返回结果** — 将答案返回给主对话模型

### 主模型行为协议

插件通过 `onLLMRequest` 自动向主对话模型注入游戏陪玩行为协议：
- **截图分析**：识别游戏画面 → 分析场景 → 转化为问题 → 调用工具
- **防剧透引导**：不直接复述攻略，分步给提示，像通关好友一样聊天
- **多种互动**：攻略引导 / 剧情讨论 / 角色聊天 / 主动评论画面

## 文件结构

| 文件 | 说明 |
|------|------|
| `index.js` | 插件入口，工具注册，系统提示词注入 |
| `orchestrator.js` | 核心工作流引擎，7 步编排 |
| `sub-agent.js` | 双 LLM 封装（DeepSeek + Qwen 容灾） |
| `retry-utils.js` | 通用重试工具（指数退避） |
| `window-detector.js` | PowerShell 窗口进程检测 |
| `guide-library.js` | 本地攻略库管理 |
| `gamersky-crawler.js` | 游民星空爬虫 |
| `bilibili-fetcher.js` | B站视频搜索与总结 |
| `taptap-crawler.js` | TapTap 攻略爬虫 |
| `nga-crawler.js` | NGA 论坛爬虫 |
| `miyoushe-crawler.js` | 米游社攻略爬虫 |
| `logger.js` | 结构化日志系统 |
| `metadata.json` | 插件元数据 |
| `plugin_config.json` | 配置项定义 |

## 依赖

- [my-neuro](https://github.com/morettt/my-neuro) live-2d 插件系统
- [Bilibili MCP 工具集](https://github.com/A-night-owl-Rabbit/my-neuro-bilibili-mcp) server-tool（B站数据源依赖）
- Node.js 模块：`cheerio`、`axios`

## 作者

爱熬夜的人形兔
