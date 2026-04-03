/**
 * 洛基之影 (Shadow of Loki) - 游戏陪玩智能插件 v2.0
 *
 * 自动检测当前游戏、搜索本地攻略库、从5个来源并行下载攻略，
 * 通过 DeepSeek 主Agent（后备 Qwen）编排全流程，返回精准答案。
 * 来源：游民星空 | B站 | TapTap | NGA | 米游社
 *
 * 作者：爱熬夜的人形兔
 * 版本：2.0.0
 */

const path = require('path');
const { Plugin } = require('../../../js/core/plugin-base.js');
const { Orchestrator } = require('./orchestrator');
const { GameSessionContext } = require('./session-context');

let logToTerminal;
try {
    logToTerminal = require('../../../js/api-utils.js').logToTerminal;
} catch {
    logToTerminal = (level, msg) => console.log(`[${level}] ${msg}`);
}

const TAG = '🗡️ [洛基之影]';

class LokiShadowPlugin extends Plugin {
    constructor(metadata, context) {
        super(metadata, context);
        this._orchestrator = null;
        this._config = null;
        this._sessionCtx = new GameSessionContext(5);
    }

    async onInit() {
        this._loadConfig();
        logToTerminal('info', `${TAG} v2.0 插件初始化完成（含游戏状态追踪）`);
    }

    async onStart() {
        if (!this._config) this._loadConfig();
        if (this._config) {
            const agentInfo = this._config.fallback_agent?.api_key
                ? `主Agent: DeepSeek, 后备: Qwen`
                : `Agent: DeepSeek (无后备)`;
            logToTerminal('info', `${TAG} 插件已启动 | 攻略库: ${this._config.guide_library_path} | ${agentInfo}`);
        }
    }

    async onLLMRequest(request) {
        if (!this._config) return;

        const sysMsg = request.messages.find(m => m.role === 'system');
        if (!sysMsg) return;

        const injection = `

【洛基之影 · 游戏陪玩系统 - 行为协议】
你拥有一个强大的游戏陪玩后端系统"洛基之影"(loki_shadow_query)。请遵循以下协议：

■ 启用条件
- 当你通过截图画面、用户对话内容、或任何线索判断用户正在玩游戏时，自动进入游戏陪玩模式。
- 截图中出现游戏画面（角色、UI、战斗场景、地图、对话框等）即视为用户正在游戏中。

■ 截图分析 - 信息提取规范（核心）
当收到游戏截图时，你必须按优先级提取以下结构化信息：
  1.【任务/关卡名称】截图中任务追踪栏、任务列表、章节标题等UI元素显示的完整任务名
     例如："曙光停摆于荒地之上"、"第三章 永夜降临"、"支线：失落的信件"
  2.【场景/地点名称】地图名、区域名、副本名等
     例如："璃月港"、"枫丹廷"、"深渊螺旋第12层"
  3.【角色/Boss名称】画面中出现的关键角色或正在战斗的Boss名
     例如："钟离"、"风魔龙特瓦林"
  4.【当前游戏阶段】根据画面UI判断用户处于什么阶段
     例如：主线第几章、某个系列任务的哪一步、新手教程、endgame内容

⚠️ 绝对禁止把截图中NPC对话文本、旁白、系统提示等原始文字直接作为query。
   这些只言片语无法搜索到攻略，必须转化为上述结构化信息。

■ 游戏状态追踪（每次都要做！）
- 你拥有 loki_shadow_track 工具，用于持续记录游戏状态。这是轻量操作，瞬间返回，请放心频繁调用。
- 每当你看到游戏截图或和用户聊到游戏内容时，必须调用 loki_shadow_track 报告你观察到的游戏状态：
  · current_quest：从任务追踪栏/任务列表中提取的当前任务名
  · current_boss：正在战斗或即将战斗的Boss名
  · current_area：当前所在区域/地图名
  · current_chapter：当前章节
  · characters：当前相关的角色名列表
- 这些信息可能不在当前截图中，而是来自之前的截图或对话，请从你的对话记忆中提取。
- 当游戏进度变化时（换任务、换地图、打完Boss），传入最新状态即可，旧状态会自动归档。
- ⚠️ track 和 query 是独立的：track 只记录状态不搜索，query 搜索时会自动利用已记录的状态。
  即使你不打算搜索攻略，也要 track 状态！这些信息会在后续搜索时自动增强搜索质量。

■ 谈资获取 - 主动陪玩
- 你的目标是做一个"已经通关的好朋友"，需要主动获取信息来维持有质量的游戏陪聊。
- 看到游戏截图时，即使用户没有提问，你也应该：
  1. 先调用 loki_shadow_track 记录游戏状态（必做）
  2. 判断是否需要获取谈资，如需要则调用 loki_shadow_query
  3. 用获取到的信息自然地和用户互动（评论剧情、讨论角色、分享感受）
- 这不是被动回答问题，而是主动获取知识来陪伴玩家。

■ 答案处理 - 防剧透原则（最重要）
- 从 loki_shadow_query 获得的答案包含详细的剧情/攻略信息，但你绝对不能直接复述给用户！
- 你必须根据用户当前的游戏进度进行信息过滤：
  · 如果用户在某个关卡卡住了 → 给出不涉及后续剧情的操作提示和鼓励，分步引导
  · 如果用户对当前剧情感兴趣 → 只讨论用户已经经历过的部分，对未来情节用暗示性语言
  · 如果用户主动要求剧透 → 可以适当透露，但用"你确定要知道吗？"之类的方式确认
- 引导风格：像一个已经通关的好朋友，用轻松自然的方式聊天，而不是念攻略。

■ 互动模式
- 攻略引导：用户卡关时，先问"你试过XX了吗？"逐步缩小范围，而不是直接给答案
- 剧情讨论：和用户聊已经发生的剧情，分享感受，引发共鸣，不提前剧透
- 角色聊天：讨论角色性格、关系、背景，但不涉及用户还没见到的情节转折
- 主动关注：看到游戏截图时，自然地评论画面内容，比如"这个场景好好看"、"这个Boss看起来很强"

■ 调用规范
- game_name：尽量从截图或对话中识别游戏名，传入准确的中文游戏名
- query：必须是结构化的、可搜索的关键词，格式要求如下：
  · 主线任务："任务名称 + 攻略" 或 "第X章 + 主线流程"
    ✅ "曙光停摆于荒地之上 主线攻略"  ✅ "第三章 主线任务流程"
  · Boss战："Boss名 + 打法攻略"
    ✅ "无相之雷 打法攻略"
  · 剧情相关："章节/任务名 + 剧情"
    ✅ "海灯节 剧情解析"  ✅ "第二章第三幕 剧情"
  · 角色相关："角色名 + 攻略/养成/配队"
    ✅ "钟离 养成攻略"
  · ❌ 禁止示例："心笑 真是没想到啊 红黑纸片人画风"（这是截图对话原文，不是搜索词）
  · ❌ 禁止示例："幻境 好难 这个怪好强"（这是感想碎片，不是搜索词）
- 如果 loki_shadow_query 返回建议使用网络搜索，则调用网络搜索工具继续帮助用户

■ 信息不足时的追问规范
- 如果 loki_shadow_query 返回"需要更多信息"，说明你提供的query质量不够好，请以自然聊天的方式向用户了解更多游戏细节。
- 追问要像朋友聊天，不要机械提问。比如用"你现在是在做主线还是支线呀？"而不是"请告诉我你的当前任务名称"。
- 同一类信息最多追问一次。如果用户没有给出更多信息，就用你已有的信息尝试搜索，不要反复追问让用户烦。
- 追问的同时也可以结合截图内容自然互动，不要让对话变成纯粹的信息收集。`;

        sysMsg.content += injection;
    }

    getTools() {
        if (!this._config) return [];

        return [
            {
                type: 'function',
                function: {
                    name: 'loki_shadow_track',
                    description: '【洛基之影 · 游戏状态追踪】记录当前观察到的游戏状态（任务名、Boss名、区域、章节、角色等）。每次看到游戏截图或聊到游戏时都应调用。轻量操作，瞬间返回，不触发搜索。记录的信息会在后续 loki_shadow_query 搜索时自动增强搜索质量。',
                    parameters: {
                        type: 'object',
                        properties: {
                            game_name: {
                                type: 'string',
                                description: '游戏名称'
                            },
                            current_quest: {
                                type: 'string',
                                description: '当前任务/关卡名称（从任务追踪栏、任务列表等UI中提取）'
                            },
                            current_boss: {
                                type: 'string',
                                description: '当前正在战斗或即将战斗的Boss名称'
                            },
                            current_area: {
                                type: 'string',
                                description: '当前所在区域/地图/场景名称'
                            },
                            current_chapter: {
                                type: 'string',
                                description: '当前章节（如"第三章"、"序章"等）'
                            },
                            characters: {
                                type: 'array',
                                items: { type: 'string' },
                                description: '当前相关角色名列表'
                            }
                        },
                        required: ['game_name']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'loki_shadow_query',
                    description: '【洛基之影 · 游戏陪玩】查询攻略/剧情信息。先搜索本地攻略库，不足时自动从游民星空、B站、TapTap、NGA、米游社5个来源并行下载新攻略并整合。会自动利用 loki_shadow_track 记录的游戏状态来增强搜索质量。你应当对返回的信息进行防剧透处理后再告知用户。',
                    parameters: {
                        type: 'object',
                        properties: {
                            game_name: {
                                type: 'string',
                                description: '游戏名称（可选，不提供则通过检测窗口进程自动识别当前游戏）'
                            },
                            query: {
                                type: 'string',
                                description: '具体问题，如：某Boss怎么打、第三章剧情是什么、某任务怎么做等'
                            }
                        },
                        required: ['query']
                    }
                }
            }
        ];
    }

    async executeTool(name, params) {
        if (name === 'loki_shadow_track') {
            return this._handleTrack(params);
        }
        if (name === 'loki_shadow_query') {
            return this._handleQuery(params);
        }
        return undefined;
    }

    _handleTrack(params) {
        const { game_name, current_quest, current_boss, current_area, current_chapter, characters } = params;

        if (!game_name) {
            return '【洛基之影】game_name 不能为空';
        }

        this._sessionCtx.update(game_name, {
            current_quest, current_boss, current_area, current_chapter, characters
        });

        const status = this._sessionCtx.getStatusText();
        logToTerminal('info', `${TAG} 状态追踪更新 | 游戏: ${game_name} | ${status}`);

        return `【洛基之影 · 状态已记录】${game_name} | ${status}`;
    }

    async _handleQuery(params) {
        const { game_name, query } = params;

        if (!query || query.trim().length === 0) {
            return '【洛基之影】请提供具体的问题（query 参数不能为空）';
        }

        logToTerminal('info', `${TAG} 收到查询请求 | 游戏: ${game_name || '(自动检测)'} | 问题: ${query}`);

        this._ensureOrchestrator();
        return await this._orchestrator.execute(game_name || null, query.trim(), this._sessionCtx);
    }

    _loadConfig() {
        const defaultGuideLibraryPath = path.join(__dirname, 'game-guides');
        const defaults = {
            guide_library_path: defaultGuideLibraryPath,
            sub_agent: {
                api_key: '',
                api_url: 'https://api.siliconflow.cn/v1',
                model: 'deepseek-ai/DeepSeek-V3.2',
                temperature: 0.3,
                max_tokens: 20000
            },
            fallback_agent: {
                api_key: '',
                api_url: 'https://api.siliconflow.cn/v1',
                model: 'Qwen/Qwen3.5-397B-A17B',
                temperature: 0.3,
                max_tokens: 20000
            },
            gamersky_download_limit: 1,
            bilibili_search_limit: 3,
            taptap_search_limit: 1,
            nga_search_limit: 1,
            miyoushe_search_limit: 1,
            max_content_length: 20000
        };

        try {
            const rawCfg = this.context.getPluginConfig();
            const subAgent = rawCfg.sub_agent || {};
            const fallbackAgent = rawCfg.fallback_agent || {};

            const _v = (val, def) => (val !== undefined && val !== null && val !== '') ? val : def;

            const configuredGuideLibraryPath = _v(rawCfg.guide_library_path, defaults.guide_library_path);
            const resolvedGuideLibraryPath = path.isAbsolute(configuredGuideLibraryPath)
                ? configuredGuideLibraryPath
                : path.resolve(__dirname, configuredGuideLibraryPath);

            this._config = {
                guide_library_path: resolvedGuideLibraryPath,
                sub_agent: {
                    api_key: _v(subAgent.api_key, defaults.sub_agent.api_key),
                    api_url: _v(subAgent.api_url, defaults.sub_agent.api_url),
                    model: _v(subAgent.model, defaults.sub_agent.model),
                    temperature: _v(subAgent.temperature, defaults.sub_agent.temperature),
                    max_tokens: _v(subAgent.max_tokens, defaults.sub_agent.max_tokens)
                },
                fallback_agent: {
                    api_key: _v(fallbackAgent.api_key, defaults.fallback_agent.api_key),
                    api_url: _v(fallbackAgent.api_url, defaults.fallback_agent.api_url),
                    model: _v(fallbackAgent.model, defaults.fallback_agent.model),
                    temperature: _v(fallbackAgent.temperature, defaults.fallback_agent.temperature),
                    max_tokens: _v(fallbackAgent.max_tokens, defaults.fallback_agent.max_tokens)
                },
                gamersky_download_limit: _v(rawCfg.gamersky_download_limit, defaults.gamersky_download_limit),
                bilibili_search_limit: _v(rawCfg.bilibili_search_limit, defaults.bilibili_search_limit),
                taptap_search_limit: _v(rawCfg.taptap_search_limit, defaults.taptap_search_limit),
                nga_search_limit: _v(rawCfg.nga_search_limit, defaults.nga_search_limit),
                miyoushe_search_limit: _v(rawCfg.miyoushe_search_limit, defaults.miyoushe_search_limit),
                max_content_length: _v(rawCfg.max_content_length, defaults.max_content_length)
            };
        } catch (err) {
            logToTerminal('warn', `${TAG} 配置加载失败，使用默认值: ${err.message}`);
            this._config = defaults;
        }

        this._orchestrator = null;
    }

    _ensureOrchestrator() {
        if (!this._orchestrator) {
            this._orchestrator = new Orchestrator(this._config);
        }
    }
}

module.exports = LokiShadowPlugin;
