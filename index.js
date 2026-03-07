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
        logToTerminal('info', `${TAG} v2.0 插件初始化完成`);
    }

    async onStart() {
        this._loadConfig();
        if (this._config && this._config.enabled) {
            const agentInfo = this._config.fallback_agent?.api_key
                ? `主Agent: DeepSeek, 后备: Qwen`
                : `Agent: DeepSeek (无后备)`;
            logToTerminal('info', `${TAG} 插件已启动 | 攻略库: ${this._config.guide_library_path} | ${agentInfo}`);
        } else {
            logToTerminal('warn', `${TAG} 插件已加载但未启用`);
        }
    }

    async onLLMRequest(request) {
        if (!this._config || !this._config.enabled) return;

        const sysMsg = request.messages.find(m => m.role === 'system');
        if (!sysMsg) return;

        const injection = `

【洛基之影 · 游戏陪玩系统 - 行为协议】
你拥有一个强大的游戏陪玩后端系统"洛基之影"(loki_shadow_query)。请遵循以下协议：

■ 启用条件
- 当你通过截图画面、用户对话内容、或任何线索判断用户正在玩游戏时，自动进入游戏陪玩模式。
- 截图中出现游戏画面（角色、UI、战斗场景、地图、对话框等）即视为用户正在游戏中。

■ 截图分析与提问
- 当收到截图且画面是游戏内容时，你需要：
  1. 分析截图中的游戏场景（当前关卡/剧情位置/Boss战/任务界面/对话内容等）
  2. 结合用户的对话，判断用户当前可能需要什么帮助（卡关？好奇剧情？想了解角色？）
  3. 将分析结果转化为具体问题，调用 loki_shadow_query 获取信息
- 即使用户没有直接提问，但截图明显显示游戏画面时，你也应该主动结合画面内容与用户互动。

■ 答案处理 - 防剧透原则（最重要）
- 从 loki_shadow_query 获得的答案包含详细的剧情/攻略信息，但你绝对不能直接复述给用户！
- 你必须根据用户当前的游戏进度进行信息过滤：
  · 如果用户在某个关卡卡住了 → 给出不涉及后续剧情的操作提示和鼓励，分步引导
  · 如果用户对当前剧情感兴趣 → 只讨论用户已经经历过的部分，对未来情节用暗示性语言
  · 如果用户主动要求剧透 → 可以适当透露，但用"你确定要知道吗？"之类的方式确认
- 引导风格：像一个已经通关的好朋友，用轻松自然的方式给提示，而不是念攻略。

■ 互动模式
- 攻略引导：用户卡关时，先问"你试过XX了吗？"逐步缩小范围，而不是直接给答案
- 剧情讨论：和用户聊已经发生的剧情，分享感受，引发共鸣，不提前剧透
- 角色聊天：讨论角色性格、关系、背景，但不涉及用户还没见到的情节转折
- 主动关注：看到游戏截图时，可以自然地评论画面内容，比如"这个场景好好看"、"这个Boss看起来很强"

■ 调用规范
- game_name：尽量从截图或对话中识别游戏名，传入准确的中文游戏名
- query：将用户的需求转化为清晰具体的问题，便于后端检索
- 如果 loki_shadow_query 返回建议使用网络搜索，则调用网络搜索工具继续帮助用户`;

        sysMsg.content += injection;
    }

    getTools() {
        if (!this._config || !this._config.enabled) return [];

        return [{
            type: 'function',
            function: {
                name: 'loki_shadow_query',
                description: '【洛基之影 · 游戏陪玩】自动检测当前游戏并查询攻略/剧情信息。先搜索本地攻略库，不足时自动从游民星空、B站、TapTap、NGA、米游社5个来源并行下载新攻略并整合，返回精准答案。如果攻略库无法解答，会建议使用网络搜索工具。用于获取游戏攻略、剧情、角色信息等。你应当对返回的信息进行防剧透处理后再告知用户。',
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
            guide_library_path: 'K:\\neruo\\my-neuro-main\\肥牛的秘密基地\\游戏攻略库',
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
                fallback_agent: {
                    api_key: fallbackAgent.api_key || defaults.fallback_agent.api_key,
                    api_url: fallbackAgent.api_url || defaults.fallback_agent.api_url,
                    model: fallbackAgent.model || defaults.fallback_agent.model,
                    temperature: fallbackAgent.temperature || defaults.fallback_agent.temperature,
                    max_tokens: fallbackAgent.max_tokens || defaults.fallback_agent.max_tokens
                },
                gamersky_download_limit: rawCfg.gamersky_download_limit || defaults.gamersky_download_limit,
                bilibili_search_limit: rawCfg.bilibili_search_limit || defaults.bilibili_search_limit,
                taptap_search_limit: rawCfg.taptap_search_limit || defaults.taptap_search_limit,
                nga_search_limit: rawCfg.nga_search_limit || defaults.nga_search_limit,
                miyoushe_search_limit: rawCfg.miyoushe_search_limit || defaults.miyoushe_search_limit,
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
