# 洛基之影（Shadow of Loki）

**my-neuro** 生态下的 **live-2d 社区插件**，面向「游戏陪玩 / 游戏攻略辅助」场景：结合对话与截图上下文，记录任务与进度，并在需要时从本地攻略库与多平台来源检索、整合信息，给出贴近当前进度的辅助回答。

**仓库地址：** [https://github.com/A-night-owl-Rabbit/my-neuro-plugin-loki-shadow](https://github.com/A-night-owl-Rabbit/my-neuro-plugin-loki-shadow)

---

## 功能概览

| 能力 | 说明 |
|------|------|
| **游戏状态追踪** | 工具 `loki_shadow_track` 记录任务、地图、Boss、章节、角色等上下文 |
| **攻略 / 剧情查询** | 工具 `loki_shadow_query` 发起结构化查询 |
| **五源并行检索** | 游民星空、B 站、TapTap、NGA、米游社等来源并行拉取 |
| **本地攻略库** | 优先读本地目录，减少重复抓取 |
| **双模型容灾** | 主 Agent（默认 DeepSeek 系）+ 后备 Agent（默认 Qwen 系） |
| **会话增强** | 结合近期游戏状态优化低质量搜索词 |
| **陪玩向回答** | 偏分步引导，避免硬贴大段原文 |

---

## 环境要求

- **Node.js**（与 my-neuro live-2d 一致）
- 依赖：`axios`、`cheerio`（在 `live-2d` 目录执行 `npm install axios cheerio`）
- **Windows**：窗口检测相关能力依赖 PowerShell

---

## 安装方式

将整个插件目录放到 my-neuro 的社区插件路径下，例如：

```text
live-2d/plugins/community/loki-shadow/
```

目录内应包含 `index.js`、`metadata.json`、`plugin_config.json` 及同仓库中的各模块文件。

在 **live-2d** 根目录安装依赖（若尚未安装）：

```bash
npm install axios cheerio
```

在 my-neuro 中启用插件后重启或按界面提示重新加载插件。

---

## 配置说明（`plugin_config.json`）

本仓库中的 `plugin_config.json` 为 **公开模板**：`api_key` 等敏感项为空，**请勿**把填好真实 Key 的文件提交到 Git。

| 配置项 | 说明 |
|--------|------|
| `guide_library_path` | 本地攻略库存放路径，建议使用**绝对路径**，确保进程可读写 |
| `sub_agent` | 主 LLM：API 地址、模型名、温度、`max_tokens` 等 |
| `fallback_agent` | 后备 LLM，字段同上；`api_key` 可与主 Agent 相同 |
| `*_search_limit` / `gamersky_download_limit` | 各来源数量上限，可按网络与配额调整 |
| `max_content_length` | 单段送入模型的最大字符数，防止上下文过长 |

### 编辑 JSON 时的编码（重要）

若使用记事本等保存为 **UTF-8 带 BOM**，可能导致主程序解析 `plugin_config.json` 报错（例如 `Unexpected token`）。建议：

- 使用 **VS Code** 等编辑器，保存为 **UTF-8（无 BOM）**；或  
- 使用已包含 BOM 自动剥离逻辑的 **较新版本 my-neuro** 主程序。

---

## 仓库结构

| 文件 | 说明 |
|------|------|
| `index.js` | 插件入口、工具注册、与主模型协作的协议注入 |
| `orchestrator.js` | 核心工作流编排 |
| `session-context.js` | 游戏会话状态 |
| `sub-agent.js` | LLM 调用与主 / 后备切换 |
| `guide-library.js` | 本地攻略库扫描、读写与去重 |
| `window-detector.js` | Windows 下游戏窗口检测 |
| `*-crawler.js` / `bilibili-fetcher.js` | 各站点抓取与摘要 |
| `retry-utils.js` | 通用重试 |
| `logger.js` | 日志 |
| `metadata.json` | 插件元数据 |
| `plugin_config.json` | 配置模板（无真实密钥） |

---

## 工具说明

### `loki_shadow_track`

上报当前观察到的游戏状态（游戏名、任务、Boss、区域、章节、角色等），用于增强后续查询，**不直接搜索攻略**。

### `loki_shadow_query`

发起正式攻略 / 剧情类查询。请尽量使用**结构化关键词**（任务名、区域、Boss 名等），效果优于零碎截图原文。

---

## 版本记录（节选）

### 2.0.1

- 公开仓库默认配置去除本地机器路径与占位说明，默认攻略库路径与代码内兜底一致为 `./game-guides`（仍建议在界面或 JSON 中改为你的绝对路径）。
- 完善中文 README：安装、配置、编码与隐私说明。

### 2.0.0

- 会话状态追踪与查询联动、多源并行与双 Agent 容灾等能力（详见历史提交）。

---

## 隐私与安全

- **切勿**将含真实 API Key、Cookie、个人路径的 `plugin_config.json` 推送到公开仓库。  
- 若 Key 曾泄露，请在服务商控制台**立即轮换 / 作废**。

---

## 许可证

本项目采用 **CC BY-NC-SA 4.0** 许可证。

---

## 致谢

- my-neuro 及社区  
- 各游戏社区公开内容来源（请遵守各平台服务条款与爬虫礼仪）
