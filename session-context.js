/**
 * 洛基之影 - 游戏会话记忆（槽位制）v2.5
 * 持续追踪游戏状态，跨多次调用积累上下文，增强搜索和答案生成质量。
 *
 * v2.5 改动（修复 v2.4 中"声明但未实施"的 TTL 拆分）：
 * - 真正实现「持久槽位 vs 易变槽位」TTL 拆分：
 *   · main_quest / current_chapter：不受 contextTtlMs 影响，只在
 *     ① track 显式写入新值 ② 章节级联清除 ③ 切游戏 reset() 时变更。
 *   · current_step / current_boss / current_area：写入时打 lastVolatileUpdateTime
 *     时间戳；超过 contextTtlMs 后读取会被屏蔽（视为 null），但内存中仍保留，
 *     新一轮 update 写入时直接覆盖。
 * - 删除 update() 头部的 `if (this.isExpired()) { this.reset(); }`：
 *   旧逻辑会因为 60 秒未调用就把整库清空，连带把 1 小时起步的主线任务一起冲掉。
 * - 删除全局 isExpired()，所有读取方法改用 isVolatileExpired() 做"易变槽位"屏蔽。
 * - toSnapshot / hydrateFromSnapshot 增加 lastVolatileUpdateTime 字段（向后兼容旧文件）。
 *
 * v2.3 改动：
 * - 移除 injectedPlot 槽位与剧情被动注入，所有剧情信息仅保留在当轮 tool result 中
 *
 * v2.1 改动：
 * - 拆分 current_quest 为 main_quest（主线任务）+ current_step（当前子步骤）
 * - 增加 source 门控：main_quest 只接受 screenshot/user_confirmed 来源
 * - 变更回显机制：主线任务变更时返回警告信息
 * - 兼容旧字段 current_quest：根据 source 自动映射到 main_quest 或 current_step
 */

const SLOT_KEYS = ['main_quest', 'current_step', 'current_boss', 'current_area', 'current_chapter'];
const PERSISTENT_SLOT_KEYS = ['main_quest', 'current_chapter'];
const VOLATILE_SLOT_KEYS = ['current_step', 'current_boss', 'current_area'];

/** 陪玩偏好（不触发主线门控，可来自对话） */
const PREF_KEYS = ['spoiler_comfort', 'companion_note'];

const DEFAULT_CONTEXT_TTL_MS = 60000;

/** spoiler_comfort: strict=强防剧透 | mild=可暗示 | full=可直说攻略细节 */
const VALID_SPOILER = new Set(['strict', 'mild', 'full']);

/** 允许更新 main_quest 的可信来源 */
const TRUSTED_SOURCES_FOR_MAIN_QUEST = ['screenshot', 'user_confirmed'];

/**
 * 层级联动清除规则：上级槽位变更时，自动清除其下级槽位。
 * chapter 变    → 清 main_quest、current_step、boss
 * main_quest 变 → 清 current_step、boss
 * current_step 变 → 不联动（子步骤变化不影响其他槽位）
 * area 不联动（换地图不一定换任务/boss）
 */
const CASCADE_RULES = {
    current_chapter: ['main_quest', 'current_step', 'current_boss'],
    main_quest:      ['current_step', 'current_boss'],
};

class GameSessionContext {
    /**
     * @param {number} maxHistory - history 队列最大长度
     * @param {number} contextTtlMs - 易变槽位的 TTL（仅 step/boss/area，main_quest/chapter 不受其影响）
     */
    constructor(maxHistory = 5, contextTtlMs = DEFAULT_CONTEXT_TTL_MS) {
        this.currentGame = null;
        this.slots = {
            main_quest: null,
            current_step: null,
            current_boss: null,
            current_area: null,
            current_chapter: null,
        };
        this.prefs = {
            spoiler_comfort: 'strict',
            companion_note: null
        };
        /** 记录 main_quest 的来源，用于后续判断 */
        this._mainQuestSource = null;
        this.history = [];
        this.maxHistory = maxHistory;
        this.contextTtlMs = contextTtlMs;
        /** 任意槽位最近一次更新时间，用于排序与跨会话恢复判断 */
        this.lastUpdateTime = null;
        /** 易变槽位（step/boss/area）最近一次更新时间，用于 isVolatileExpired() */
        this.lastVolatileUpdateTime = null;
    }

    /**
     * 更新游戏状态。游戏切换时自动 reset。
     * 注意：TTL 已不再触发整库清零；persistent 槽位永远保留，volatile 槽位由 isVolatileExpired() 控制可见性。
     * @param {string} gameName
     * @param {object} context - { main_quest, current_step, current_quest(兼容), current_boss, current_area, current_chapter, spoiler_comfort, companion_note }
     * @param {string} source - 信息来源: 'screenshot' | 'conversation' | 'user_confirmed'
     * @returns {{ warnings: string[] }} 返回变更警告信息
     */
    update(gameName, context, source = 'conversation') {
        const warnings = [];

        if (!context || typeof context !== 'object') return { warnings };

        context = Object.assign({}, context);

        if (gameName && this.currentGame && gameName !== this.currentGame) {
            this.reset();
        }
        if (gameName) {
            this.currentGame = gameName;
        }

        // ---- 兼容旧字段：AI 可能仍传入 current_quest ----
        if (context.current_quest && typeof context.current_quest === 'string' && context.current_quest.trim()) {
            if (!context.main_quest && !context.current_step) {
                const isTrusted = TRUSTED_SOURCES_FOR_MAIN_QUEST.includes(source);
                if (isTrusted) {
                    context.main_quest = context.current_quest;
                } else {
                    context.current_step = context.current_quest;
                }
            }
            delete context.current_quest;
        }

        // ---- 门控：main_quest 只接受可信来源 ----
        if (context.main_quest && typeof context.main_quest === 'string' && context.main_quest.trim()) {
            const isTrustedSource = TRUSTED_SOURCES_FOR_MAIN_QUEST.includes(source);

            if (!isTrustedSource) {
                const attemptedQuest = context.main_quest.trim();
                if (this.slots.main_quest && this.slots.main_quest !== attemptedQuest) {
                    warnings.push(
                        `⚠️ 主线任务更新被拦截：来源为"${source}"（对话推测），不允许覆盖主线任务。` +
                        `当前主线任务保持为「${this.slots.main_quest}」。` +
                        `如果主线任务确实变了，请从截图任务栏确认（source="screenshot"），或等用户明确告知（source="user_confirmed"）。`
                    );
                } else if (!this.slots.main_quest) {
                    warnings.push(
                        `ℹ️ 检测到可能的主线任务「${attemptedQuest}」（来源：对话推测）。` +
                        `需要从截图任务栏确认后才会记录为主线任务。暂不记录。`
                    );
                }
                delete context.main_quest;
            }
        }

        // ---- 更新各槽位 ----
        let volatileTouched = false;
        for (const key of SLOT_KEYS) {
            const newVal = context[key];
            if (newVal && typeof newVal === 'string' && newVal.trim()) {
                const trimmed = newVal.trim();
                const changed = this.slots[key] && this.slots[key] !== trimmed;
                if (changed) {
                    if (key === 'main_quest') {
                        warnings.push(
                            `📋 主线任务变更：「${this.slots[key]}」→「${trimmed}」（来源: ${source}）`
                        );
                        this._mainQuestSource = source;
                    }
                    this._pushHistory(key, this.slots[key]);
                    const cascadeTargets = CASCADE_RULES[key];
                    if (cascadeTargets) {
                        for (const target of cascadeTargets) {
                            if (this.slots[target]) {
                                this._pushHistory(target, this.slots[target]);
                                this.slots[target] = null;
                            }
                        }
                    }
                } else if (!this.slots[key] && key === 'main_quest') {
                    this._mainQuestSource = source;
                }
                this.slots[key] = trimmed;

                if (VOLATILE_SLOT_KEYS.includes(key)) {
                    volatileTouched = true;
                }
            }
        }

        // ---- 陪玩偏好（任意来源可更新）----
        for (const pk of PREF_KEYS) {
            const pv = context[pk];
            if (pk === 'spoiler_comfort' && typeof pv === 'string' && pv.trim()) {
                const v = pv.trim().toLowerCase();
                if (VALID_SPOILER.has(v)) this.prefs.spoiler_comfort = v;
            }
            if (pk === 'companion_note' && typeof pv === 'string' && pv.trim()) {
                const note = pv.trim();
                this.prefs.companion_note = note.length > 500 ? note.slice(0, 500) : note;
            }
        }

        const now = Date.now();
        this.lastUpdateTime = now;
        if (volatileTouched) {
            this.lastVolatileUpdateTime = now;
        }
        return { warnings };
    }

    /**
     * 获取搜索增强关键词。当 query 质量差时用槽位信息替代。
     * 按优先级返回：main_quest > current_step > current_boss > current_area > current_chapter
     * 易变槽位过期后会被跳过，但 main_quest / current_chapter 始终参与候选。
     * @returns {{ keyword: string|null, source: string|null, allSlots: object }}
     */
    getSearchEnhancement() {
        const allSlots = this._getActiveSlots();
        const priority = [
            { key: 'main_quest', suffix: '攻略' },
            { key: 'current_step', suffix: '攻略' },
            { key: 'current_boss', suffix: '打法攻略' },
            { key: 'current_area', suffix: '攻略' },
            { key: 'current_chapter', suffix: '流程攻略' },
        ];

        for (const { key, suffix } of priority) {
            if (allSlots[key]) {
                return {
                    keyword: `${allSlots[key]} ${suffix}`,
                    source: key,
                    allSlots
                };
            }
        }

        return { keyword: null, source: null, allSlots };
    }

    /**
     * 生成上下文摘要文本，供 Sub-Agent / 失败回退参考。
     * 持久槽位（main_quest / current_chapter）始终展示；易变槽位仅在未过期时展示。
     * @returns {string}
     */
    getSummary() {
        const active = this._getActiveSlots();
        const parts = [];

        if (this.currentGame) {
            parts.push(`当前游戏: ${this.currentGame}`);
        }

        const slotLabels = {
            main_quest: '主线任务',
            current_step: '当前步骤',
            current_boss: '当前Boss',
            current_area: '当前区域',
            current_chapter: '当前章节'
        };

        for (const [key, label] of Object.entries(slotLabels)) {
            if (active[key]) {
                parts.push(`${label}: ${active[key]}`);
            }
        }

        const spoilLabel = { strict: '强防剧透', mild: '可适度暗示', full: '可详细攻略' };
        parts.push(`剧透偏好: ${spoilLabel[this.prefs.spoiler_comfort] || this.prefs.spoiler_comfort}`);
        if (this.prefs.companion_note) {
            parts.push(`玩家备注: ${this.prefs.companion_note}`);
        }

        if (this.history.length > 0) {
            const historyStr = this.history
                .map(h => `${slotLabels[h.key] || h.key}: ${h.value}`)
                .join(', ');
            parts.push(`近期历史: ${historyStr}`);
        }

        return parts.length > 0 ? parts.join('\n') : '';
    }

    /**
     * 返回当前状态的简短描述（用于 track 工具的返回值）
     * 持久槽位永远展示，易变槽位仅在未过期时展示。
     */
    getStatusText() {
        const active = this._getActiveSlots();
        const keys = Object.keys(active);
        if (keys.length === 0 && (!this.prefs.spoiler_comfort || this.prefs.spoiler_comfort === 'strict')) {
            return '暂无游戏状态记录';
        }

        const parts = [];
        if (active.main_quest) parts.push(`主线任务:${active.main_quest}`);
        if (active.current_step) parts.push(`当前步骤:${active.current_step}`);
        if (active.current_boss) parts.push(`Boss:${active.current_boss}`);
        if (active.current_area) parts.push(`区域:${active.current_area}`);
        if (active.current_chapter) parts.push(`章节:${active.current_chapter}`);
        if (this.prefs.spoiler_comfort && this.prefs.spoiler_comfort !== 'strict') {
            parts.push(`剧透:${this.prefs.spoiler_comfort}`);
        }

        return parts.length > 0 ? parts.join(' | ') : '暂无游戏状态记录';
    }

    /**
     * 返回当前检索作用域，供攻略筛选/剧情注入判断使用。
     * mainQuest / currentChapter 永远透出（不受 TTL 影响）；
     * currentStep / currentBoss / currentArea 仅在 !isVolatileExpired() 时透出。
     */
    getCurrentScope() {
        const volatileExpired = this.isVolatileExpired();
        return {
            game: this.currentGame,
            mainQuest: this.slots.main_quest || null,
            currentStep: volatileExpired ? null : (this.slots.current_step || null),
            currentBoss: volatileExpired ? null : (this.slots.current_boss || null),
            currentArea: volatileExpired ? null : (this.slots.current_area || null),
            currentChapter: this.slots.current_chapter || null
        };
    }

    /**
     * 供持久化：纯数据快照
     */
    toSnapshot() {
        return {
            currentGame: this.currentGame,
            slots: { ...this.slots },
            prefs: { ...this.prefs },
            _mainQuestSource: this._mainQuestSource,
            lastUpdateTime: this.lastUpdateTime,
            lastVolatileUpdateTime: this.lastVolatileUpdateTime,
            history: this.history.slice(-this.maxHistory)
        };
    }

    /**
     * 从磁盘恢复（不覆盖本次 update 即将写入的字段：由调用方先 hydrate 再 update）
     * 兼容缺失 lastVolatileUpdateTime 的旧快照（当作"易变槽位早已过期"处理）。
     */
    hydrateFromSnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return;

        if (typeof snapshot.currentGame === 'string' && snapshot.currentGame.trim()) {
            this.currentGame = snapshot.currentGame.trim();
        }

        if (snapshot.slots && typeof snapshot.slots === 'object') {
            for (const key of SLOT_KEYS) {
                if (typeof snapshot.slots[key] === 'string' && snapshot.slots[key].trim()) {
                    this.slots[key] = snapshot.slots[key].trim();
                }
            }
        }
        if (snapshot.prefs && typeof snapshot.prefs === 'object') {
            if (VALID_SPOILER.has(snapshot.prefs.spoiler_comfort)) {
                this.prefs.spoiler_comfort = snapshot.prefs.spoiler_comfort;
            }
            if (typeof snapshot.prefs.companion_note === 'string' && snapshot.prefs.companion_note.trim()) {
                const n = snapshot.prefs.companion_note.trim();
                this.prefs.companion_note = n.length > 500 ? n.slice(0, 500) : n;
            }
        }
        if (typeof snapshot._mainQuestSource === 'string') {
            this._mainQuestSource = snapshot._mainQuestSource;
        }
        if (Array.isArray(snapshot.history)) {
            this.history = snapshot.history.slice(-this.maxHistory);
        }
        if (typeof snapshot.lastUpdateTime === 'number') {
            this.lastUpdateTime = snapshot.lastUpdateTime;
        }
        if (typeof snapshot.lastVolatileUpdateTime === 'number') {
            this.lastVolatileUpdateTime = snapshot.lastVolatileUpdateTime;
        } else if (typeof snapshot.lastUpdateTime === 'number') {
            // 兼容旧快照（v2.4 及更早没有 lastVolatileUpdateTime 字段）：
            // 若快照中存在任何 volatile 槽位值，把 lastUpdateTime 兜底当作 volatile 时间戳，
            // 这样跨会话恢复时 step/boss/area 会按 TTL 正常过期，不会被错误地视为"刚刚才更新过"。
            const hasVolatileValue = snapshot.slots && VOLATILE_SLOT_KEYS.some(k =>
                typeof snapshot.slots[k] === 'string' && snapshot.slots[k].trim()
            );
            if (hasVolatileValue) {
                this.lastVolatileUpdateTime = snapshot.lastUpdateTime;
            }
        }
    }

    getAnswerStyleHint() {
        const n = this.prefs.companion_note;
        const base = {
            strict: '回答侧重操作提示与卡点排查，避免直接复述完整剧情与结局；未确认用户进度前不剧透后续情节。',
            mild: '可适度用暗示帮助用户理解方向，仍避免一次性剧透关键转折与结局。',
            full: '在忠于来源的前提下可给出较完整的流程与剧情要点；若来源未涵盖仍不可编造。'
        };
        const spoil = base[this.prefs.spoiler_comfort] || base.strict;
        const note = n ? `玩家备注（务必尊重）：${n}` : '';
        return [spoil, note].filter(Boolean).join('\n');
    }

    /**
     * 仅判断"易变槽位"是否已过 contextTtlMs。
     * 当 lastVolatileUpdateTime 为 null（从未写入易变槽位）时，返回 false：
     * 此时 step/boss/area 本就为 null，过不过期都不会有读取问题。
     */
    isVolatileExpired() {
        return !!this.lastVolatileUpdateTime
            && (Date.now() - this.lastVolatileUpdateTime > this.contextTtlMs);
    }

    reset() {
        for (const key of SLOT_KEYS) {
            if (this.slots[key]) {
                this._pushHistory(key, this.slots[key]);
            }
        }
        this.currentGame = null;
        this.slots = {
            main_quest: null,
            current_step: null,
            current_boss: null,
            current_area: null,
            current_chapter: null,
        };
        this.prefs = { spoiler_comfort: 'strict', companion_note: null };
        this._mainQuestSource = null;
        this.lastUpdateTime = null;
        this.lastVolatileUpdateTime = null;
    }

    _pushHistory(key, value) {
        if (this.history.length > 0) {
            const last = this.history[this.history.length - 1];
            if (last.key === key && last.value === value) return;
        }
        this.history.push({ key, value, time: Date.now() });
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }
    }

    /**
     * 返回当前"对外可见"的槽位集合：
     * - 持久槽位（main_quest / current_chapter）若有值则始终包含
     * - 易变槽位（step/boss/area）仅在 !isVolatileExpired() 且有值时包含
     */
    _getActiveSlots() {
        const volatileExpired = this.isVolatileExpired();
        const active = {};
        for (const key of PERSISTENT_SLOT_KEYS) {
            if (this.slots[key]) active[key] = this.slots[key];
        }
        if (!volatileExpired) {
            for (const key of VOLATILE_SLOT_KEYS) {
                if (this.slots[key]) active[key] = this.slots[key];
            }
        }
        return active;
    }
}

module.exports = { GameSessionContext };
