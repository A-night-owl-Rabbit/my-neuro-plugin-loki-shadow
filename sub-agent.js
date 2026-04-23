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
     * 将主对话模型提出的具体问题改写为更适合检索的搜索意图。
     * 目标不是替代原问题，而是把“想知道什么”提炼成可用于攻略库/搜索源的关键词表达。
     * @returns {Promise<{searchQuery: string, intent: string, missingInfo: string|null, rationale: string}>}
     */
    async refineSearchIntent(gameName, query, scope = {}) {
        const scopeText = [
            scope.mainQuest ? `当前主线任务：${scope.mainQuest}` : null,
            scope.currentChapter ? `当前章节：${scope.currentChapter}` : null,
            scope.currentStep ? `当前步骤：${scope.currentStep}` : null,
            scope.currentBoss ? `当前Boss：${scope.currentBoss}` : null,
            scope.currentArea ? `当前区域：${scope.currentArea}` : null,
        ].filter(Boolean).join('\n') || '暂无明确进度信息';

        const system = `你是一个游戏检索意图改写助手。你的任务是理解主对话模型真正想知道的具体问题，并把它改写成更适合搜索攻略和资料的表达。

要求：
1. 保留原问题的核心意图，明确主对话模型到底想了解什么。
2. 输出 searchQuery 时要尽量具体、可搜索，可补入任务/Boss/章节/角色/地点/机制/台词含义等关键词。
3. 如果原问题已经足够具体，searchQuery 可以接近原文，但应更利于检索。
4. 如果原问题仍然过于空泛，missingInfo 要写出最关键的缺失项（如任务名、角色名、地图名、台词上下文）；但仍尽量给出一个可尝试的 searchQuery。
5. intent 用一句短语概括问题类型，例如：任务推进、Boss打法、剧情理解、角色背景、地图探索、台词含义、配装养成。
6. 返回 JSON：{"searchQuery":"...","intent":"...","missingInfo":null或"...","rationale":"..."}
7. 只返回 JSON，不要其他内容。`;

        const user = `游戏：${gameName}\n主对话模型的问题：${query}\n\n当前进度：\n${scopeText}`;

        const response = await this._call(system, user);
        try {
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                return {
                    searchQuery: typeof parsed.searchQuery === 'string' && parsed.searchQuery.trim()
                        ? parsed.searchQuery.trim()
                        : query.trim(),
                    intent: typeof parsed.intent === 'string' && parsed.intent.trim()
                        ? parsed.intent.trim()
                        : '问题检索',
                    missingInfo: typeof parsed.missingInfo === 'string' && parsed.missingInfo.trim()
                        ? parsed.missingInfo.trim()
                        : null,
                    rationale: typeof parsed.rationale === 'string' && parsed.rationale.trim()
                        ? parsed.rationale.trim()
                        : '使用原问题作为检索表达'
                };
            }
        } catch {}

        return {
            searchQuery: query.trim(),
            intent: '问题检索',
            missingInfo: null,
            rationale: '改写解析失败，退回原问题'
        };
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
     * 评估多个候选攻略的综合置信度，返回排序结果
     * @param {string} gameName
     * @param {string} query
     * @param {Array<{entry: object, score: number, chunkText: string}>} candidates
     * @param {object} scope
     */
    async scoreGuideCandidates(gameName, query, candidates, scope = {}) {
        const confidenceWeight = { high: 1.0, medium: 0.65, low: 0.3 };
        const scopeWeight = { direct: 1.0, background: 0.65, mismatch: 0.0 };

        const tasks = (candidates || []).map(async (candidate, index) => {
            const entry = candidate.entry || {};
            const fileName = entry.fileName || entry.title || `候选${index + 1}`;
            const preview = (candidate.chunkText || '').substring(0, 3000);

            const [analysis, scopeMatch] = await Promise.all([
                this.analyzeContent(query, preview || fileName, fileName),
                this.analyzeScopeMatch(query, preview || fileName, fileName, scope)
            ]);

            const confidenceScore = confidenceWeight[String(analysis?.confidence || 'low').toLowerCase()] ?? 0.3;
            const scopeScore = scopeWeight[String(scopeMatch?.scope || 'background').toLowerCase()] ?? 0.5;
            const vectorScore = Number(candidate.score) || 0;

            const combinedScore = (
                vectorScore * 0.6 +
                confidenceScore * 0.25 +
                scopeScore * 0.15
            );

            return {
                index: index + 1,
                fileName,
                relativePath: entry.relativePath || '',
                title: entry.title || fileName,
                vectorScore,
                confidence: analysis?.confidence || 'low',
                canAnswer: Boolean(analysis?.canAnswer),
                reason: analysis?.reason || '',
                scope: scopeMatch?.scope || 'background',
                scopeReason: scopeMatch?.reason || '',
                matchedChunk: preview,
                combinedScore,
                matchedHints: {
                    chapter: scopeMatch?.chapter_hint || null,
                    quest: scopeMatch?.quest_hint || null,
                }
            };
        });

        const results = await Promise.all(tasks);
        results.sort((a, b) => b.combinedScore - a.combinedScore);
        return results;
    }

    /**
     * 分析攻略内容是否能回答用户的问题
     * @returns {Promise<{canAnswer: boolean, confidence: string, reason: string}>}
     */
    async analyzeContent(query, content, fileName) {
        const system = `你是一个游戏攻略分析专家。判断给定的攻略内容与用户问题的相关程度。

重要判断原则：
1. 只要攻略内容与用户提到的游戏/角色/任务/章节属于同一主题，就应判定 canAnswer=true。
2. 不要求文档能"精确回答"用户的问题，只要包含相关的背景信息、角色信息、剧情片段、任务流程等，都算有用。
3. 用户的问题可能是从截图或口语对话中提取的碎片化内容，不要以"问题不够精确"为由否定文档的价值。
4. confidence 标准：
   - high: 文档直接覆盖了问题的核心内容
   - medium: 文档包含相关主题的信息，但不完全覆盖问题
   - low: 文档只是同一游戏但主题差距较大
5. 只有在文档完全是另一个游戏、完全不同的主题时，才返回 canAnswer=false。

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
     * 判断文档内容与当前游戏进度的作用域匹配度
     * @param {string} query
     * @param {string} content
     * @param {string} fileName
     * @param {{mainQuest?: string|null, currentChapter?: string|null, currentStep?: string|null, currentBoss?: string|null, currentArea?: string|null}} scope
     * @returns {Promise<{scope: 'direct'|'background'|'mismatch', reason: string, chapter_hint: string|null, quest_hint: string|null, usage_rule: string}>}
     */
    async analyzeScopeMatch(query, content, fileName, scope = {}) {
        const system = `你是一个游戏剧情作用域判断助手。你的任务不是判断内容有没有用，而是判断这份文档与“玩家当前进度”是否属于同一作用域。

判断标准：
1. scope=direct：文档明显对应当前章节、当前主线任务、当前步骤、当前Boss、当前区域，或与这些内容直接相关，可以作为“当前进度信息”使用。
2. scope=background：文档属于同一游戏、同一角色或同一剧情线，但更像前置背景、较早章节回顾、设定补充、角色背景。可以返回给主模型，但必须当作背景参考，不能当作当前进度事实。
3. scope=mismatch：文档明显是其他游戏、其他角色线、完全不同章节/任务，或者会误导当前进度判断，不应作为当前信息使用。

额外提取：
- chapter_hint：如果文档明显指向某一章/幕/阶段，提取出来；否则为 null。
- quest_hint：如果文档明显指向某个任务/剧情段/目标，提取出来；否则为 null。
- usage_rule：根据 scope 输出一句简短规则：
  - direct -> 可作为当前进度信息使用
  - background -> 仅可作为背景参考，禁止当作当前章节事实
  - mismatch -> 不应作为当前进度信息使用

重要要求：
- 不要因为内容不是当前章节就判定为 mismatch。较早章节剧情通常应判为 background。
- 只有明显会误导当前进度，或完全不同主题时，才判为 mismatch。
- 返回JSON：{"scope":"direct|background|mismatch","reason":"简要理由","chapter_hint":"章节提示或null","quest_hint":"任务提示或null","usage_rule":"使用规则"}
- 只返回JSON，不要其他内容。`;

        const scopeText = [
            scope.mainQuest ? `当前主线任务：${scope.mainQuest}` : null,
            scope.currentChapter ? `当前章节：${scope.currentChapter}` : null,
            scope.currentStep ? `当前步骤：${scope.currentStep}` : null,
            scope.currentBoss ? `当前Boss：${scope.currentBoss}` : null,
            scope.currentArea ? `当前区域：${scope.currentArea}` : null,
        ].filter(Boolean).join('\n') || '暂无明确进度信息';

        const user = `用户问题：${query}\n\n玩家当前进度：\n${scopeText}\n\n攻略文件：${fileName}\n内容摘要（前3000字）：\n${content.substring(0, 3000)}`;

        const response = await this._call(system, user);
        try {
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                const scopeVal = ['direct', 'background', 'mismatch'].includes(parsed.scope) ? parsed.scope : 'background';
                const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
                const chapterHint = typeof parsed.chapter_hint === 'string' && parsed.chapter_hint.trim() ? parsed.chapter_hint.trim() : null;
                const questHint = typeof parsed.quest_hint === 'string' && parsed.quest_hint.trim() ? parsed.quest_hint.trim() : null;
                const usageRule = typeof parsed.usage_rule === 'string' && parsed.usage_rule.trim()
                    ? parsed.usage_rule.trim()
                    : (scopeVal === 'direct'
                        ? '可作为当前进度信息使用'
                        : scopeVal === 'background'
                            ? '仅可作为背景参考，禁止当作当前章节事实'
                            : '不应作为当前进度信息使用');
                return { scope: scopeVal, reason, chapter_hint: chapterHint, quest_hint: questHint, usage_rule: usageRule };
            }
        } catch {}
        return {
            scope: 'background',
            reason: '解析失败，默认按背景参考处理',
            chapter_hint: null,
            quest_hint: null,
            usage_rule: '仅可作为背景参考，禁止当作当前章节事实'
        };
    }

    /**
     * 从攻略内容生成精准答案
     * @param {string} [styleHint] - 来自会话的剧透/陪玩偏好说明（主 Agent 仍会二次过滤）
     */
    async generateAnswer(query, content, fileName, styleHint = '') {
        const hasFocusedChunk = /【命中段落 - 优先回答】/.test(content);
        const styleBlock = styleHint && String(styleHint).trim()
            ? `\n\n【子 Agent 输出风格（供主对话模型再加工；仍需忠于文档）】\n${styleHint.trim()}`
            : '';

        const system = `你是一个游戏信息专家。根据用户的问题，从攻略文档中提取最相关、最实用的信息，生成精准详细的回答。

要求：
1. 直接回答问题，不要废话
2. 提取关键要点（打法技巧、注意事项、推荐配置、剧情内容等）
3. 如有具体步骤，按顺序列出
4. 内容要详细具体，进行完整转述
5. 如果文档里点名了角色真实身份、关键事件、具体台词或具体数值，答案里必须照样点名；禁止用“身份已揭晓”“有重大转折”“重要秘密”“可能涉及”这类没有信息量的转述
${styleBlock}

关于信息提取的核心原则：
- 优先基于攻略文档中实际存在的内容来回答。
- 即使文档不能完全精确回答用户的问题，只要文档与问题的主题（同一游戏、同一角色、同一章节等）相关，就必须提取文档中所有可能有用的信息返回。
- 可以提取的内容包括但不限于：角色背景、剧情概要、任务流程、地图信息、NPC对话、战斗机制等。
- 只有在文档内容完全是另一个游戏或完全不相关的主题时，才回答"未找到相关信息"。
- 绝对不能编造文档中没有的具体数据、台词、剧情细节。
- 不确定是否精确匹配时，提取相关内容并注明"以下为该文档中与此主题相关的信息"。`;

        const focusInstruction = hasFocusedChunk
            ? '\n- 文档最前面的【命中段落 - 优先回答】是本次检索的最相关片段，回答时优先围绕这段，不要被后面的章节总述带偏。'
            : '';
        const finalSystem = system + focusInstruction;

        const user = `用户问题：${query}\n\n攻略文档（来源：${fileName}）：\n${content}`;

        return await this._call(finalSystem, user);
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
     * @param {object} sources - { gamersky, bilibili, websearch } 各来源文本（可为null）
     */
    async combineAndSummarize(gameName, query, sources, options = {}) {
        const sourceLabels = {
            local: '本地攻略库',
            gamersky: '游民星空',
            bilibili: 'B站视频',
            websearch: '网络搜索'
        };

        const perSourceChars = Math.max(8000, Number(options.perSourceChars) || 25000);

        const system = `你是一个游戏攻略整合专家。将来自不同来源的游戏信息进行综合整理。

要求：
1. 首先判断各来源内容是否与用户的问题相关。优先整合与问题直接相关的内容。
2. 如果某个来源的内容与问题不是同一主题（完全不同的游戏、完全不同的角色），可以跳过该来源。
3. 但如果来源内容属于同一游戏/同一角色/同一章节的范畴，即使不能精确回答问题，也要提取其中可能有用的背景信息、角色信息、剧情片段等。
 4. 对于相关内容：保留所有重要细节，按逻辑组织，只去除格式重复，保留所有具体事实细节，并标注信息来源。
 5. 内容要详细具体，将相关内容进行完整转述，不能写成目录式摘要。
 6. 如果来源里有具体答案，就必须写出具体身份、姓名/别名/关系、具体台词、具体事件、地点/机构/势力名、机制数值、视觉与叙事符号。
 7. 禁止使用占位语或空泛表述来替代具体事实，例如：核心谜团之一、重大揭示、重要秘密、可能涉及、可能讨论、大致/大概发生了X、揭示了身份但不说是什么。
 8. 如果来源里说琳奈真实身份是新联邦雇佣兵，你必须写出“雇佣兵”三个字，不能写成“身份是谜团”或“身份被揭晓”。
 9. 这次任务不是精简，而是把分散在多源的具体事实压在一起；只要来源里有料，就尽量把 max_tokens 用满，不要为了简洁省略人物台词和剧情节点。
 10. 如有矛盾信息，同时保留并注明。
 11. 输出格式清晰，分段分点。

关于"未找到"的判定标准（必须严格遵守）：
- 只有在所有来源的内容都是完全不同的游戏或完全无关的主题时，才回答"未找到相关信息"。
- 只要有任何一个来源包含同一游戏/同一角色/同一主题的内容，就必须提取并整合这些信息。
- 禁止编造来源中不存在的具体数据、台词、剧情细节。
- 可以提取的内容包括：角色背景、剧情线索、任务概要、地图信息、战斗机制等任何与主题相关的信息。`;

        let user = `游戏：${gameName}\n问题：${query}\n\n`;
        let sourceIndex = 1;

        for (const [key, label] of Object.entries(sourceLabels)) {
            const text = sources[key];
            if (text) {
                user += `=== 来源${sourceIndex}：${label} ===\n${text.substring(0, perSourceChars)}\n\n`;
                sourceIndex++;
            }
        }

        if (sourceIndex === 1) {
            throw new Error('没有任何来源内容可供整合');
        }

        user += '请把以上来源中的具体身份、具体台词、具体事件、具体地点、具体机制、具体关系全部保留并整合；不要写成大纲或目录式摘要。';
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
