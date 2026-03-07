/**
 * 洛基之影 (Shadow of Loki) - 游戏陪玩智能插件
 *
 * 自动检测当前游戏、搜索本地攻略库、从游民星空和B站下载攻略，
 * 通过 DeepSeek 下级智能体编排全流程，返回精准游戏攻略与剧情答案。
 *
 * 作者：爱熬夜的人形兔
 * 版本：1.0.0
 */

const { Plugin } = require('../../../js/core/plugin-base.js');
const { Orchestrator } = require('./orchestrator');

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
    }

    async onInit() {
        this._loadConfig();
        logToTerminal('info', `${TAG} 插件初始化完成`);
    }

    async onStart() {
        this._loadConfig();
        if (this._config && this._config.enabled) {
            logToTerminal('info', `${TAG} 插件已启动 | 攻略库: ${this._config.guide_library_path}`);
        } else {
            logToTerminal('warn', `${TAG} 插件已加载但未启用`);
        }
    }

    getTools() {
        if (!this._config || !this._config.enabled) return [];

        return [{
            type: 'function',
            function: {
                name: 'loki_shadow_query',
                description: '【洛基之影 · 游戏陪玩】自动检测当前游戏并查询攻略/剧情信息。先搜索本地攻略库，不足时自动从游民星空和B站下载新攻略并整合，返回精准答案。如果攻略库无法解答，会建议使用网络搜索工具。',
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
        }];
    }

    async executeTool(name, params) {
        if (name !== 'loki_shadow_query') return undefined;

        const { game_name, query } = params;

        if (!query || query.trim().length === 0) {
            return '【洛基之影】请提供具体的问题（query 参数不能为空）';
        }

        logToTerminal('info', `${TAG} 收到查询请求 | 游戏: ${game_name || '(自动检测)'} | 问题: ${query}`);

        this._ensureOrchestrator();
        return await this._orchestrator.execute(game_name || null, query.trim());
    }

    _loadConfig() {
        const defaults = {
            enabled: true,
            guide_library_path: '',
            sub_agent: {
                api_key: '',
                api_url: 'https://api.siliconflow.cn/v1',
                model: 'deepseek-ai/DeepSeek-V3.2',
                temperature: 0.3,
                max_tokens: 20000
            },
            gamersky_download_limit: 1,
            bilibili_search_limit: 3,
            max_content_length: 20000
        };

        try {
            const rawCfg = this.context.getPluginConfig();
            const subAgent = rawCfg.sub_agent || {};

            this._config = {
                enabled: rawCfg.enabled !== undefined ? rawCfg.enabled : defaults.enabled,
                guide_library_path: rawCfg.guide_library_path || defaults.guide_library_path,
                sub_agent: {
                    api_key: subAgent.api_key || defaults.sub_agent.api_key,
                    api_url: subAgent.api_url || defaults.sub_agent.api_url,
                    model: subAgent.model || defaults.sub_agent.model,
                    temperature: subAgent.temperature || defaults.sub_agent.temperature,
                    max_tokens: subAgent.max_tokens || defaults.sub_agent.max_tokens
                },
                gamersky_download_limit: rawCfg.gamersky_download_limit || defaults.gamersky_download_limit,
                bilibili_search_limit: rawCfg.bilibili_search_limit || defaults.bilibili_search_limit,
                max_content_length: rawCfg.max_content_length || defaults.max_content_length
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
