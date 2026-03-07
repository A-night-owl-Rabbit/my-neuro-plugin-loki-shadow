# 洛基之影 (Shadow of Loki)

[my-neuro](https://github.com/A-night-owl-Rabbit/my-neuro) live-2d 游戏陪玩智能插件。自动检测当前游戏，搜索本地攻略库，从游民星空和B站下载攻略，通过 DeepSeek 下级智能体编排全流程，返回精准游戏攻略与剧情答案。

## 快速开始

1. 将本仓库克隆到 `live-2d/plugins/community/loki-shadow/` 目录
2. 在插件配置页面填入 **DeepSeek API Key** 和 **游戏攻略库路径**
3. 确保已安装依赖：`cheerio`、`axios`（在 live-2d 目录执行 `npm install cheerio axios`）
4. 启用插件即可

## 配置说明

| 配置项 | 说明 |
|--------|------|
| 游戏攻略库路径 | 本地攻略文件存放目录的绝对路径 |
| DeepSeek API Key | 硅基流动 API Key，用于下级智能体调用 |
| API 地址 | 硅基流动 API 基础地址，默认 `https://api.siliconflow.cn/v1` |
| 模型名称 | 下级智能体使用的模型，默认 `deepseek-ai/DeepSeek-V3.2` |
| 生成温度 | LLM 生成温度，建议 0.2-0.5 |
| 最大 Token 数 | 单次请求最大生成 Token 数，默认 20000 |
| 游民星空下载数量 | 每次从游民星空下载的攻略数量上限 |
| B站搜索数量 | B站视频搜索返回的结果数量 |
| 内容最大长度 | 发送给 DeepSeek 的单个文档最大字符数 |

## 工作流程

插件注册一个工具 `loki_shadow_query`，主对话模型只需调用该工具即可。内部由 DeepSeek 下级智能体编排 7 步工作流：

1. **游戏检测** — 通过 PowerShell 检测窗口进程识别当前游戏
2. **本地搜索** — 在攻略库中按标签检索已有攻略
3. **内容分析** — DeepSeek 判断现有攻略是否足以回答问题
4. **信息下载** — 不足时并行从游民星空（爬虫）和B站（视频总结）获取新攻略
5. **去重检查** — 基于来源 URL 避免重复下载
6. **内容整合** — DeepSeek 整合多来源信息，生成带标签的攻略文件保存到库
7. **答案生成** — 返回精准答案给主对话模型

## 文件结构

| 文件 | 说明 |
|------|------|
| `index.js` | 插件入口，注册工具，加载配置 |
| `orchestrator.js` | 核心工作流编排引擎 |
| `sub-agent.js` | DeepSeek LLM 封装 |
| `window-detector.js` | PowerShell 窗口进程检测 |
| `guide-library.js` | 本地攻略库管理 |
| `gamersky-crawler.js` | 游民星空爬虫 |
| `bilibili-fetcher.js` | B站视频搜索与总结 |
| `logger.js` | 结构化日志系统 |
| `metadata.json` | 插件元数据 |
| `plugin_config.json` | 插件配置定义 |

## 依赖

- [my-neuro](https://github.com/A-night-owl-Rabbit/my-neuro) live-2d 插件系统
- [Bilibili MCP 工具集](https://github.com/A-night-owl-Rabbit/my-neuro-bilibili-mcp) server-tool（B站功能需要）
- Node.js 包：`cheerio`、`axios`

## 作者

爱熬夜的人形兔