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

【洛基之影 · 公共版说明】
当你判断用户正在玩游戏时，可以结合截图或对话调用 loki_shadow_track 记录任务、区域、Boss、章节和角色等状态；需要攻略或剧情资料时，再调用 loki_shadow_query。
请优先使用结构化关键词发起查询，并在回复中尽量避免剧透，采用循序渐进的提示式表达。`;

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
