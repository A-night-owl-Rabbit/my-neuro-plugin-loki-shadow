/**
 * 洛基之影 (Shadow of Loki) - 游戏陪玩智能插件 v3.1.0
 *
 * v3.1.0 (引擎可切换)：
 *   - 新增 search_engine 配置项：kimi / glm
 *     · kimi → 调用 kimi-search 暴露的 kimi_web_search（Kimi 一站式快总结）
 *     · glm  → 调用 glm-search 暴露的 glm_web_search（智谱清言 GLM-5.1 / 沉思模型）
 *   - GLM 引擎不支持 silent 参数，glm_deep_research 与 kimi_deep_research 各自独立配置
 *   - 错误检测、日志、回包 header/tail 文案均按当前引擎动态适配
 *
 * v3.0.0 (检索引擎换骨)：
 *   - 移除本地攻略库 / 向量召回 / 游民星空 / B站 / 多源网络搜索
 *   - 移除 sub-agent (DeepSeek/Qwen) 双 LLM 整合体系
 *   - loki_shadow_query 一站式委托给外部联网搜索工具
 *   - 发给搜索引擎的 query 极简化：默认仅 "游戏名 + 原始问题"，若已记录主线任务则自动附带 "主线任务：任务名" 作为上下文，全力召回；
 *     防剧透 / 进度感知交给主对话模型在收到答案后按 onLLMRequest 注入的协议处理
 *   - 保留：游戏窗口检测、track 状态追踪、跨会话记忆、game-name 守卫、陪玩/防剧透协议注入
 *
 * 历史：
 *   v2.4.2 移除 characters 角色栏追踪
 *   v2.4.1 移除剧情被动注入
 *   v2.3.x 跨会话持久化、剧透偏好
 *   v2.2   多源并行（已被一站式引擎取代）
 *
 * 作者：爱熬夜的人形兔
 * 版本：3.1.0
 */

const path = require('path');
const { Plugin } = require('../../../js/core/plugin-base.js');
const { GameSessionContext } = require('./session-context');
const { getGameSnapshot, saveGameSnapshot } = require('./persist-store');
const { getTrackGameNameRejection } = require('./game-name-guard');
const { detectCurrentGame } = require('./window-detector');
const { LokiLogger } = require('./logger');
const { isSceneRoutingEnabled } = require('../../../js/ai/scene-routing-service.js');

const WINDOW_TITLE_CLEANUPS = [
    /\s*[-|｜丨·•]+\s*(?:visual novel|galgame|steam|unity|unreal engine)\s*$/i,
    /\s*\[[^\]]+\]\s*$/,
    /^\s*playing\s*[:-]\s*/i,
    /^\s*now\s*playing\s*[:-]\s*/i
];

// 引擎元数据：把 kimi/glm 的差异集中在这里，业务代码只看 _engineMeta()
const ENGINE_META = {
    kimi: {
        label: 'Kimi',
        toolName: 'kimi_web_search',
        // Kimi 错误回包；含 HTTP/插件错误、合规拒答、以及 200 正文的「人太多/累了/晚点再问」类繁忙限流话术
        errorPattern: /^错误：|Kimi 认证失败|Kimi 限流|无法连接到 Kimi|Kimi 联网搜索失败|\[Kimi 返回了空内容|内容由于不合规|不合规被停止|被停止生成|换个话题吧|安全策略|内容审核未通过|无法回答该问题|和\s*Kimi\s*聊的人太多|聊的人太多了|Kimi\s*有点累了|晚点再问我|稍后再来问我/i,
        emptyHint: 'Kimi 返回空内容'
    },
    glm: {
        label: 'GLM',
        toolName: 'glm_web_search',
        // GLM 错误回包前缀（来自 glm-search/index.js _formatError）
        errorPattern: /^错误：|GLM 认证失败|GLM 限流|GLM 模型不存在|无法连接到 GLM-Free-API|GLM 联网搜索失败|\[GLM 返回了空内容/,
        emptyHint: 'GLM 返回空内容'
    }
};

class LokiShadowPlugin extends Plugin {

    async onInit() {
        this._pluginConfig = this.context.getPluginConfig();
        if (!this._pluginConfig.enabled) {
            this.context.log('info', '洛基之影已禁用');
            return;
        }

        this._sessionCtx = null;
        this._config = null;

        this._loadConfig();
        const ttl = this._config.session_context_ttl_ms ?? 60000;
        this._sessionCtx = new GameSessionContext(5, ttl);
        const meta = this._engineMeta();
        this.context.log(
            'info',
            `洛基之影 v3.1.0 初始化完成 | 检索引擎=${meta.label}(${meta.toolName}) | 会话TTL=${ttl}ms | 跨会话记忆=${this._config.enable_cross_session_memory !== false ? '开' : '关'}`
        );
    }

    async onStart() {
        if (!this._pluginConfig.enabled) return;
        if (!this._config) this._loadConfig();

        if (this._config) {
            const meta = this._engineMeta();
            this.context.log('info', `洛基之影已启动 | 检索一站式委托给 ${meta.toolName}`);
            if (this._config.enable_cross_session_memory !== false) {
                this.context.log(
                    'info',
                    `洛基之影 跨会话状态文件: ${path.join(this._config.persist_dir, '.loki-shadow-persist.json')}`
                );
            }
        }
    }

    _engineMeta() {
        const key = (this._config && this._config.search_engine) || 'kimi';
        return ENGINE_META[key] || ENGINE_META.kimi;
    }

    async onLLMRequest(request) {
        if (!this._pluginConfig.enabled) return;
        if (!this._config) return;
        if (isSceneRoutingEnabled(this.context.getConfig())) return;

        const sysMsg = request.messages.find(m => m.role === 'system');
        if (!sysMsg) return;

        sysMsg.content += `\n\n${this._buildSceneProtocol()}`;
    }

    _buildSceneProtocol() {
        const meta = this._engineMeta();
        const engineSummary = meta.label === 'Kimi'
            ? 'Kimi 联网 AI 搜索一站式获取答案，速度快、答案完整'
            : '智谱清言 GLM-5.1 联网搜索一站式获取答案，擅长长文档、多源对比、深度剧情分析';

        return `【洛基之影 · 游戏陪玩系统 - 行为协议】
你拥有游戏陪玩后端"洛基之影"(loki_shadow_track / loki_shadow_query)。
loki_shadow_query 内部已自动委托给 ${engineSummary}。

■ 启用条件
- 当前截图存在游戏UI证据（任务栏、HUD、地图、角色面板）或最近60秒窗口/进程命中已知游戏时，进入陪玩模式。
- 每次基于当前截图判断，不要场景惯性；但窗口核验命中同一游戏时，过场CG优先视为游戏内画面。
- 用户明确说出正在玩的作品（如“我在玩刺客信条”）时，先以 source=user_confirmed 同步一次作品名；这不是截图证据，不能据此编造任务、章节、地点或画面。
- 视频网站/播放器/直播画面且无游戏进程佐证时，不启用陪玩模式。
- game_name 只能是游戏作品正式名称，禁止填应用/平台名。

■ 截图信息提取
游戏截图中按优先级提取：①任务/关卡名 ②场景/地点名 ③角色/Boss名 ④当前游戏阶段。
⚠️ 禁止把NPC对话原文、旁白直接当query，必须转化为结构化关键词。

■ 状态追踪核心原则
- 每个顶层用户输入或主动触发中，针对同一张截图/同一游戏状态最多成功调用一次 loki_shadow_track；如果本轮已经收到成功的追踪结果，就不要再次调用，直接依据结果回复。只有取得新截图且状态确实变化时，才允许再次更新；非游戏场景或无法确定作品名时不要 track。
- 用户明确确认“我在玩/我玩这个 <游戏名>”而当前没有截图或窗口证据时，也要用 game_name 和 source=user_confirmed 轻量同步一次；只记录作品名，不填 main_quest、current_step、current_area、current_chapter，也不因此调用 query。
- main_quest 严格管控：只接受 screenshot 和 user_confirmed 来源，讨论剧情角色不等于任务变了，不确定就不要传。
- current_chapter：截图中看到章节信息时必须填写，看不到可不填。章节信息对系统追踪进度很重要。
- 讨论剧情角色时，只更新 current_step（记录具体情节推进），绝不动 main_quest。
- track 和 query 独立：track 只负责同步当前状态，不触发搜索；每个顶层轮次最多同步一次同一状态。query 通常由你判断，有明确问题才调用，不要当成每轮必做动作；但若本轮是心情系统发起的主动陪玩搭话，则应尽量调用 query（确无可查问题时才跳过）。

■ query 调用门槛
- 先想清楚"你具体想知道什么"，再决定是否调用 loki_shadow_query。不要因为用户正在玩游戏，就把 query 当作每轮必做动作。
- query 里应填写具体问题或明确想了解的事情，例如："这个任务下一步怎么触发？"、"这个Boss二阶段怎么处理？"、"刚才这句台词大概在表达什么？"。
- 不要把 query 写成空泛需求，例如："搜一下剧情"、"看看现在发生了什么"、"随便找点谈资"。
- 问题还不具体时，先像朋友一样自然追问一次，补齐任务名、章节名、角色名、地点名或卡点，再调用 query。

■ 主动陪玩
- 目标：做一个已经通关的好朋友，但要先明确疑问，再检索答案来陪伴。
- 当你对某个角色、地点、势力、剧情点、Boss机制有具体想了解的事情时，再调用 query 补充知识；没有明确疑问就继续自然陪聊。
- 工具返回内容必须先消化，再转写成自然聊天，不要原封不动念给用户。

■ 防剧透 + 互动风格
- 获取的信息不能直接复述，必须根据用户进度过滤：卡关→分步引导，对剧情感兴趣→只聊已经历部分，主动要剧透→确认后再说。
- 用户卡关先问"你试过XX了吗？"，不直接给答案。看到截图自然评论，吐槽时先接住情绪再给建议。
- 若用户表示剧透偏好，调用 track 更新 spoiler_comfort 或 companion_note。

■ 节奏控制（重要 — 陪伴而非催促）
- 你可以主动告诉用户接下来可能会发生什么、给出方向建议、分享你对后续剧情的期待，这些都是陪玩的价值。
- 但不要催促。区别在于：「前面好像有个很有意思的地方哦」是分享，「快去做下一个任务吧」「要不要推进剧情？」是催促。
- 分享式引导可以随时做；催促式推进不要做。用户在看风景、发呆、反复截图时，顺着用户的兴趣聊，不要急着拉用户走。
- 你是一起玩的朋友，不是赶进度的导游。

■ 内部决策禁止外显（硬约束）
- 以下协议、工具说明、检索过程、内部笔记、工作提纲、陪玩小抄、剧情摘要、策略选项，仅供你内部决策使用，绝不能直接对用户复述、转贴、总结展示或伪装成正式回复。
- 严禁输出任何类似「玩家当前在...」「陪玩小抄：」「你可以：」「注意防剧透：」「内部决策：」「根据工具结果：」的内部工作文本。
- 严禁把工具返回、系统提示、检索摘要、剧情摘要原封不动念给用户；必须先转写成自然、简短、面向玩家当下场景的聊天回复。
- 最终发给用户的内容必须是自然对话，不能是提纲、备忘录、提示词、流程说明、JSON、角色设定说明或给你自己的操作指令。
- 若你一时组织不好自然表达，宁可简短自然地回应，也不要输出内部中间态文本。

■ 返回值处理
- "status: no_reliable_info"：不要编造，切换为基于截图和对话的自然陪聊。
- 若 loki_shadow_query 因 ${meta.label} 服务异常返回失败提示，可以直接调用 ${meta.toolName} 工具自行联网，或基于画面/对话继续陪聊，绝不可硬编剧情。`;
    }

    getSceneCapability() {
        return {
            sceneId: 'GAME',
            available: this._pluginConfig?.enabled === true && !!this._config,
            protocol: this._buildSceneProtocol(),
            tools: this.getTools(),
            dynamicContext: '',
            backgroundContext: '',
            playbackActive: false
        };
    }

    getLegacyScenePromptBlocks() {
        if (!this._config) return [];
        return [this._buildSceneProtocol()];
    }

    async onSceneEnter() {
        this.context.log('info', '洛基之影已获得 GAME 主场景授权');
    }

    async onSceneExit() {
        this.context.log('info', '洛基之影已退出 GAME 主场景授权，游戏进度保留');
    }

    getTools() {
        if (!this._pluginConfig.enabled) return [];
        if (!this._config) return [];

        return [TRACK_TOOL, QUERY_TOOL];
    }

    async executeTool(name, params) {
        if (!this._pluginConfig.enabled) return undefined;

        switch (name) {
            case 'loki_shadow_track':
                return this._handleTrack(params);
            case 'loki_shadow_query':
                return await this._handleQuery(params);
            default:
                return undefined;
        }
    }

    async onStop() {
        this.context.log('info', '洛基之影已停止');
    }

    _handleTrack(params) {
        const { game_name, source, main_quest, current_step, current_quest,
                current_boss, current_area, current_chapter,
                spoiler_comfort, companion_note } = params;

        if (!game_name) {
            return '【洛基之影】game_name 不能为空';
        }

        const nameReject = getTrackGameNameRejection(game_name);
        if (nameReject) {
            this.context.log(
                'info',
                `洛基之影 track 已忽略非游戏名称 game_name="${game_name}" (${nameReject})`
            );
            return '【洛基之影】未记录：game_name 必须是用户正在玩的**游戏作品**正式名，不能用视频网站、浏览器、播放器等应用名。当前画面若非游戏界面或无法确定作品名，请不要调用 loki_shadow_track。';
        }

        const persistDir = this._config?.persist_dir;
        const persistOn = this._config?.enable_cross_session_memory !== false;
        this._ensureSessionContextForGame(game_name);

        const validSources = ['screenshot', 'conversation', 'user_confirmed'];
        const validSource = validSources.includes(source) ? source : 'conversation';

        const { warnings } = this._sessionCtx.update(game_name, {
            main_quest, current_step, current_quest,
            current_boss, current_area, current_chapter,
            spoiler_comfort, companion_note
        }, validSource);

        if (persistOn && persistDir) {
            try {
                saveGameSnapshot(persistDir, game_name, this._sessionCtx.toSnapshot());
            } catch (err) {
                this.context.log('warn', `洛基之影 持久化失败: ${err.message}`);
            }
        }

        const status = this._sessionCtx.getStatusText();
        this.context.log('info', `洛基之影 状态追踪更新 | 游戏: ${game_name} | 来源: ${validSource} | ${status}`);

        let result = `【洛基之影 · 当前画面锚点】${game_name} | ${status}`;
        result += '\n请把这条记录当作本轮最新截图/当前游戏状态的优先事实。最终回复必须顺着这里的当前步骤说，不能沿用旧对话里已经过时的菜单、按钮、位置或任务判断。';
        result += '\n本轮相同状态已经完成追踪，不要再次调用 loki_shadow_track；直接依据这条结果回复，或在确有具体问题时调用 loki_shadow_query。';
        if (warnings.length > 0) {
            result += '\n\n' + warnings.join('\n');
            this.context.log('warn', `洛基之影 追踪警告: ${warnings.join(' | ')}`);
        }
        return result;
    }

    async _handleQuery(params) {
        const { game_name, query } = params;
        const log = new LokiLogger();

        if (!query || query.trim().length === 0) {
            return '【洛基之影】请提供具体的问题（query 参数不能为空）';
        }

        if (game_name && getTrackGameNameRejection(game_name)) {
            this.context.log(
                'info',
                `洛基之影 query 已拒绝非游戏名称 game_name="${game_name}"，请省略 game_name 或传入真实作品名`
            );
            return '【洛基之影】query 的 game_name 不能是视频网站/浏览器等应用名；请省略 game_name 让系统自动检测窗口中的游戏，或传入真实游戏作品名后重试。';
        }

        const cleanQuery = query.trim();
        this.context.log('info', `洛基之影 收到查询请求 | 游戏: ${game_name || '(自动检测)'} | 问题: ${cleanQuery}`);

        let actualGameName = game_name;
        if (!actualGameName) {
            log.step('Step1:游戏检测', 'start', '自动检测中...');
            try {
                const detection = await detectCurrentGame();
                if (detection.detected) {
                    actualGameName = detection.gameName;
                    log.step('Step1:游戏检测', 'ok', `游戏: ${actualGameName} (窗口: ${detection.windowTitle})`);
                } else {
                    const configuredMatch = this._resolveConfiguredGameName(detection);
                    if (configuredMatch) {
                        actualGameName = configuredMatch.gameName;
                        log.step('Step1:游戏检测', 'ok', `游戏: ${actualGameName} (${configuredMatch.matchedBy}: ${configuredMatch.matchedValue})`);
                    } else {
                        const guessedMatch = this._guessGameNameFromForegroundWindow(detection);
                        if (guessedMatch) {
                            actualGameName = guessedMatch.gameName;
                            log.step('Step1:游戏检测', 'warn', `未命中已知游戏，回退使用前台窗口标题: ${actualGameName}`);
                        } else {
                            const winList = (detection.allWindows || []).map(w => w.windowTitle).slice(0, 5).join(', ');
                            log.step('Step1:游戏检测', 'fail', `未匹配已知游戏；当前窗口: ${winList}`);
                            return '【洛基之影】无法检测到当前正在运行的游戏。请在调用时指定 game_name 参数，例如：game_name="绝区零"';
                        }
                    }
                }
            } catch (err) {
                log.error('Step1:游戏检测', err);
                return `【洛基之影】游戏窗口检测失败: ${err.message}。请手动指定 game_name 参数。`;
            }
        } else {
            log.step('Step1:游戏检测', 'ok', `用户指定: ${actualGameName}`);
        }

        this._ensureSessionContextForGame(actualGameName);
        const currentScope = this._sessionCtx?.getCurrentScope?.() || {};
        const composedQuery = this._composeQuery(actualGameName, cleanQuery, currentScope.mainQuest);
        const questHint = currentScope.mainQuest ? ` | 主线任务: ${currentScope.mainQuest}` : '';
        log.step('Step2:拼接query', 'ok', `"${composedQuery}"${questHint}`);

        const meta = this._engineMeta();
        const stepLabel = `Step3:${meta.label}联网搜索`;
        const toolArgs = this._buildToolArgs(composedQuery);
        const argsHint = Object.entries(toolArgs)
            .filter(([k]) => k !== 'query')
            .map(([k, v]) => `${k}=${v}`)
            .join(' | ') || '(默认参数)';
        log.step(stepLabel, 'start', argsHint);

        let answer;
        try {
            if (!global.pluginManager) {
                throw new Error(`pluginManager 不可用，无法调用 ${meta.toolName}`);
            }
            answer = await global.pluginManager.executeTool(meta.toolName, toolArgs);
        } catch (err) {
            log.error(stepLabel, err);
            this._writeSummary(log);
            return this._buildFailureFallback(actualGameName, cleanQuery, err.message);
        }

        const answerStr = this._normalizeAnswer(answer);

        if (!answerStr) {
            log.step(stepLabel, 'fail', '返回空内容');
            this._writeSummary(log);
            return this._buildFailureFallback(actualGameName, cleanQuery, meta.emptyHint);
        }

        if (this._looksLikeEngineError(answerStr)) {
            log.step(stepLabel, 'fail', `${meta.label} 错误回包: ${answerStr.substring(0, 80)}`);
            this._writeSummary(log);
            return this._buildFailureFallback(actualGameName, cleanQuery, answerStr);
        }

        log.step(stepLabel, 'ok', `答案长度: ${answerStr.length}`);
        this._writeSummary(log);

        const header = `【${actualGameName} · 洛基之影 · ${meta.label}联网】\n原问题：${cleanQuery}`;
        const tail = `【提示】以上由 ${meta.label} 联网搜索整合，请按 spoiler_comfort 与玩家进度做防剧透处理后再转述给用户。`;
        return `${header}\n\n${answerStr}\n\n---\n${tail}`;
    }

    _ensureSessionContextForGame(gameName) {
        if (!gameName || !this._sessionCtx) return;

        const switching = this._sessionCtx.currentGame && gameName !== this._sessionCtx.currentGame;
        const coldStart = !this._sessionCtx.lastUpdateTime;
        const persistDir = this._config?.persist_dir;
        const persistOn = this._config?.enable_cross_session_memory !== false;
        if (!persistOn || !persistDir) {
            if (switching) {
                this._sessionCtx.reset();
            }
            return;
        }

        if (switching) {
            this._sessionCtx.reset();
        }

        if (switching || coldStart) {
            const snap = getGameSnapshot(persistDir, gameName);
            if (snap) this._sessionCtx.hydrateFromSnapshot(snap);
        }
    }

    _buildToolArgs(composedQuery) {
        const engine = (this._config && this._config.search_engine) || 'kimi';
        if (engine === 'glm') {
            return {
                query: composedQuery,
                deep_research: this._config.glm_deep_research === true
            };
        }
        return {
            query: composedQuery,
            silent: this._config.kimi_silent !== false,
            deep_research: this._config.kimi_deep_research === true
        };
    }

    _resolveConfiguredGameName(detection) {
        const aliases = Array.isArray(this._config?.game_aliases) ? this._config.game_aliases : [];
        if (!aliases.length || !detection) return null;

        const candidates = [];
        if (detection.foregroundWindow) candidates.push(detection.foregroundWindow);
        if (Array.isArray(detection.allWindows)) candidates.push(...detection.allWindows);

        for (const alias of aliases) {
            if (!alias || !alias.gameName) continue;
            const processPatterns = Array.isArray(alias.processNames) ? alias.processNames : [];
            const titlePatterns = Array.isArray(alias.windowTitles) ? alias.windowTitles : [];

            for (const proc of candidates) {
                const processName = String(proc?.processName || '').trim().toLowerCase();
                const windowTitle = String(proc?.windowTitle || '').trim().toLowerCase();
                const processHit = processPatterns.some(pattern => processName && processName.includes(String(pattern || '').trim().toLowerCase()));
                const titleHit = titlePatterns.some(pattern => windowTitle && windowTitle.includes(String(pattern || '').trim().toLowerCase()));
                if (processHit || titleHit) {
                    return {
                        gameName: alias.gameName,
                        matchedBy: processHit ? 'config.processName' : 'config.windowTitle',
                        matchedValue: processHit ? proc.processName : proc.windowTitle,
                        windowTitle: proc.windowTitle || '',
                        processName: proc.processName || ''
                    };
                }
            }
        }

        return null;
    }

    _guessGameNameFromForegroundWindow(detection) {
        const foreground = detection?.foregroundWindow;
        const rawTitle = String(foreground?.windowTitle || '').trim();
        if (!rawTitle) return null;

        let candidate = rawTitle;
        for (const pattern of WINDOW_TITLE_CLEANUPS) {
            candidate = candidate.replace(pattern, '').trim();
        }
        candidate = candidate.replace(/\s{2,}/g, ' ').trim();
        if (!candidate) return null;
        if (getTrackGameNameRejection(candidate)) return null;
        if (/^[A-Za-z]:\\|^C:\\Windows\\|\.bat$|\.exe$/i.test(candidate)) return null;
        if (candidate.length < 2) return null;

        return {
            gameName: candidate,
            matchedBy: 'foreground.windowTitle',
            matchedValue: rawTitle,
            windowTitle: rawTitle,
            processName: String(foreground?.processName || '').trim()
        };
    }

    _composeQuery(gameName, query, mainQuest) {
        const parts = [];
        const game = String(gameName || '').trim();
        const quest = String(mainQuest || '').trim();
        const q = String(query || '').trim();

        if (game) parts.push(game);
        if (quest) parts.push(`主线任务：${quest}`);
        if (q) parts.push(q);

        return parts.join(' ');
    }

    _normalizeAnswer(answer) {
        if (!answer) return '';
        if (typeof answer === 'string') return answer.trim();
        if (typeof answer === 'object') {
            if (typeof answer.content === 'string') return answer.content.trim();
            try { return JSON.stringify(answer); } catch { return String(answer); }
        }
        return String(answer).trim();
    }

    _looksLikeEngineError(text) {
        if (!text || typeof text !== 'string') return false;
        const head = text.substring(0, 200);
        return this._engineMeta().errorPattern.test(head);
    }

    _writeSummary(log) {
        try {
            const { logToTerminal } = require('../../../js/api-utils.js');
            logToTerminal('info', `[洛基之影] 执行摘要:\n${log.getSummary()}`);
        } catch {
            console.log(log.getSummary());
        }
    }

    _buildFailureFallback(gameName, query, reason) {
        const meta = this._engineMeta();
        const ctxSummary = this._sessionCtx?.getSummary?.() || '暂无有效游戏状态记录';
        return [
            '【洛基之影 · 未检索到可靠资料】',
            'status: no_reliable_info',
            `game_name: ${gameName}`,
            `query: ${query}`,
            `reason: ${meta.label.toLowerCase()}_unavailable | ${String(reason || '').slice(0, 200)}`,
            '',
            '当前游戏上下文：',
            ctxSummary,
            '',
            '给主对话模型的行动建议：',
            '1. 不要硬讲剧情答案，先基于当前截图和用户刚才的话继续陪聊',
            '2. 可以评论画面里的角色表情、场景氛围、战斗压力、演出张力',
            '3. 围绕用户刚提到的台词做低风险感受型回应',
            '4. 自然追问一句当前是在剧情对话、战斗还是跑图，不要连续盘问',
            `5. 如果你直接掌握 ${meta.toolName} 工具，可以自行调用一次重试`,
            '',
            '安全陪聊方向：画面吐槽 / 战斗反馈 / 情绪共鸣 / 当前角色印象 / 任务进度确认'
        ].join('\n');
    }

    _loadConfig() {
        const defaults = {
            session_context_ttl_ms: 60000,
            enable_cross_session_memory: true,
            persist_dir: path.join(__dirname, '.runtime'),
            search_engine: 'kimi',
            kimi_silent: true,
            kimi_deep_research: false,
            glm_deep_research: false,
            game_aliases: []
        };

        const _v = (val, def) => (val !== undefined && val !== null && val !== '') ? val : def;
        const _vBool = (val, def) => {
            if (val === true || val === false) return val;
            if (val === 'true') return true;
            if (val === 'false') return false;
            return def;
        };
        const _vEngine = (val) => {
            const s = String(val || '').toLowerCase().trim();
            return (s === 'glm' || s === 'kimi') ? s : defaults.search_engine;
        };
        const _vJson = (val, def) => {
            if (val === undefined || val === null || val === '') return def;
            if (typeof val === 'object') return val;
            try {
                return JSON.parse(String(val));
            } catch {
                return def;
            }
        };
        const _normalizeAliases = (val) => {
            const parsed = _vJson(val, defaults.game_aliases);
            if (!Array.isArray(parsed)) return defaults.game_aliases;
            return parsed
                .map(entry => ({
                    gameName: String(entry?.gameName || '').trim(),
                    processNames: Array.isArray(entry?.processNames) ? entry.processNames.map(v => String(v || '').trim()).filter(Boolean) : [],
                    windowTitles: Array.isArray(entry?.windowTitles) ? entry.windowTitles.map(v => String(v || '').trim()).filter(Boolean) : []
                }))
                .filter(entry => entry.gameName && (entry.processNames.length || entry.windowTitles.length));
        };

        try {
            const rawCfg = this._pluginConfig || {};
            this._config = {
                session_context_ttl_ms: parseInt(_v(rawCfg.session_context_ttl_ms, defaults.session_context_ttl_ms), 10) || defaults.session_context_ttl_ms,
                enable_cross_session_memory: _vBool(rawCfg.enable_cross_session_memory, defaults.enable_cross_session_memory),
                persist_dir: _v(rawCfg.persist_dir, defaults.persist_dir),
                search_engine: _vEngine(rawCfg.search_engine),
                kimi_silent: _vBool(rawCfg.kimi_silent, defaults.kimi_silent),
                kimi_deep_research: _vBool(rawCfg.kimi_deep_research, defaults.kimi_deep_research),
                glm_deep_research: _vBool(rawCfg.glm_deep_research, defaults.glm_deep_research),
                game_aliases: _normalizeAliases(rawCfg.game_aliases)
            };
        } catch (err) {
            this.context.log('warn', `洛基之影 配置加载失败，使用默认值: ${err.message}`);
            this._config = { ...defaults };
        }
    }
}

const TRACK_TOOL = {
    type: 'function',
    function: {
        name: 'loki_shadow_track',
        description: '【洛基之影 · 游戏状态追踪】仅在用户正在玩某款游戏、且能确定该作品正式名时调用；每个顶层用户输入或主动触发中，同一截图/同一状态最多成功调用一次。用户明确说出“我在玩/我玩这个 <游戏名>”时，即使没有截图，也要以 source=user_confirmed 轻量同步一次，且只传 game_name 与 source。若本轮已经收到成功结果，不要重复调用；只有取得新截图且状态确实变化时才再次更新。game_name 必须是游戏名，禁止用哔哩哔哩/Chrome 等应用或平台名。纯看视频/直播/浏览器且无游戏 UI 时不要调用。轻量、不触发搜索。main_quest 只接受 screenshot 与 user_confirmed。',
        parameters: {
            type: 'object',
            properties: {
                game_name: {
                    type: 'string',
                    description: '正在玩的游戏作品正式名称（如 原神、鸣潮）；禁止客户端/网站名（如 哔哩哔哩、Chrome）'
                },
                source: {
                    type: 'string',
                    enum: ['screenshot', 'conversation', 'user_confirmed'],
                    description: '信息来源。screenshot=从截图UI中提取的信息；conversation=从对话推测的信息；user_confirmed=用户明确告知的信息。main_quest只接受screenshot和user_confirmed来源。'
                },
                main_quest: {
                    type: 'string',
                    description: '主线任务名称。仅在截图任务栏中看到任务名（source=screenshot）或用户明确告知切换任务（source=user_confirmed）时才填写。不要从对话剧情讨论中推测！'
                },
                current_step: {
                    type: 'string',
                    description: '当前子步骤/正在做的具体事情（如"与椿对话"、"寻找线索"）。可以从对话或截图中推测，可频繁更新。'
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
                    description: '当前章节（如"第三章 永夜降临"、"序章"、"间章·心相之径"等）。截图中能看到章节标题/分组标签时必须填写，不能省略；纯对话推测无截图时可不填。'
                },
                spoiler_comfort: {
                    type: 'string',
                    enum: ['strict', 'mild', 'full'],
                    description: '剧透/讲解深度偏好。strict=强防剧透（默认）；mild=可适度暗示方向；full=可较完整流程与剧情要点。用户口头说「别剧透」「随便剧透」时应更新。'
                },
                companion_note: {
                    type: 'string',
                    description: '玩家陪玩偏好短备注，如「想自己探索」「只要打法不要剧情」「只聊角色」等，供主对话与联网检索参考。'
                }
            },
            required: ['game_name', 'source']
        }
    }
};

const QUERY_TOOL = {
    type: 'function',
    function: {
        name: 'loki_shadow_query',
        description: '【洛基之影 · 游戏陪玩】仅在你对当前游戏有明确、具体的问题时调用，例如想知道任务下一步、Boss机制、角色背景、某句台词含义、某段剧情信息。先由主对话模型想清楚自己具体要问什么，再把这个具体问题交给洛基之影检索。不是每轮对话必调；没有明确疑问时继续自然陪聊即可。内部根据 search_engine 配置一站式委托给 Kimi 或 GLM 联网搜索（来源整合好），并会自动带上当前已记录的主线任务名作为检索上下文（若存在）。你应当对返回的信息按防剧透偏好做处理后再告诉用户。',
        parameters: {
            type: 'object',
            properties: {
                game_name: {
                    type: 'string',
                    description: '游戏作品正式名（可选）；勿填视频网站/浏览器名。省略时由最近60秒内窗口/进程自动识别'
                },
                query: {
                    type: 'string',
                    description: '必须填写主对话模型此刻真正想弄清楚的具体问题。可以是完整问句，也可以是高度明确的检索型问题。推荐格式："这个任务下一步怎么触发？"、"这个Boss二阶段怎么打？"、"刚才这句台词想表达什么？"、"XX角色和YY是什么关系？"。禁止空泛表达，如"搜一下剧情"、"看看发生了什么"、"随便找点信息"；也不要直接塞NPC原话碎片，除非同时说明你想弄清楚什么。'
                }
            },
            required: ['query']
        }
    }
};

module.exports = LokiShadowPlugin;
