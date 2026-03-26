/**
 * 洛基之影 - 下级智能体（主 + 后备双Agent）
 * 主Agent: DeepSeek  |  后备Agent: Qwen
 * 主Agent 失败后自动切换后备Agent
 */

const axios = require('axios');

class SubAgent {
    /**
     * @param {object} config - sub_agent 配置段
     * @param {object} [fallbackConfig] - fallback_agent 配置段
     */
    constructor(config, fallbackConfig = null) {
        this.primary = {
            apiUrl: config.api_url || 'https://api.siliconflow.cn/v1',
            apiKey: config.api_key,
            model: config.model || 'deepseek-ai/DeepSeek-V3.2',
            temperature: config.temperature || 0.3,
            maxTokens: config.max_tokens || 20000,
            name: 'DeepSeek'
        };

        this.fallback = null;
        if (fallbackConfig && fallbackConfig.api_key) {
            this.fallback = {
                apiUrl: fallbackConfig.api_url || 'https://api.siliconflow.cn/v1',
                apiKey: fallbackConfig.api_key,
                model: fallbackConfig.model || 'Qwen/Qwen3.5-397B-A17B',
                temperature: fallbackConfig.temperature || 0.3,
                maxTokens: fallbackConfig.max_tokens || 20000,
                name: 'Qwen'
            };
        }

        this._failCount = 0;
        this._useFallback = false;
    }

    /**
     * 调用 LLM（带自动主/后备切换 + 重试）
     */
    async _call(systemPrompt, userMessage, retries = 2) {
        if (this._useFallback && this.fallback && this._recoveryCounter === undefined) {
            this._recoveryCounter = 0;
        }
        if (this._useFallback && this.fallback) {
            this._recoveryCounter = (this._recoveryCounter || 0) + 1;
        }

        const shouldProbe = this._useFallback && this.fallback && (this._recoveryCounter % 5 === 0);

        const agents = shouldProbe
            ? [this.primary, this.fallback]
            : this._useFallback && this.fallback
                ? [this.fallback, this.primary]
                : this.fallback
                    ? [this.primary, this.fallback]
                    : [this.primary];

        let lastError;
        for (const agent of agents) {
            try {
                const result = await this._callAgent(agent, systemPrompt, userMessage, retries);

                if (agent === this.primary) {
                    this._failCount = Math.max(0, this._failCount - 1);
                    if (this._failCount === 0) {
                        this._useFallback = false;
                        this._recoveryCounter = 0;
                    }
                    console.log(`[洛基之影] 主Agent ${agent.name} 成功响应 (failCount→${this._failCount})`);
                } else {
                    console.log(`[洛基之影] 后备Agent ${agent.name} 成功响应`);
                }

                return result;
            } catch (err) {
                lastError = err;
                if (agent === this.primary) {
                    this._failCount++;
                    if (this._failCount >= 2) this._useFallback = true;
                    console.log(`[洛基之影] 主Agent ${agent.name} 失败(连续${this._failCount}次), 尝试后备...`);
                } else {
                    console.log(`[洛基之影] 后备Agent ${agent.name} 也失败: ${err.message}`);
                }
            }
        }
        throw lastError;
    }

    /**
     * 调用单个 Agent
     */
    async _callAgent(agent, systemPrompt, userMessage, retries) {
        if (retries < 0) retries = 0;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const resp = await axios.post(`${agent.apiUrl}/chat/completions`, {
                    model: agent.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userMessage }
                    ],
                    temperature: agent.temperature,
                    max_tokens: agent.maxTokens
                }, {
                    headers: {
                        'Authorization': `Bearer ${agent.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 120000
                });

                const content = resp.data.choices[0].message.content;
                if (!content) throw new Error('LLM 返回空内容');
                return content;
            } catch (err) {
                if (attempt === retries) {
                    throw new Error(`${agent.name} 调用失败 (已重试${retries}次): ${err.message}`);
                }
                await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            }
        }
    }

    /**
     * 获取当前使用的 Agent 名称（用于日志）
     */
    getActiveAgentName() {
        if (this._useFallback && this.fallback) return this.fallback.name;
        return this.primary.name;
    }

    /**
     * 从文件列表中选择最相关的文件
     * @returns {Promise<number>} 文件序号 (1-based)，0 表示未找到
     */
    async selectRelevantFile(gameName, query, fileList) {
        const fileListStr = fileList.map((f, i) => `${i + 1}. ${f.relativePath || f.fileName}`).join('\n');

        const system = `你是一个游戏信息检索助手。根据游戏名称和问题，从文件列表中选择最相关的文件。
规则：
1. 分析游戏名称和问题，理解用户需要什么
2. 优先选择文件名同时包含游戏名和关键词的文件
3. 只返回文件的序号（纯数字），不返回其他内容
4. 如果没有相关文件，返回 "0"`;

        const user = `游戏名称：${gameName}\n问题：${query}\n\n文件列表：\n${fileListStr}\n\n请返回最相关文件的序号：`;

        const response = await this._call(system, user);
        const num = parseInt(response.trim());
        return isNaN(num) ? 0 : num;
    }

    /**
     * 分析攻略内容是否能回答用户的问题
     * @returns {Promise<{canAnswer: boolean, confidence: string, reason: string}>}
     */
    async analyzeContent(query, content, fileName) {
        const system = `你是一个游戏攻略分析专家。判断给定的攻略内容是否能回答用户的问题。
返回JSON格式：{"canAnswer": true/false, "confidence": "high/medium/low", "reason": "判断理由"}
只返回JSON，不要其他内容。`;

        const user = `用户问题：${query}\n\n攻略文件：${fileName}\n内容摘要（前3000字）：\n${content.substring(0, 3000)}`;

        const response = await this._call(system, user);
        try {
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) return JSON.parse(jsonMatch[0]);
        } catch {}
        return { canAnswer: false, confidence: 'low', reason: '解析失败' };
    }

    /**
     * 从攻略内容生成精准答案
     */
    async generateAnswer(query, content, fileName) {
        const system = `你是一个游戏信息专家。根据用户的问题，从攻略文档中提取最相关、最实用的信息，生成精准详细的回答。

要求：
1. 直接回答问题，不要废话
2. 提取关键要点（打法技巧、注意事项、推荐配置、剧情内容等）
3. 如有具体步骤，按顺序列出
4. 内容要详细具体，进行完整转述
5. 如果内容与问题无关，说明"未找到相关信息"`;

        const user = `用户问题：${query}\n\n攻略文档（来源：${fileName}）：\n${content}`;

        return await this._call(system, user);
    }

    /**
     * 为新攻略文件生成标签
     * @returns {Promise<string[]>}
     */
    async generateTags(gameName, query, content) {
        const system = `你是一个游戏攻略标签生成专家。为攻略内容生成2-5个标签，用于文件名和快速检索。
要求：
1. 第一个标签必须是用户问题中的任务名/章节名/Boss名等专有名词（原样保留，不要缩写或概括）
2. 后续标签概括攻略的核心内容（如：Boss战、剧情、任务、角色、装备等），每个2-6个字
3. 返回JSON数组格式：["任务原名", "标签2", "标签3"]
4. 不要包含游戏名（游戏名会单独标注）
只返回JSON数组，不要其他内容。

示例：
问题："曙光停摆于荒地之上 主线攻略" → ["曙光停摆于荒地之上", "主线攻略", "任务流程"]
问题："无冠者 打法攻略" → ["无冠者", "Boss打法", "战斗技巧"]`;

        const user = `游戏：${gameName}\n问题：${query}\n\n内容摘要：\n${content.substring(0, 2000)}`;

        const response = await this._call(system, user);
        try {
            const jsonMatch = response.match(/\[[\s\S]*\]/);
            if (jsonMatch) return JSON.parse(jsonMatch[0]);
        } catch {}
        const fallbackTags = query.split(/[\s,，。]+/).filter(w => w.length >= 2).slice(0, 3);
        return fallbackTags.length > 0 ? fallbackTags : ['攻略'];
    }

    /**
     * 从B站搜索结果中选择最匹配的视频
     * @returns {Promise<number>} 视频序号 (1-based)，0 表示无合适视频
     */
    async selectBestVideo(query, searchResults) {
        const listStr = searchResults.map((v, i) =>
            `${i + 1}. 标题: ${v.title} | UP主: ${v.author} | 播放: ${v.play} | 时长: ${v.duration}`
        ).join('\n');

        const system = `你是一个视频筛选助手。从B站视频搜索结果中选择最适合回答用户问题的视频。
选择规则（按优先级，必须严格遵守顺序）：
1.【最重要】标题相关性：视频必须讲的是用户问的那个作品/游戏/角色。标题中只是碰巧包含部分关键词但实际是另一个作品的，必须排除。
  例如：用户问"贵族转生"，标题是"暗杀者转生为异世界贵族"→ 这是不同作品，必须排除。
2. 内容类型：剧情解读/解析 > 攻略教程/流程指引 > 单段剧情录屏 > 完整流程录屏 > 评测
3. 时长偏好：优先10-30分钟，其次30-60分钟。超过60分钟的尽量避免
4. 如果所有视频都超过60分钟，选其中最短的
5. 排除：直播录像、纯娱乐、无关内容、标题含"全流程合集"的超长视频
如果没有标题相关的视频，返回 "0"，不要勉强选一个不相关的。
只返回视频序号（纯数字）。`;

        const user = `问题：${query}\n\n视频列表：\n${listStr}\n\n请返回最合适视频的序号：`;

        const response = await this._call(system, user);
        const num = parseInt(response.trim());
        return isNaN(num) ? 0 : num;
    }

    /**
     * 综合多个来源的内容，生成整合攻略
     * @param {string} gameName
     * @param {string} query
     * @param {object} sources - { gamersky, bilibili, taptap, nga, miyoushe } 各来源文本（可为null）
     */
    async combineAndSummarize(gameName, query, sources) {
        const sourceLabels = {
            local: '本地攻略库',
            gamersky: '游民星空',
            bilibili: 'B站视频',
            taptap: 'TapTap',
            nga: 'NGA论坛',
            miyoushe: '米游社'
        };

        const system = `你是一个游戏攻略整合专家。将来自不同来源的游戏信息进行综合整理。

要求：
1. 保留所有重要细节，不要遗漏
2. 按逻辑组织内容，去除重复部分
3. 标注信息来源
4. 内容要详细具体，将所有内容进行完整转述
5. 如有矛盾信息，同时保留并注明
6. 输出格式清晰，分段分点`;

        let user = `游戏：${gameName}\n问题：${query}\n\n`;
        let sourceIndex = 1;

        for (const [key, label] of Object.entries(sourceLabels)) {
            const text = sources[key];
            if (text) {
                user += `=== 来源${sourceIndex}：${label} ===\n${text.substring(0, 8000)}\n\n`;
                sourceIndex++;
            }
        }

        if (sourceIndex === 1) {
            throw new Error('没有任何来源内容可供整合');
        }

        user += '请综合整理以上信息：';
        return await this._call(system, user);
    }

    /**
     * 从多平台搜索结果中选择最佳攻略帖
     * @param {string} query
     * @param {Array<{title: string, source: string}>} candidates
     * @returns {Promise<number>} 序号 (1-based)
     */
    async selectBestGuide(query, candidates) {
        const listStr = candidates.map((c, i) =>
            `${i + 1}. [${c.source}] ${c.title}`
        ).join('\n');

        const system = `你是一个游戏攻略筛选助手。从多平台的攻略搜索结果中选择最适合回答用户问题的那篇。
优先选择：标题与问题高度匹配的、来自知名攻略作者的、内容类型匹配的
只返回序号（纯数字），如果都不合适返回 "0"`;

        const user = `问题：${query}\n\n候选列表：\n${listStr}\n\n请返回最合适的序号：`;

        const response = await this._call(system, user);
        const num = parseInt(response.trim());
        return isNaN(num) ? 0 : num;
    }
}

module.exports = { SubAgent };
