/**
 * 洛基之影 - 游戏会话记忆（槽位制）
 * 持续追踪游戏状态，跨多次调用积累上下文，增强搜索和答案生成质量。
 */

const SLOT_KEYS = ['current_quest', 'current_boss', 'current_area', 'current_chapter'];
const DEFAULT_CONTEXT_TTL_MS = 60000;

/**
 * 层级联动清除规则：上级槽位变更时，自动清除其下级槽位。
 * chapter 变 → 清 quest、boss
 * quest 变   → 清 boss
 * area 不联动（换地图不一定换任务/boss）
 */
const CASCADE_RULES = {
    current_chapter: ['current_quest', 'current_boss'],
    current_quest:   ['current_boss'],
};

class GameSessionContext {
    /**
     * @param {number} maxHistory - history 队列最大长度
     */
    constructor(maxHistory = 5, contextTtlMs = DEFAULT_CONTEXT_TTL_MS) {
        this.currentGame = null;
        this.slots = {
            current_quest: null,
            current_boss: null,
            current_area: null,
            current_chapter: null,
            characters: [],
        };
        this.history = [];
        this.maxHistory = maxHistory;
        this.contextTtlMs = contextTtlMs;
        this.lastUpdateTime = null;
    }

    /**
     * 更新游戏状态。游戏切换时自动 reset。
     * @param {string} gameName
     * @param {object} context - { current_quest, current_boss, current_area, current_chapter, characters }
     */
    update(gameName, context) {
        if (!context || typeof context !== 'object') return;

        if (this.isExpired()) {
            this.reset();
        }
        if (gameName && this.currentGame && gameName !== this.currentGame) {
            this.reset();
        }
        if (gameName) {
            this.currentGame = gameName;
        }

        for (const key of SLOT_KEYS) {
            const newVal = context[key];
            if (newVal && typeof newVal === 'string' && newVal.trim()) {
                const trimmed = newVal.trim();
                const changed = this.slots[key] && this.slots[key] !== trimmed;
                if (changed) {
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
                }
                this.slots[key] = trimmed;
            }
        }

        if (Array.isArray(context.characters) && context.characters.length > 0) {
            const newChars = context.characters
                .filter(c => typeof c === 'string' && c.trim())
                .map(c => c.trim());
            if (newChars.length > 0) {
                const merged = new Set([...this.slots.characters, ...newChars]);
                if (merged.size > 10) {
                    const arr = [...merged];
                    this.slots.characters = arr.slice(arr.length - 10);
                } else {
                    this.slots.characters = [...merged];
                }
            }
        }

        this.lastUpdateTime = Date.now();
    }

    /**
     * 获取搜索增强关键词。当 query 质量差时用槽位信息替代。
     * 按优先级返回：current_quest > current_boss > current_area > current_chapter
     * @returns {{ keyword: string|null, source: string|null, allSlots: object }}
     */
    getSearchEnhancement() {
        if (this.isExpired()) {
            return { keyword: null, source: null, allSlots: {} };
        }

        const priority = [
            { key: 'current_quest', suffix: '攻略' },
            { key: 'current_boss', suffix: '打法攻略' },
            { key: 'current_area', suffix: '攻略' },
            { key: 'current_chapter', suffix: '流程攻略' },
        ];

        for (const { key, suffix } of priority) {
            if (this.slots[key]) {
                return {
                    keyword: `${this.slots[key]} ${suffix}`,
                    source: key,
                    allSlots: this._getActiveSlots()
                };
            }
        }

        return { keyword: null, source: null, allSlots: this._getActiveSlots() };
    }

    /**
     * 生成上下文摘要文本，供 Sub-Agent 参考。
     * @returns {string}
     */
    getSummary() {
        if (this.isExpired()) return '';

        const parts = [];

        if (this.currentGame) {
            parts.push(`当前游戏: ${this.currentGame}`);
        }

        const slotLabels = {
            current_quest: '当前任务',
            current_boss: '当前Boss',
            current_area: '当前区域',
            current_chapter: '当前章节'
        };

        for (const [key, label] of Object.entries(slotLabels)) {
            if (this.slots[key]) {
                parts.push(`${label}: ${this.slots[key]}`);
            }
        }

        if (this.slots.characters.length > 0) {
            parts.push(`相关角色: ${this.slots.characters.join('、')}`);
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
     */
    getStatusText() {
        if (this.isExpired()) return '暂无有效游戏状态记录';

        const active = this._getActiveSlots();
        const keys = Object.keys(active);
        if (keys.length === 0 && this.slots.characters.length === 0) {
            return '暂无游戏状态记录';
        }

        const parts = [];
        if (active.current_quest) parts.push(`任务:${active.current_quest}`);
        if (active.current_boss) parts.push(`Boss:${active.current_boss}`);
        if (active.current_area) parts.push(`区域:${active.current_area}`);
        if (active.current_chapter) parts.push(`章节:${active.current_chapter}`);
        if (this.slots.characters.length > 0) parts.push(`角色:${this.slots.characters.join(',')}`);

        return parts.join(' | ');
    }

    isExpired() {
        return !!this.lastUpdateTime && (Date.now() - this.lastUpdateTime > this.contextTtlMs);
    }

    reset() {
        for (const key of SLOT_KEYS) {
            if (this.slots[key]) {
                this._pushHistory(key, this.slots[key]);
            }
        }
        this.currentGame = null;
        this.slots = {
            current_quest: null,
            current_boss: null,
            current_area: null,
            current_chapter: null,
            characters: [],
        };
        this.lastUpdateTime = null;
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

    _getActiveSlots() {
        if (this.isExpired()) return {};

        const active = {};
        for (const key of SLOT_KEYS) {
            if (this.slots[key]) active[key] = this.slots[key];
        }
        return active;
    }
}

module.exports = { GameSessionContext };
