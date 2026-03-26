/**
 * 洛基之影 - 核心工作流编排引擎 v2.0
 * 7 步流程：游戏检测 → 攻略库检索 → 内容分析 → 信息下载(5源并行) → 内容整合 → 生成答案 → 返回结果
 * 来源：游民星空 | B站 | TapTap | NGA | 米游社
 */

const { LokiLogger } = require('./logger');
const { detectCurrentGame } = require('./window-detector');
const { GuideLibrary } = require('./guide-library');
const { SubAgent } = require('./sub-agent');
const { searchGuides, downloadGuideContent } = require('./gamersky-crawler');
const { searchVideo, getVideoSummary } = require('./bilibili-fetcher');
const { searchTapTapGuides } = require('./taptap-crawler');
const { searchNGAGuides } = require('./nga-crawler');
const { searchMiyousheGuides } = require('./miyoushe-crawler');

class Orchestrator {
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
        this.maxContentLength = pluginConfig.max_content_length || 20000;
        this.gamerskyLimit = pluginConfig.gamersky_download_limit || 1;
        this.bilibiliLimit = pluginConfig.bilibili_search_limit || 3;
        this.taptapLimit = pluginConfig.taptap_search_limit || 1;
        this.ngaLimit = pluginConfig.nga_search_limit || 1;
        this.miyousheLimit = pluginConfig.miyoushe_search_limit || 1;
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

            // ========== Step 2: 攻略库检索 ==========
            log.step('Step2:攻略库检索', 'start', `在攻略库中搜索 "${gameName}" 相关文件...`);

            this.library.ensureDirectory();
            const allFiles = this.library.scanFiles(gameName);
            log.substep('Step2', '文件扫描', `找到 ${allFiles.length} 个与 "${gameName}" 相关的攻略文件`);

            let selectedFile = null;
            let selectedContent = null;

            if (allFiles.length > 0) {
                log.substep('Step2', 'Agent选文件', `使用 ${this.agent.getActiveAgentName()} 从 ${allFiles.length} 个文件中选择...`);

                try {
                    const fileIndex = await this.agent.selectRelevantFile(gameName, query, allFiles);
                    if (fileIndex > 0 && fileIndex <= allFiles.length) {
                        selectedFile = allFiles[fileIndex - 1];
                        selectedContent = this.library.readFile(selectedFile.fullPath, this.maxContentLength);
                        log.substep('Step2', '选中文件', selectedFile.fileName);
                    } else {
                        log.substep('Step2', '未命中', 'Agent 判断没有相关文件');
                    }
                } catch (err) {
                    log.substep('Step2', '选择失败', err.message);
                }
            }

            log.step('Step2:攻略库检索', allFiles.length > 0 ? 'ok' : 'skip',
                selectedFile ? `选中: ${selectedFile.fileName}` : `攻略库中未找到相关文件`);

            // ========== Step 3: 内容分析 ==========
            let existingGuideAsSource = null;
            if (selectedFile && selectedContent) {
                log.step('Step3:内容分析', 'start', `用 ${this.agent.getActiveAgentName()} 分析内容...`);

                try {
                    const analysis = await this.agent.analyzeContent(query, selectedContent, selectedFile.fileName);
                    log.substep('Step3', '分析结果', `canAnswer=${analysis.canAnswer}, confidence=${analysis.confidence}, reason=${analysis.reason}`);

                    if (analysis.canAnswer && analysis.confidence === 'high') {
                        log.step('Step3:内容分析', 'ok', '高置信度，现有攻略可以回答问题，跳到 Step6');
                        return await this._generateAndReturn(log, gameName, query, selectedContent, selectedFile.fileName, sessionCtx);
                    } else if (analysis.canAnswer && analysis.confidence === 'medium') {
                        log.step('Step3:内容分析', 'warn', '中等置信度，保留现有攻略并继续搜索更多来源补充');
                        existingGuideAsSource = {
                            name: selectedFile.fileName,
                            content: selectedContent
                        };
                    } else {
                        log.step('Step3:内容分析', 'skip', `现有攻略不足以回答，原因: ${analysis.reason}`);
                    }
                } catch (err) {
                    log.error('Step3:内容分析', err);
                }
            } else {
                log.step('Step3:内容分析', 'skip', '攻略库中无相关文件，直接进入下载阶段');
            }

            // ========== Step 3.5: Query质量评估 + 会话记忆增强 ==========
            const queryAssessment = this._assessQueryQuality(gameName, query);
            log.step('Step3.5:Query评估', queryAssessment.quality === 'good' ? 'ok' : 'warn',
                `质量: ${queryAssessment.quality} | 原因: ${queryAssessment.reason}`);

            let effectiveQuery = query;
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
                    return `【洛基之影 · 需要更多信息】当前从截图或对话中提取的信息不够具体（原始query: "${query}"），无法精准搜索攻略。\n\n请以自然聊天的方式了解更多细节，例如：\n- 当前在做什么任务（任务追踪栏里显示的任务名）\n- 在哪个区域或地图\n- 遇到了什么困难，或者想了解什么\n\n获取到具体信息后，再次调用 loki_shadow_query 搜索。\n注意：不要机械地提问，像朋友聊天一样自然带出，比如"你现在是在做主线还是支线呀？"、"这个地方看着挺复杂的，你是卡在哪一步了？"`;
                }
            } else if (sessionCtx) {
                const ctxSummary = sessionCtx.getSummary();
                if (ctxSummary) {
                    log.substep('Step3.5', '会话记忆', ctxSummary.replace(/\n/g, ' | '));
                }
            }

            // ========== Step 4: 信息下载（5源异步并行）==========
            log.step('Step4:信息下载', 'start', '从5个来源异步并行下载: 游民星空 | B站 | TapTap | NGA | 米游社');

            let sourceResults = await this._fetchAllSources(log, gameName, effectiveQuery);

            let sourceNames = { local: '本地攻略库', gamersky: '游民星空', bilibili: 'B站', taptap: 'TapTap', nga: 'NGA', miyoushe: '米游社' };
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
                    return await this._generateAndReturn(log, gameName, query, selectedContent, selectedFile.fileName, sessionCtx);
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
                sourceTexts.local = `文件：${existingGuideAsSource.name}\n${existingGuideAsSource.content}`;
                log.substep('Step5', '本地攻略', `并入攻略库已有内容: ${existingGuideAsSource.name}`);
            }

            if (sourceResults.gamersky) {
                sourceTexts.gamersky = `标题：${sourceResults.gamersky.title}\n${sourceResults.gamersky.content}`;
                sourceUrls.push({ type: 'gamersky', url: sourceResults.gamersky.url });
            }
            if (sourceResults.bilibili) {
                sourceTexts.bilibili = sourceResults.bilibili.summary;
                sourceUrls.push({ type: 'bilibili', url: sourceResults.bilibili.url || `https://www.bilibili.com/video/${sourceResults.bilibili.bvid}` });
            }
            if (sourceResults.taptap) {
                sourceTexts.taptap = `标题：${sourceResults.taptap.title}\n${sourceResults.taptap.content}`;
                sourceUrls.push({ type: 'taptap', url: sourceResults.taptap.url });
            }
            if (sourceResults.nga) {
                sourceTexts.nga = `标题：${sourceResults.nga.title}\n${sourceResults.nga.content}`;
                sourceUrls.push({ type: 'nga', url: sourceResults.nga.url });
            }
            if (sourceResults.miyoushe) {
                sourceTexts.miyoushe = `标题：${sourceResults.miyoushe.title}\n${sourceResults.miyoushe.content}`;
                sourceUrls.push({ type: 'miyoushe', url: sourceResults.miyoushe.url });
            }

            let combinedContent;
            try {
                combinedContent = await this.agent.combineAndSummarize(gameName, query, sourceTexts);
                log.substep('Step5', 'Agent整合', `整合完成 (${this.agent.getActiveAgentName()})，长度: ${combinedContent.length}`);
            } catch (err) {
                log.error('Step5:内容整合', err);
                combinedContent = '';
                for (const [key, label] of Object.entries(sourceNames)) {
                    if (sourceTexts[key]) {
                        combinedContent += `【${label}】\n${sourceTexts[key].substring(0, 6000)}\n\n`;
                    }
                }
            }

            let tags;
            try {
                tags = await this.agent.generateTags(gameName, query, combinedContent);
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
            return await this._generateAndReturn(log, gameName, query, combinedContent, `[${tags.join('_')}]`, sessionCtx);

        } catch (err) {
            log.error('未预期异常', err);
            return `【洛基之影 · 系统错误】执行过程中发生异常: ${err.message}\n\n建议使用 web_search 工具联网搜索获取攻略信息。`;
        }
    }

    /**
     * Step 6 + Step 7：生成最终答案并返回
     * @param {import('./session-context').GameSessionContext} [sessionCtx]
     */
    async _generateAndReturn(log, gameName, query, content, sourceName, sessionCtx = null) {
        log.step('Step6:生成答案', 'start', `用 ${this.agent.getActiveAgentName()} 生成最终答案...`);

        try {
            let contextPrefix = '';
            if (sessionCtx) {
                const summary = sessionCtx.getSummary();
                if (summary) {
                    contextPrefix = `【玩家当前游戏进度】\n${summary}\n\n`;
                }
            }
            const answer = await this.agent.generateAnswer(query, contextPrefix + content, sourceName);

            if (!answer || answer.includes('未找到相关信息')) {
                log.step('Step6:生成答案', 'fail', '攻略内容无法回答该问题');
                log.step('Step7:返回结果', 'ok', '建议使用网络搜索');
                return `【洛基之影 · 攻略库无法解答】攻略库中的内容不足以回答 "${query}"。\n\n建议使用 web_search 工具联网搜索 "${gameName} ${query}" 获取最新信息。`;
            }

            log.step('Step6:生成答案', 'ok', `答案长度: ${answer.length}`);
            log.step('Step7:返回结果', 'ok', '查询完成');

            const summary = log.getSummary();
            try {
                const { logToTerminal } = require('../../../js/api-utils.js');
                logToTerminal('info', `🗡️ [洛基之影] 执行摘要:\n${summary}`);
            } catch {
                console.log(summary);
            }

            return `【${gameName} 攻略】${query}\n\n来源：${sourceName}\n\n${answer}\n\n---\n【提示】以上信息来自攻略库和有限的爬虫来源，可能不完整。如果你觉得信息不足以支撑聊天，建议补充调用 web_search 工具搜索 "${gameName} ${query}" 获取更全面的信息。`;

        } catch (err) {
            log.error('Step6:生成答案', err);
            log.step('Step7:返回结果', 'fail', '答案生成失败');
            return `【洛基之影 · 答案生成失败】${err.message}\n\n建议使用 web_search 工具联网搜索 "${gameName} ${query}"。`;
        }
    }

    // ========== 并行下载所有来源 ==========

    async _fetchAllSources(log, gameName, searchQuery) {
        const downloadTasks = [
            this._fetchGamersky(log, gameName, searchQuery),
            this._fetchBilibili(log, gameName, searchQuery),
            this._fetchTapTap(log, gameName, searchQuery),
            this._fetchNGA(log, gameName, searchQuery),
            this._fetchMiyoushe(log, gameName, searchQuery)
        ];

        const settled = await Promise.allSettled(downloadTasks);

        return {
            gamersky: settled[0].status === 'fulfilled' ? settled[0].value : null,
            bilibili: settled[1].status === 'fulfilled' ? settled[1].value : null,
            taptap:   settled[2].status === 'fulfilled' ? settled[2].value : null,
            nga:      settled[3].status === 'fulfilled' ? settled[3].value : null,
            miyoushe: settled[4].status === 'fulfilled' ? settled[4].value : null
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
        log.substep('Step4', 'B站:搜索', `关键词: "${gameName} ${query}"`);

        try {
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

            log.substep('Step4', 'B站:获取信息', `BV: ${selectedVideo.bvid}`);
            const summary = await getVideoSummary(selectedVideo.bvid);
            log.substep('Step4', 'B站:完成', `总结长度: ${summary.length}`);
            return { bvid: selectedVideo.bvid, title: selectedVideo.title, summary, url: videoUrl };
        } catch (err) {
            log.substep('Step4', 'B站:失败', err.message);
            return null;
        }
    }

    async _fetchTapTap(log, gameName, query) {
        log.substep('Step4', 'TapTap:搜索', `游戏: "${gameName}", 问题: "${query}"`);

        try {
            const guides = await searchTapTapGuides(gameName, query, this.taptapLimit);
            if (!guides || guides.length === 0) {
                log.substep('Step4', 'TapTap:结果', '未找到');
                return null;
            }

            const guide = guides[0];

            const dup = this.library.checkDuplicateSource(guide.url);
            if (dup.exists) {
                log.substep('Step4', 'TapTap:去重', `已有: ${dup.filePath}`);
                const cached = this.library.readFile(dup.filePath, this.maxContentLength);
                if (cached) return { title: guide.title, content: cached, url: guide.url, fromCache: true };
            }

            log.substep('Step4', 'TapTap:完成', `${guide.title} (${guide.content.length}字)`);
            return guide;
        } catch (err) {
            log.substep('Step4', 'TapTap:失败', err.message);
            return null;
        }
    }

    async _fetchNGA(log, gameName, query) {
        log.substep('Step4', 'NGA:搜索', `游戏: "${gameName}", 问题: "${query}"`);

        try {
            const guides = await searchNGAGuides(gameName, query, this.ngaLimit);
            if (!guides || guides.length === 0) {
                log.substep('Step4', 'NGA:结果', '未找到');
                return null;
            }

            const guide = guides[0];

            const dup = this.library.checkDuplicateSource(guide.url);
            if (dup.exists) {
                log.substep('Step4', 'NGA:去重', `已有: ${dup.filePath}`);
                const cached = this.library.readFile(dup.filePath, this.maxContentLength);
                if (cached) return { title: guide.title, content: cached, url: guide.url, fromCache: true };
            }

            log.substep('Step4', 'NGA:完成', `${guide.title} (${guide.content.length}字)`);
            return guide;
        } catch (err) {
            log.substep('Step4', 'NGA:失败', err.message);
            return null;
        }
    }

    async _fetchMiyoushe(log, gameName, query) {
        log.substep('Step4', '米游社:搜索', `游戏: "${gameName}", 问题: "${query}"`);

        try {
            const guides = await searchMiyousheGuides(gameName, query, this.miyousheLimit);
            if (!guides || guides.length === 0) {
                log.substep('Step4', '米游社:结果', '未找到（可能不是米哈游系游戏）');
                return null;
            }

            const guide = guides[0];

            const dup = this.library.checkDuplicateSource(guide.url);
            if (dup.exists) {
                log.substep('Step4', '米游社:去重', `已有: ${dup.filePath}`);
                const cached = this.library.readFile(dup.filePath, this.maxContentLength);
                if (cached) return { title: guide.title, content: cached, url: guide.url, fromCache: true };
            }

            log.substep('Step4', '米游社:完成', `${guide.title} (${guide.content.length}字)`);
            return guide;
        } catch (err) {
            log.substep('Step4', '米游社:失败', err.message);
            return null;
        }
    }
}

module.exports = { Orchestrator };
