/**
 * 洛基之影 - 核心工作流编排引擎 v2.1
 * 7 步流程：游戏检测 → 攻略库检索 → 内容分析 → 信息下载(3源并行) → 内容整合 → 生成答案 → 返回结果
 * 来源：游民星空 | B站 | 网络搜索
 */

const { LokiLogger } = require('./logger');
const { detectCurrentGame } = require('./window-detector');
const { GuideLibrary } = require('./guide-library');
const { SubAgent } = require('./sub-agent');
const { searchGuides, downloadGuideContent } = require('./gamersky-crawler');
const { checkBiliLogin, searchVideo, getVideoContent } = require('./bilibili-fetcher');

class Orchestrator {
    /**
     * 对部分手游禁用游民星空来源，避免低质量或不适配结果干扰
     */
    static DISABLE_GAMERSKY_GAMES = new Set(['鸣潮', '绝区零', '原神']);

    /**
     * @param {object} pluginConfig - 插件完整配置
     */
    constructor(pluginConfig) {
        this.config = pluginConfig;
        this.library = new GuideLibrary(pluginConfig.guide_library_path);
        this.agent = new SubAgent(
            pluginConfig.sub_agent || {},
            pluginConfig.fallback_agent || null
        );
        this.maxContentLength = pluginConfig.max_content_length || 40000;
        this.perSourceContextChars = pluginConfig.per_source_context_chars || 25000;
        this.gamerskyLimit = pluginConfig.gamersky_download_limit || 1;
        this.bilibiliLimit = pluginConfig.bilibili_search_limit || 3;
        this.vectorTopK = pluginConfig.vector_top_k || 5;
        this.vectorApiKey = pluginConfig.vector_api_key || '';
        this.vectorApiUrl = pluginConfig.vector_api_url || 'https://api.siliconflow.cn/v1';
        this.vectorModelName = pluginConfig.vector_model_name || 'Qwen/Qwen3-Embedding-8B';
        this.vectorCacheDir = pluginConfig.vector_cache_dir || null;
    }

    _isStoryQuery(text) {
        return /(剧情|发生|会发生|对话|故事|台词|剧情内容|发生什么|宿舍内部|寝室)/.test(String(text || ''));
    }

    _buildVectorSearchQueries(originalQuestion, refinedQuery) {
        const queries = [];
        const refined = String(refinedQuery || '').trim();
        const original = String(originalQuestion || '').trim();

        if (refined) queries.push(refined);

        if (this._isStoryQuery(original)) {
            const storyVariant = original
                .replace(/[有]?需要做的?操作吗[？?]?/g, '')
                .replace(/操作步骤|操作流程|操作指引|操作指南/g, '剧情')
                .replace(/进入宿舍内部/g, '宿舍内部剧情')
                .replace(/剧情流程/g, '具体剧情')
                .replace(/\s+/g, ' ')
                .trim();

            if (storyVariant && !queries.includes(storyVariant)) {
                queries.push(storyVariant);
            }

            if (original && !queries.includes(original)) {
                queries.push(original);
            }
        }

        return [...new Set(queries.filter(Boolean))];
    }

    _mergeVectorHits(baseHits, newHits) {
        const merged = new Map();
        const addHit = (hit) => {
            if (!hit || !hit.entry) return;
            const entry = hit.entry;
            const key = entry.relativePath || entry.fullPath || entry.fileName || entry.title;
            const prev = merged.get(key);
            if (!prev || Number(hit.score) > Number(prev.score)) {
                merged.set(key, hit);
            }
        };

        (baseHits || []).forEach(addHit);
        (newHits || []).forEach(addHit);
        return [...merged.values()];
    }

    /**
     * 评估 query 质量，判断是否需要降级搜索
     * @returns {{ quality: 'good'|'poor', reason: string, fallbackQueries: string[] }}
     */
    _assessQueryQuality(gameName, query) {
        const trimmed = query.trim();
        const fallbackQueries = [
            `${gameName} 主线攻略 全流程`,
            `${gameName} 攻略 剧情`,
            `${gameName} 新手攻略`
        ];

        if (trimmed.length < 4) {
            return { quality: 'poor', reason: `query过短(${trimmed.length}字)`, fallbackQueries };
        }

        const fragmentPatterns = [
            /^[\u4e00-\u9fff]{1,3}(\s+[\u4e00-\u9fff]{1,3}){3,}/,  // 多个1-3字短词拼接："心笑 真是 没想到 啊"
            /[.。！!？?…]{2,}/,                                       // 多个标点
            /哈{2,}|呵{2,}|嘿{2,}|啊{2,}/,                           // 语气词重复
            /真是|没想到|怎么回事|什么情况|好难|太强了|牛逼|卧槽/,      // 口语感叹
        ];

        const hasFragmentPattern = fragmentPatterns.some(p => p.test(trimmed));

        const structuredPatterns = [
            /攻略|流程|打法|配队|养成|剧情|任务|章节|通关|解析/,
            /第[一二三四五六七八九十\d]+[章节幕]/,
            /[Bb]oss|BOSS/,
        ];
        const hasStructuredPattern = structuredPatterns.some(p => p.test(trimmed));

        if (hasFragmentPattern && !hasStructuredPattern) {
            return { quality: 'poor', reason: '疑似截图碎片/口语化内容', fallbackQueries };
        }

        const words = trimmed.split(/[\s,，。、!！?？]+/).filter(w => w.length >= 2);
        if (words.length > 6 && !hasStructuredPattern) {
            return { quality: 'poor', reason: `关键词过多(${words.length}个)且无结构化词汇`, fallbackQueries };
        }

        return { quality: 'good', reason: 'query质量正常', fallbackQueries };
    }

    /**
     * 执行完整的游戏攻略查询流程
     * @param {string} gameName
     * @param {string} query
     * @param {import('./session-context').GameSessionContext} [sessionCtx]
     */
    async execute(gameName, query, sessionCtx = null) {
        const log = new LokiLogger();

        try {
            // ========== Step 1: 游戏检测 ==========
            log.step('Step1:游戏检测', 'start', gameName ? `用户指定: ${gameName}` : '自动检测中...');

            if (!gameName) {
                try {
                    const detection = await detectCurrentGame();
                    if (detection.detected) {
                        gameName = detection.gameName;
                        log.substep('Step1', '窗口匹配', `检测到游戏: ${gameName} (窗口: ${detection.windowTitle})`);
                    } else {
                        log.substep('Step1', '窗口列表', `未匹配已知游戏，当前窗口: ${detection.allWindows.map(w => w.windowTitle).slice(0, 5).join(', ')}`);
                        log.step('Step1:游戏检测', 'fail', '无法检测到正在运行的游戏，且未指定游戏名');
                        return '【洛基之影】无法检测到当前正在运行的游戏。请在调用时指定 game_name 参数，例如：game_name="绝区零"';
                    }
                } catch (err) {
                    log.error('Step1:游戏检测', err);
                    return `【洛基之影】游戏窗口检测失败: ${err.message}。请手动指定 game_name 参数。`;
                }
            }

            log.step('Step1:游戏检测', 'ok', `游戏: ${gameName}`);

            // ========== Step 1.5: 问题意图细化 ==========
            let refinedQuery = query.trim();
            let queryIntent = '问题检索';
            let queryMissingInfo = null;
            const currentScope = sessionCtx?.getCurrentScope?.() || {};
            try {
                const refined = await this.agent.refineSearchIntent(gameName, refinedQuery, currentScope);
                refinedQuery = refined.searchQuery || refinedQuery;
                queryIntent = refined.intent || queryIntent;
                queryMissingInfo = refined.missingInfo || null;
                log.substep('Step1.5', '问题细化', `intent=${queryIntent} | searchQuery=${refinedQuery}`);
                if (queryMissingInfo) {
                    log.substep('Step1.5', '信息缺口', queryMissingInfo);
                }
            } catch (err) {
                log.substep('Step1.5', '问题细化失败', err.message);
            }

            // ========== Step 2: 攻略库检索 ==========
            log.step('Step2:攻略库检索', 'start', `在攻略库中搜索 "${gameName}" 相关文件...`);

            this.library.ensureDirectory();
            const allFiles = this.library.scanFiles(gameName);
            log.substep('Step2', '文件扫描', `找到 ${allFiles.length} 个与 "${gameName}" 相关的攻略文件`);

            let selectedFile = null;
            let selectedContent = null;
            let selectedCandidates = [];

            if (allFiles.length > 0) {
                log.substep('Step2', '向量召回', `使用硅基流动 Embedding 从 ${allFiles.length} 个文件中召回 Top-${this.vectorTopK}...`);

                try {
                    let vectorHits = [];
                    const searchQueries = this._buildVectorSearchQueries(query, refinedQuery);

                    for (const searchQuery of searchQueries) {
                        try {
                            const hits = await this.library.searchByVector(searchQuery, allFiles, {
                                gameName,
                                topK: this.vectorTopK,
                                apiKey: this.vectorApiKey,
                                apiUrl: this.vectorApiUrl,
                                model: this.vectorModelName,
                                cacheDir: this.vectorCacheDir || undefined,
                                chunkSize: 900,
                                chunkOverlap: 150
                            });
                            vectorHits = this._mergeVectorHits(vectorHits, hits);
                        } catch (vectorErr) {
                            log.substep('Step2', '向量失败', `${searchQuery} | ${vectorErr.message}`);
                        }
                    }

                    vectorHits.sort((a, b) => b.score - a.score);
                    vectorHits = vectorHits.slice(0, Math.max(this.vectorTopK, 5));

                    if (vectorHits.length === 0) {
                        log.substep('Step2', '未命中', '向量召回为空');
                    }

                    if (vectorHits.length > 0) {
                        log.substep('Step2', '向量结果', vectorHits.map(v => `${v.entry.fileName}:${v.score.toFixed(3)}`).join(' | '));

                        const scope = sessionCtx?.getCurrentScope?.() || {};
                        const scoredCandidates = await this.agent.scoreGuideCandidates(
                            gameName,
                            refinedQuery,
                            vectorHits,
                            scope
                        );

                        selectedCandidates = scoredCandidates;
                        const bestCandidate = scoredCandidates[0];

                        if (bestCandidate && bestCandidate.combinedScore > 0) {
                            const selectedHit = vectorHits.find(v => v.entry.fileName === bestCandidate.fileName || v.entry.relativePath === bestCandidate.relativePath) || vectorHits[0];
                            selectedFile = selectedHit?.entry || null;

                            const fullContent = selectedHit?.entry?.docText
                                || this.library.readFile(
                                    selectedHit?.entry?.fullPath ||
                                    allFiles.find(f => f.fileName === bestCandidate.fileName || f.relativePath === bestCandidate.relativePath)?.fullPath,
                                    this.maxContentLength
                                );

                            const focusChunk = (bestCandidate.matchedChunk || selectedHit?.chunkText || '').trim();
                            const chunkContext = fullContent && focusChunk && fullContent.includes(focusChunk)
                                ? this._extractChunkContext(fullContent, focusChunk, 900)
                                : fullContent;
                            selectedContent = focusChunk && chunkContext
                                ? `【命中段落 - 优先回答】\n${focusChunk}\n\n【命中段落上下文】\n${chunkContext}\n\n【文档全文】\n${fullContent}`
                                : (fullContent || focusChunk || '');

                            log.substep('Step2', '选中文件', `${bestCandidate.fileName} | combined=${bestCandidate.combinedScore.toFixed(3)} | vector=${bestCandidate.vectorScore.toFixed(3)} | confidence=${bestCandidate.confidence} | scope=${bestCandidate.scope}`);
                        } else {
                            log.substep('Step2', '未命中', '向量召回后仍无高置信度候选');
                        }
                    } else {
                        log.substep('Step2', '未命中', '向量召回为空');
                    }
                } catch (err) {
                    log.substep('Step2', '选择失败', err.message);
                }
            }

            log.step('Step2:攻略库检索', allFiles.length > 0 ? 'ok' : 'skip',
                selectedFile ? `选中: ${selectedFile.fileName}` : `攻略库中未找到相关文件`);

            // ========== Step 3: 内容分析 ==========
            let existingGuideAsSource = null;
            let existingGuideScope = null;
            if (selectedFile && selectedContent) {
                log.step('Step3:内容分析', 'start', `用 ${this.agent.getActiveAgentName()} 分析内容...`);

                try {
                    const analysis = await this.agent.analyzeContent(refinedQuery, selectedContent, selectedFile.fileName);
                    log.substep('Step3', '分析结果', `canAnswer=${analysis.canAnswer}, confidence=${analysis.confidence}, reason=${analysis.reason}`);

                    const scope = sessionCtx?.getCurrentScope?.() || {};
                    const scopeMatch = await this.agent.analyzeScopeMatch(refinedQuery, selectedContent, selectedFile.fileName, scope);
                    existingGuideScope = scopeMatch;
                    log.substep('Step3', '作用域判断', `scope=${scopeMatch.scope}, reason=${scopeMatch.reason}`);

                    if (analysis.canAnswer && analysis.confidence === 'high' && scopeMatch.scope === 'direct') {
                        log.step('Step3:内容分析', 'ok', '高置信度且作用域直接匹配，现有攻略可以回答问题，跳到 Step6');
                        return await this._generateAndReturn(log, gameName, query, refinedQuery, selectedContent, selectedFile.fileName, sessionCtx, scopeMatch, { intent: queryIntent, missingInfo: queryMissingInfo });
                    } else if (scopeMatch.scope === 'mismatch') {
                        log.step('Step3:内容分析', 'warn', `文档与当前进度作用域不匹配，原因: ${scopeMatch.reason}，不作为当前剧情来源`);
                    } else if (analysis.canAnswer) {
                        log.step('Step3:内容分析', 'warn', `${analysis.confidence}置信度，且作用域=${scopeMatch.scope}，保留现有攻略作为${scopeMatch.scope === 'background' ? '背景参考' : '补充来源'}`);
                        existingGuideAsSource = {
                            name: selectedFile.fileName,
                            content: selectedContent
                        };
                    } else {
                        log.step('Step3:内容分析', 'warn', `Agent判断不能直接回答(${analysis.reason})，但因作用域=${scopeMatch.scope}，仍保留为${scopeMatch.scope === 'background' ? '背景参考' : '参考来源'}`);
                        existingGuideAsSource = {
                            name: selectedFile.fileName,
                            content: selectedContent
                        };
                    }
                } catch (err) {
                    log.error('Step3:内容分析', err);
                }
            } else {
                log.step('Step3:内容分析', 'skip', '攻略库中无相关文件，直接进入下载阶段');
            }

            // ========== Step 3.5: Query质量评估 + 会话记忆增强 ==========
            const queryAssessment = this._assessQueryQuality(gameName, refinedQuery);
            log.step('Step3.5:Query评估', queryAssessment.quality === 'good' ? 'ok' : 'warn',
                `质量: ${queryAssessment.quality} | 原因: ${queryAssessment.reason}`);

            let effectiveQuery = refinedQuery;
            if (queryAssessment.quality === 'poor') {
                let hasEnhancement = false;
                if (sessionCtx) {
                    const ctxSummary = sessionCtx.getSummary();
                    if (ctxSummary) {
                        log.substep('Step3.5', '会话记忆', ctxSummary.replace(/\n/g, ' | '));
                    }
                    const enhancement = sessionCtx.getSearchEnhancement();
                    if (enhancement.keyword) {
                        effectiveQuery = enhancement.keyword;
                        hasEnhancement = true;
                        log.substep('Step3.5', '搜索增强',
                            `query质量差，使用会话记忆替代: "${effectiveQuery}" (来源: ${enhancement.source})`);
                    }
                }

                if (!hasEnhancement) {
                    log.step('Step3.5:信息不足', 'warn', 'query质量差且无会话记忆可用，返回追问提示');
                    return `【洛基之影 · 需要更多信息】当前这个问题还不够具体，无法精准搜索攻略。\n\n主对话模型当前真正想了解的是：${query}\n系统整理后的检索方向：${refinedQuery}\n${queryIntent ? `问题类型：${queryIntent}\n` : ''}${queryMissingInfo ? `当前最缺的信息：${queryMissingInfo}\n` : ''}\n请先像朋友一样自然补一句最关键的信息，再决定是否继续调用 loki_shadow_query。\n例如可以补：\n- 任务名 / 章节名\n- 所在区域或地图\n- 遇到的Boss、角色名、地点名\n- 想弄清楚的是推进方法、打法机制，还是剧情/台词含义\n\n注意：不要机械盘问；同类问题最多自然追问一次。`;
                }
            } else if (sessionCtx) {
                const ctxSummary = sessionCtx.getSummary();
                if (ctxSummary) {
                    log.substep('Step3.5', '会话记忆', ctxSummary.replace(/\n/g, ' | '));
                }
            }

            // ========== Step 4: 信息下载（3源异步并行）==========
            log.step('Step4:信息下载', 'start', '从3个来源异步并行下载: 游民星空 | B站 | 网络搜索');

            let sourceResults = await this._fetchAllSources(log, gameName, effectiveQuery);

            let sourceNames = { local: '本地攻略库', gamersky: '游民星空', bilibili: 'B站', websearch: '网络搜索' };
            let successSources = Object.entries(sourceResults)
                .filter(([, v]) => v !== null)
                .map(([k]) => sourceNames[k]);
            let failedSources = Object.entries(sourceResults)
                .filter(([, v]) => v === null)
                .map(([k]) => sourceNames[k]);

            log.step('Step4:信息下载', successSources.length > 0 ? 'ok' : 'fail',
                `成功: [${successSources.join(', ') || '无'}] | 失败: [${failedSources.join(', ') || '无'}]`);

            // ========== Step 4.5: 降级宽泛搜索 ==========
            const needFallback = successSources.length === 0 ||
                (queryAssessment.quality === 'poor' && successSources.length <= 1);

            if (needFallback && queryAssessment.fallbackQueries.length > 0) {
                log.step('Step4.5:降级搜索', 'start',
                    `原始搜索结果不足(${successSources.length}个来源)，启用宽泛搜索降级`);

                for (const fallbackQuery of queryAssessment.fallbackQueries) {
                    log.substep('Step4.5', '宽泛搜索', `尝试: "${fallbackQuery}"`);

                    const fallbackResults = await this._fetchAllSources(log, gameName, fallbackQuery);
                    const fallbackSuccess = Object.entries(fallbackResults)
                        .filter(([, v]) => v !== null);

                    if (fallbackSuccess.length > 0) {
                        for (const [key, value] of fallbackSuccess) {
                            if (!sourceResults[key]) {
                                sourceResults[key] = value;
                            }
                        }
                        log.substep('Step4.5', '降级成功',
                            `"${fallbackQuery}" 命中 ${fallbackSuccess.length} 个来源: ${fallbackSuccess.map(([k]) => sourceNames[k]).join(', ')}`);
                        break;
                    }
                }

                successSources = Object.entries(sourceResults)
                    .filter(([, v]) => v !== null)
                    .map(([k]) => sourceNames[k]);

                log.step('Step4.5:降级搜索', successSources.length > 0 ? 'ok' : 'fail',
                    `降级后总计: ${successSources.length} 个来源有数据`);
            }

            if (successSources.length === 0) {
                if (selectedContent) {
                    log.substep('Step4', '降级策略', '所有来源失败，使用攻略库现有内容');
                    return await this._generateAndReturn(log, gameName, query, refinedQuery, selectedContent, selectedFile.fileName, sessionCtx, existingGuideScope || { scope: 'background', reason: '兜底使用本地攻略内容' }, { intent: queryIntent, missingInfo: queryMissingInfo });
                }

                log.step('最终结果', 'fail', '所有来源均无法获取信息');
                return `【洛基之影 · 攻略库无法解答】未能找到关于 "${gameName}" "${query}" 的攻略信息。\n\n建议使用 web_search 工具联网搜索 "${gameName} ${query}" 获取最新攻略。`;
            }

            // ========== Step 5: 内容整合 ==========
            const totalSources = successSources.length + (existingGuideAsSource ? 1 : 0);
            log.step('Step5:内容整合', 'start', `综合整理 ${totalSources} 个来源...`);

            const sourceTexts = {};
            const sourceUrls = [];

            if (existingGuideAsSource) {
                const scopeLabel = existingGuideScope?.scope === 'background'
                    ? '背景参考（与当前进度不完全一致，禁止当作当前章节事实）'
                    : '当前相关参考';
                const scopeReason = existingGuideScope?.reason ? `\n作用域说明：${existingGuideScope.reason}` : '';
                const scopeChapter = existingGuideScope?.chapter_hint ? `\n章节提示：${existingGuideScope.chapter_hint}` : '';
                const scopeQuest = existingGuideScope?.quest_hint ? `\n任务提示：${existingGuideScope.quest_hint}` : '';
                const usageRule = existingGuideScope?.usage_rule ? `\n使用规则：${existingGuideScope.usage_rule}` : '';
                sourceTexts.local = `文件：${existingGuideAsSource.name}\n用途：${scopeLabel}${scopeReason}${scopeChapter}${scopeQuest}${usageRule}\n${existingGuideAsSource.content}`;
                log.substep('Step5', '本地攻略', `并入攻略库已有内容: ${existingGuideAsSource.name} (${scopeLabel})`);
            }

            if (sourceResults.gamersky) {
                sourceTexts.gamersky = `标题：${sourceResults.gamersky.title}\n${sourceResults.gamersky.content}`;
                sourceUrls.push({ type: 'gamersky', url: sourceResults.gamersky.url });
            }
            if (sourceResults.bilibili) {
                sourceTexts.bilibili = sourceResults.bilibili.summary;
                sourceUrls.push({ type: 'bilibili', url: sourceResults.bilibili.url || `https://www.bilibili.com/video/${sourceResults.bilibili.bvid}` });
            }
            if (sourceResults.websearch) {
                sourceTexts.websearch = sourceResults.websearch.content;
            }

            let combinedContent;
            try {
                combinedContent = await this.agent.combineAndSummarize(gameName, refinedQuery, sourceTexts, {
                    perSourceChars: this.perSourceContextChars
                });
                log.substep('Step5', 'Agent整合', `整合完成 (${this.agent.getActiveAgentName()})，长度: ${combinedContent.length}`);
            } catch (err) {
                log.error('Step5:内容整合', err);
                combinedContent = '';
                for (const [key, label] of Object.entries(sourceNames)) {
                    if (sourceTexts[key]) {
                        combinedContent += `【${label}】\n${sourceTexts[key].substring(0, this.perSourceContextChars)}\n\n`;
                    }
                }
            }

            // 检查整合结果是否为"未找到" — 如果 sub-agent 判定来源都不相关，直接返回，不保存垃圾文件
            if (this._isNoInfoResponse(combinedContent)) {
                log.step('Step5:内容整合', 'fail', 'Agent 判定所有来源内容均与问题无关，不保存');
                log.step('最终结果', 'fail', '来源内容不相关');
                return this._buildNoInfoFallback(gameName, query, sessionCtx, {
                    reason: 'sources_irrelevant',
                    searchedSources: [...successSources],
                    refinedQuery,
                    suggestion: `建议补充任务栏/对话框/角色名截图，或改搜更具体的关键词："${gameName} 椿 台词 剧情 对话"、"${gameName} 椿 角色剧情 解析"。`
                });
            }

            let tags;
            try {
                tags = await this.agent.generateTags(gameName, refinedQuery, combinedContent);
                log.substep('Step5', '标签生成', tags.join(', '));
            } catch {
                tags = ['攻略'];
            }

            try {
                const savedPath = this.library.saveGuide({
                    gameName,
                    tags,
                    content: combinedContent,
                    sources: sourceUrls
                });
                log.substep('Step5', '文件保存', savedPath);
            } catch (err) {
                log.substep('Step5', '保存失败', err.message);
            }

            log.step('Step5:内容整合', 'ok', `已保存，来源: ${successSources.join('+')}, 标签: ${tags.join(', ')}`);

            // ========== Step 6 & 7: 生成答案并返回 ==========
            return await this._generateAndReturn(log, gameName, query, refinedQuery, combinedContent, `[${tags.join('_')}]`, sessionCtx, { scope: 'background', reason: '多来源整合结果，默认不视为当前章节直达剧情' }, { intent: queryIntent, missingInfo: queryMissingInfo });

        } catch (err) {
            log.error('未预期异常', err);
            return `【洛基之影 · 系统错误】执行过程中发生异常: ${err.message}\n\n建议使用 web_search 工具联网搜索获取攻略信息。`;
        }
    }

    /**
     * Step 6 + Step 7：生成最终答案并返回
     * @param {import('./session-context').GameSessionContext} [sessionCtx]
     */
    async _generateAndReturn(log, gameName, originalQuestion, refinedQuery, content, sourceName, sessionCtx = null, sourceScope = null, queryMeta = null) {
        log.step('Step6:生成答案', 'start', `用 ${this.agent.getActiveAgentName()} 生成最终答案...`);

        try {
            let contextPrefix = '';
            if (sessionCtx) {
                const summary = sessionCtx.getSummary();
                if (summary) {
                    contextPrefix = `【玩家当前游戏进度】\n${summary}\n\n`;
                }
            }
            const styleHint = sessionCtx?.getAnswerStyleHint?.() || '';
            const answer = await this.agent.generateAnswer(originalQuestion, contextPrefix + content, sourceName, styleHint);

            if (!answer || this._isNoInfoResponse(answer)) {
                log.step('Step6:生成答案', 'fail', '攻略内容无法回答该问题');
                log.step('Step7:返回结果', 'ok', '返回 no_reliable_info 兜底');
                return this._buildNoInfoFallback(gameName, originalQuestion, sessionCtx, {
                    reason: 'answer_not_reliable',
                    searchedSources: [sourceName],
                    refinedQuery,
                    suggestion: `建议改搜更聚焦的表达，例如："${gameName} 椿 台词 对话"、"${gameName} 椿 剧情 文本"、"${gameName} 椿 角色故事"。`
                });
            }

            log.step('Step6:生成答案', 'ok', `答案长度: ${answer.length}`);
            log.substep('Step6.5', '跳过剧情注入', '剧情被动注入机制已移除，所有答案仅作为当轮参考');

            log.step('Step7:返回结果', 'ok', '查询完成');

            const summary = log.getSummary();
            try {
                const { logToTerminal } = require('../../../js/api-utils.js');
                logToTerminal('info', `[洛基之影] 执行摘要:\n${summary}`);
            } catch {
                console.log(summary);
            }

            const scopeHeader = sourceScope ? [
                '【洛基之影 · 检索作用域】',
                `scope: ${sourceScope.scope || 'unknown'}`,
                `usage_rule: ${sourceScope.usage_rule || '仅供参考'}`,
                `chapter_hint: ${sourceScope.chapter_hint || 'unknown'}`,
                `quest_hint: ${sourceScope.quest_hint || 'unknown'}`,
                `scope_reason: ${sourceScope.reason || 'unknown'}`,
                ''
            ].join('\n') : '';

            return `${scopeHeader}【${gameName} 攻略】原问题：${originalQuestion}\n检索问题：${refinedQuery}${queryMeta?.intent ? `\n问题类型：${queryMeta.intent}` : ''}${queryMeta?.missingInfo ? `\n信息缺口：${queryMeta.missingInfo}` : ''}\n\n来源：${sourceName}\n\n${answer}\n\n---\n【提示】以上信息来自攻略库和有限的爬虫来源，可能不完整。如果你觉得信息不足以支撑聊天，建议补充调用 web_search 工具搜索 "${gameName} ${refinedQuery}" 获取更全面的信息。`;

        } catch (err) {
            log.error('Step6:生成答案', err);
            log.step('Step7:返回结果', 'fail', '答案生成失败');
            return `【洛基之影 · 答案生成失败】${err.message}\n\n建议使用 web_search 工具联网搜索 "${gameName} ${refinedQuery}"。`;
        }
    }

    /**
     * 构造“未检索到可靠资料”时返回给主对话模型的兜底包。
     * 目标：明确告知“不能编”，同时给出可继续陪聊的安全方向。
     * @param {import('./session-context').GameSessionContext} [sessionCtx]
     */
    _buildNoInfoFallback(gameName, query, sessionCtx = null, extra = {}) {
        const ctxSummary = sessionCtx?.getSummary?.() || '暂无有效游戏状态记录';
        const searchedSources = Array.isArray(extra.searchedSources) && extra.searchedSources.length > 0
            ? extra.searchedSources.join(' / ')
            : '攻略库 / 网络来源';
        const reason = extra.reason || 'no_reliable_info';
        const suggestion = extra.suggestion || `建议补充更具体的任务名、角色名、地图名或台词上下文，再次搜索 "${gameName} ${extra.refinedQuery || query}"。`;

        return [
            '【洛基之影 · 未检索到可靠资料】',
            `status: no_reliable_info`,
            `game_name: ${gameName}`,
            `query: ${query}`,
            `reason: ${reason}`,
            '',
            '说明：',
            `- 已搜索来源：${searchedSources}`,
            '- 结果：现有来源没有找到与该问题直接相关的可靠内容',
            '- 注意：不要根据不相关来源编造剧情、台词含义或设定解释',
            '',
            '当前游戏上下文：',
            ctxSummary,
            '',
            '给主对话模型的行动建议：',
            '1. 不要硬讲剧情答案，先基于当前截图和用户刚才的话继续陪聊',
            '2. 可以评论画面里的角色表情、场景氛围、战斗压力、演出张力',
            '3. 可以围绕用户刚提到的台词做低风险感受型回应，比如“这句听着就很有压迫感/挑衅感/宿命感”',
            '4. 可以自然追问一句当前是在剧情对话、战斗还是跑图，不要连续盘问',
            '5. 如果画面里有任务栏、角色名、区域名、对话框，可以优先根据画面信息继续判断和陪聊',
            '',
            '安全陪聊方向：',
            '- 画面吐槽',
            '- 战斗反馈',
            '- 情绪共鸣',
            '- 当前角色印象',
            '- 任务进度确认',
            '',
            `下一步建议：${suggestion}`
        ].join('\n');
    }

    // ========== "未找到"响应检测 ==========

    /**
     * 判断 Sub-Agent 的回复是否为"未找到信息"类响应
     * 用于在整合阶段和答案生成阶段提前拦截，避免保存垃圾文件或返回无意义内容
     * @param {string} text - Sub-Agent 返回的文本
     * @returns {boolean}
     */
    _isNoInfoResponse(text) {
        if (!text || typeof text !== 'string') return true;

        const trimmed = text.trim();

        // 极短回复几乎不可能是有效攻略内容
        if (trimmed.length < 30) return true;

        // Sub-Agent 被指示在无相关内容时使用的标准回复模式
        const noInfoPatterns = [
            /未找到相关信息/,
            /所有来源的内容均与.*问题无关/,
            /所有来源.*(?:均|都).*(?:无关|不相关|不包含)/,
            /无法提供.*(?:准确|有效|相关).*(?:信息|攻略|答案)/,
            /无法(?:从|根据).*(?:来源|内容|资料).*(?:找到|提取|获取)/,
            /(?:来源|搜索结果|内容).*(?:均|都|全部).*(?:不相关|无关|没有)/,
            /没有找到.*(?:相关|有效|有用).*(?:信息|内容|攻略)/,
            /无法回答.*(?:该|这个|此).*问题/,
            /(?:很抱歉|抱歉).*(?:未能|无法|没有).*(?:找到|获取|提供)/,
        ];

        return noInfoPatterns.some(pattern => pattern.test(trimmed));
    }

    // ========== 并行下载所有来源 ==========

    async _fetchAllSources(log, gameName, searchQuery) {
        const disableGamersky = Orchestrator.DISABLE_GAMERSKY_GAMES.has(String(gameName || '').trim());
        if (disableGamersky) {
            log.substep('Step4', '游民星空:跳过', `游戏「${gameName}」已禁用游民星空来源`);
        }

        const downloadTasks = [
            disableGamersky ? Promise.resolve(null) : this._fetchGamersky(log, gameName, searchQuery),
            this._fetchBilibili(log, gameName, searchQuery),
            this._fetchWebSearch(log, gameName, searchQuery)
        ];

        const settled = await Promise.allSettled(downloadTasks);

        return {
            gamersky:  settled[0].status === 'fulfilled' ? settled[0].value : null,
            bilibili:  settled[1].status === 'fulfilled' ? settled[1].value : null,
            websearch: settled[2].status === 'fulfilled' ? settled[2].value : null
        };
    }

    // ========== 各来源的 fetch 方法 ==========

    async _fetchGamersky(log, gameName, query) {
        log.substep('Step4', '游民星空:搜索', `关键词: "${gameName} ${query}"`);

        try {
            const guides = await searchGuides(`${gameName} ${query}`, this.gamerskyLimit);
            if (!guides || guides.length === 0) {
                log.substep('Step4', '游民星空:结果', '未找到');
                return null;
            }

            log.substep('Step4', '游民星空:结果', `${guides.length}条: ${guides.map(g => g.title).join(', ')}`);
            const guide = guides[0];

            const dup = this.library.checkDuplicateSource(guide.url);
            if (dup.exists) {
                log.substep('Step4', '游民星空:去重', `已有: ${dup.filePath}`);
                const cached = this.library.readFile(dup.filePath, this.maxContentLength);
                if (cached) return { title: guide.title, content: cached, url: guide.url, fromCache: true };
            }

            log.substep('Step4', '游民星空:下载', guide.title);
            const detail = await downloadGuideContent(guide.url);
            log.substep('Step4', '游民星空:完成', `${detail.totalPages}页, ${detail.content.length}字`);
            return detail;
        } catch (err) {
            log.substep('Step4', '游民星空:失败', err.message);
            return null;
        }
    }

    async _fetchBilibili(log, gameName, query) {
        log.substep('Step4', 'B站:检查登录', '检查 B 站登录状态...');

        try {
            // 先检查登录状态
            const loginStatus = await checkBiliLogin();
            if (!loginStatus.loggedIn) {
                log.substep('Step4', 'B站:未登录', loginStatus.message);
                return null;
            }
            log.substep('Step4', 'B站:已登录', loginStatus.message);

            log.substep('Step4', 'B站:搜索', `关键词: "${gameName} ${query}"`);
            const videos = await searchVideo(gameName, query, this.bilibiliLimit);
            if (!videos || videos.length === 0) {
                log.substep('Step4', 'B站:结果', '未找到');
                return null;
            }

            log.substep('Step4', 'B站:结果', `${videos.length}条: ${videos.map(v => v.title).join(', ')}`);

            let selectedVideo;
            try {
                const bestIdx = await this.agent.selectBestVideo(query, videos);
                selectedVideo = (bestIdx > 0 && bestIdx <= videos.length) ? videos[bestIdx - 1] : videos[0];
                log.substep('Step4', 'B站:Agent选择', selectedVideo.title);
            } catch {
                selectedVideo = videos[0];
                log.substep('Step4', 'B站:默认选择', selectedVideo.title);
            }

            const videoUrl = `https://www.bilibili.com/video/${selectedVideo.bvid}`;
            const dup = this.library.checkDuplicateSource(selectedVideo.bvid);
            if (dup.exists) {
                log.substep('Step4', 'B站:去重', `已有: ${dup.filePath}`);
                const cached = this.library.readFile(dup.filePath, this.maxContentLength);
                if (cached) return { bvid: selectedVideo.bvid, title: selectedVideo.title, summary: cached, url: videoUrl, fromCache: true };
            }

            log.substep('Step4', 'B站:获取内容', `BV: ${selectedVideo.bvid} (优先字幕→降级语音转录)`);
            const content = await getVideoContent(selectedVideo.bvid);
            if (content.needLogin) {
                log.substep('Step4', 'B站:需登录', content.message);
                return null;
            }
            log.substep('Step4', 'B站:完成', `来源: ${content.source}, 长度: ${content.text.length}`);
            return { bvid: selectedVideo.bvid, title: selectedVideo.title, summary: content.text, url: videoUrl };
        } catch (err) {
            log.substep('Step4', 'B站:失败', err.message);
            return null;
        }
    }

    /**
     * 网络搜索 — 3路并行：VSearch(语义深度) + Google + Bing
     * 合并所有成功结果，最大化命中率
     */
    async _fetchWebSearch(log, gameName, query) {
        log.substep('Step4', '网络搜索:启动', `3路并行搜索: VSearch + Google + Bing | "${gameName} ${query}"`);

        try {
            if (!global.pluginManager) {
                log.substep('Step4', '网络搜索:不可用', 'pluginManager 不可用，请确认插件系统已正常初始化');
                return null;
            }

            const fullQuery = `${gameName} ${query}`;

            // 构建 VSearch 关键词：拆分 query 中的核心词，加上游戏名组合
            const queryWords = query.split(/\s+/).filter(w => w.length >= 2);
            const vsearchKeywords = [
                fullQuery,
                ...queryWords.slice(0, 3).map(w => `${gameName} ${w}`)
            ].filter((v, i, arr) => arr.indexOf(v) === i).join(',');

            // 3路并行
            const searchTasks = [
                this._callSearchTool(log, 'vsearch', {
                    topic: `${gameName} ${query} 游戏攻略/剧情信息`,
                    keywords: vsearchKeywords
                }, 'VSearch'),
                this._callSearchTool(log, 'google_search', {
                    query: fullQuery,
                    gl: 'cn',
                    hl: 'zh-cn'
                }, 'Google'),
                this._callSearchTool(log, 'bing_search', {
                    query: fullQuery,
                    cc: 'CN'
                }, 'Bing')
            ];

            const settled = await Promise.allSettled(searchTasks);

            // 合并结果
            const parts = [];
            const engineNames = ['VSearch', 'Google', 'Bing'];

            for (let i = 0; i < settled.length; i++) {
                const s = settled[i];
                const name = engineNames[i];
                if (s.status === 'fulfilled' && s.value) {
                    parts.push(`【${name}搜索结果】\n${s.value}`);
                    log.substep('Step4', `网络搜索:${name}`, `成功 (${s.value.length}字)`);
                } else {
                    const reason = s.status === 'rejected' ? s.reason?.message : '无结果';
                    log.substep('Step4', `网络搜索:${name}`, `失败: ${reason}`);
                }
            }

            if (parts.length === 0) {
                log.substep('Step4', '网络搜索:结果', '3路搜索均未获取到有效内容');
                return null;
            }

            const combined = parts.join('\n\n');
            log.substep('Step4', '网络搜索:完成', `${parts.length}/3 路成功, 总长度: ${combined.length}`);
            return { content: combined };
        } catch (err) {
            log.substep('Step4', '网络搜索:失败', err.message);
            return null;
        }
    }

    /**
     * 调用 multi-search 插件的单个搜索工具，提取文本结果
     * @param {string} toolName - 工具名 (vsearch / google_search / bing_search)
     * @param {object} params - 工具参数
     * @param {string} label - 日志标签
     * @returns {Promise<string|null>}
     */
    async _callSearchTool(log, toolName, params, label) {
        try {
            if (!global.pluginManager) {
                throw new Error('pluginManager 不可用');
            }

            const result = await global.pluginManager.executeTool(toolName, params);
            let rawResult;
            if (typeof result === 'string') {
                rawResult = result;
            } else if (Array.isArray(result)) {
                rawResult = result.map(r => r.content || JSON.stringify(r)).join('\n');
            } else if (result && result.content) {
                rawResult = result.content;
            } else {
                rawResult = JSON.stringify(result);
            }

            if (!rawResult || rawResult.length < 20) return null;

            // 过滤掉明确的错误/失败信息
            if (/搜索失败|错误：|Error/i.test(rawResult.substring(0, 100))) return null;

            return rawResult;
        } catch (err) {
            log.substep('Step4', `网络搜索:${label}:异常`, err.message);
            return null;
        }
    }

    _extractChunkContext(fullContent, chunkText, windowSize = 900) {
        if (!fullContent || !chunkText) return fullContent || chunkText || '';
        const idx = fullContent.indexOf(chunkText);
        if (idx === -1) return fullContent;

        const start = Math.max(0, idx - windowSize);
        const end = Math.min(fullContent.length, idx + chunkText.length + windowSize);
        return fullContent.slice(start, end);
    }
}

module.exports = { Orchestrator };
