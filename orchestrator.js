/**
 * 洛基之影 - 核心工作流编排引擎
 * 7 步流程：游戏检测 → 攻略库检索 → 内容分析 → 信息下载 → 内容整合 → 生成答案 → 返回结果
 */

const { LokiLogger } = require('./logger');
const { detectCurrentGame } = require('./window-detector');
const { GuideLibrary } = require('./guide-library');
const { SubAgent } = require('./sub-agent');
const { searchGuides, downloadGuideContent } = require('./gamersky-crawler');
const { searchVideo, getVideoSummary } = require('./bilibili-fetcher');

class Orchestrator {
    /**
     * @param {object} pluginConfig - 插件完整配置
     */
    constructor(pluginConfig) {
        this.config = pluginConfig;
        this.library = new GuideLibrary(pluginConfig.guide_library_path);
        this.agent = new SubAgent(pluginConfig.sub_agent || {});
        this.maxContentLength = pluginConfig.max_content_length || 20000;
        this.gamerskyLimit = pluginConfig.gamersky_download_limit || 1;
        this.bilibiliLimit = pluginConfig.bilibili_search_limit || 3;
    }

    /**
     * 执行完整的游戏攻略查询流程
     * @param {string|null} gameName - 游戏名（null则自动检测）
     * @param {string} query - 用户问题
     * @returns {Promise<string>} 最终答案
     */
    async execute(gameName, query) {
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
                // 用 DeepSeek 选择最相关的文件
                log.substep('Step2', 'DeepSeek选文件', `从 ${allFiles.length} 个文件中选择最相关的...`);

                try {
                    const fileIndex = await this.agent.selectRelevantFile(gameName, query, allFiles);
                    if (fileIndex > 0 && fileIndex <= allFiles.length) {
                        selectedFile = allFiles[fileIndex - 1];
                        selectedContent = this.library.readFile(selectedFile.fullPath, this.maxContentLength);
                        log.substep('Step2', '选中文件', selectedFile.fileName);
                    } else {
                        log.substep('Step2', '未命中', 'DeepSeek 判断没有相关文件');
                    }
                } catch (err) {
                    log.substep('Step2', '选择失败', err.message);
                }
            }

            log.step('Step2:攻略库检索', allFiles.length > 0 ? 'ok' : 'skip',
                selectedFile ? `选中: ${selectedFile.fileName}` : `攻略库中未找到相关文件`);

            // ========== Step 3: 内容分析 ==========
            if (selectedFile && selectedContent) {
                log.step('Step3:内容分析', 'start', '用 DeepSeek 分析内容是否能回答问题...');

                try {
                    const analysis = await this.agent.analyzeContent(query, selectedContent, selectedFile.fileName);
                    log.substep('Step3', '分析结果', `canAnswer=${analysis.canAnswer}, confidence=${analysis.confidence}, reason=${analysis.reason}`);

                    if (analysis.canAnswer && analysis.confidence !== 'low') {
                        log.step('Step3:内容分析', 'ok', '现有攻略可以回答问题，跳到 Step6 生成答案');

                        // 直接跳到 Step 6 生成答案
                        return await this._generateAndReturn(log, gameName, query, selectedContent, selectedFile.fileName);
                    } else {
                        log.step('Step3:内容分析', 'skip', `现有攻略不足以回答，原因: ${analysis.reason}，需要下载新信息`);
                    }
                } catch (err) {
                    log.error('Step3:内容分析', err);
                }
            } else {
                log.step('Step3:内容分析', 'skip', '攻略库中无相关文件，直接进入下载阶段');
            }

            // ========== Step 4: 信息下载 ==========
            log.step('Step4:信息下载', 'start', '从游民星空和B站异步并行下载...');

            let gamerskyResult = null;
            let bilibiliResult = null;

            const downloadTasks = [];

            // 4a: 游民星空下载
            downloadTasks.push(this._fetchGamersky(log, gameName, query));

            // 4b: B站下载
            downloadTasks.push(this._fetchBilibili(log, gameName, query));

            const [gsResult, blResult] = await Promise.allSettled(downloadTasks);

            if (gsResult.status === 'fulfilled') gamerskyResult = gsResult.value;
            if (blResult.status === 'fulfilled') bilibiliResult = blResult.value;

            log.step('Step4:信息下载', 'ok',
                `游民星空: ${gamerskyResult ? '成功' : '无结果'}, B站: ${bilibiliResult ? '成功' : '无结果'}`);

            // 如果两个来源都没有结果
            if (!gamerskyResult && !bilibiliResult) {
                log.step('Step4:信息下载', 'fail', '两个来源均未获取到有效内容');

                // 如果之前攻略库有文件但分析认为不够，仍然尝试用它生成答案
                if (selectedContent) {
                    log.substep('Step4', '降级策略', '使用攻略库中的现有内容尝试回答');
                    return await this._generateAndReturn(log, gameName, query, selectedContent, selectedFile.fileName);
                }

                log.step('最终结果', 'fail', '所有来源均无法获取信息');
                return `【洛基之影 · 攻略库无法解答】未能找到关于 "${gameName}" "${query}" 的攻略信息。\n\n建议使用 web_search 工具联网搜索 "${gameName} ${query}" 获取最新攻略。`;
            }

            // ========== Step 5: 内容整合 ==========
            log.step('Step5:内容整合', 'start', '综合整理多来源信息...');

            let combinedContent;
            const sources = [];
            let gamerskyText = null;
            let bilibiliText = null;

            if (gamerskyResult) {
                gamerskyText = `标题：${gamerskyResult.title}\n${gamerskyResult.content}`;
                sources.push({ type: 'gamersky', url: gamerskyResult.url });
            }
            if (bilibiliResult) {
                bilibiliText = bilibiliResult.summary;
                sources.push({ type: 'bilibili', url: bilibiliResult.url || `https://www.bilibili.com/video/${bilibiliResult.bvid}` });
            }

            try {
                combinedContent = await this.agent.combineAndSummarize(gameName, query, gamerskyText, bilibiliText);
                log.substep('Step5', 'DeepSeek整合', `整合完成，长度: ${combinedContent.length}`);
            } catch (err) {
                log.error('Step5:内容整合', err);
                // 降级：直接拼接
                combinedContent = '';
                if (gamerskyText) combinedContent += `【游民星空】\n${gamerskyText}\n\n`;
                if (bilibiliText) combinedContent += `【B站视频】\n${bilibiliText}\n\n`;
            }

            // 生成标签并保存
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
                    sources
                });
                log.substep('Step5', '文件保存', savedPath);
            } catch (err) {
                log.substep('Step5', '保存失败', err.message);
            }

            log.step('Step5:内容整合', 'ok', `已保存到攻略库，标签: ${tags.join(', ')}`);

            // ========== Step 6 & 7: 生成答案并返回 ==========
            return await this._generateAndReturn(log, gameName, query, combinedContent, `[${tags.join('_')}]`);

        } catch (err) {
            log.error('未预期异常', err);
            return `【洛基之影 · 系统错误】执行过程中发生异常: ${err.message}\n\n建议使用 web_search 工具联网搜索获取攻略信息。`;
        }
    }

    /**
     * Step 6 + Step 7：生成最终答案并返回
     */
    async _generateAndReturn(log, gameName, query, content, sourceName) {
        log.step('Step6:生成答案', 'start', '用 DeepSeek 生成最终答案...');

        try {
            const answer = await this.agent.generateAnswer(query, content, sourceName);

            if (!answer || answer.includes('未找到相关信息')) {
                log.step('Step6:生成答案', 'fail', '攻略内容无法回答该问题');
                log.step('Step7:返回结果', 'ok', '建议使用网络搜索');
                return `【洛基之影 · 攻略库无法解答】攻略库中的内容不足以回答 "${query}"。\n\n建议使用 web_search 工具联网搜索 "${gameName} ${query}" 获取最新信息。`;
            }

            log.step('Step6:生成答案', 'ok', `答案长度: ${answer.length}`);
            log.step('Step7:返回结果', 'ok', '查询完成');

            const summary = log.getSummary();
            // 日志摘要仅写入控制台，不返回给主模型
            try {
                const { logToTerminal } = require('../../../js/api-utils.js');
                logToTerminal('info', `🗡️ [洛基之影] 执行摘要:\n${summary}`);
            } catch {
                console.log(summary);
            }

            return `【${gameName} 攻略】${query}\n\n来源：${sourceName}\n\n${answer}`;

        } catch (err) {
            log.error('Step6:生成答案', err);
            log.step('Step7:返回结果', 'fail', '答案生成失败');
            return `【洛基之影 · 答案生成失败】${err.message}\n\n建议使用 web_search 工具联网搜索 "${gameName} ${query}"。`;
        }
    }

    /**
     * 从游民星空获取攻略
     */
    async _fetchGamersky(log, gameName, query) {
        log.substep('Step4', '游民星空:搜索', `关键词: "${gameName} ${query}"`);

        try {
            const guides = await searchGuides(`${gameName} ${query}`, this.gamerskyLimit);
            if (!guides || guides.length === 0) {
                log.substep('Step4', '游民星空:搜索结果', '未找到相关攻略');
                return null;
            }

            log.substep('Step4', '游民星空:搜索结果', `找到 ${guides.length} 个: ${guides.map(g => g.title).join(', ')}`);

            const guide = guides[0];

            // 检查来源去重
            const dup = this.library.checkDuplicateSource(guide.url);
            if (dup.exists) {
                log.substep('Step4', '游民星空:来源去重', `已存在相同来源: ${dup.filePath}`);
                const existingContent = this.library.readFile(dup.filePath, this.maxContentLength);
                if (existingContent) {
                    return { title: guide.title, content: existingContent, url: guide.url, publishTime: '', totalPages: 0, fromCache: true };
                }
            }

            log.substep('Step4', '游民星空:下载', `正在下载: ${guide.title}`);
            const detail = await downloadGuideContent(guide.url);
            log.substep('Step4', '游民星空:完成', `${detail.totalPages}页, ${detail.content.length}字`);

            return detail;
        } catch (err) {
            log.substep('Step4', '游民星空:失败', err.message);
            return null;
        }
    }

    /**
     * 从B站获取视频信息
     */
    async _fetchBilibili(log, gameName, query) {
        log.substep('Step4', 'B站:搜索', `关键词: "${gameName} ${query}"`);

        try {
            const videos = await searchVideo(`${gameName} ${query}`, this.bilibiliLimit);
            if (!videos || videos.length === 0) {
                log.substep('Step4', 'B站:搜索结果', '未找到相关视频');
                return null;
            }

            log.substep('Step4', 'B站:搜索结果', `找到 ${videos.length} 个: ${videos.map(v => v.title).join(', ')}`);

            // 用 DeepSeek 选择最佳视频
            let selectedVideo;
            try {
                const bestIdx = await this.agent.selectBestVideo(query, videos);
                if (bestIdx > 0 && bestIdx <= videos.length) {
                    selectedVideo = videos[bestIdx - 1];
                    log.substep('Step4', 'B站:DeepSeek选择', `选中: ${selectedVideo.title}`);
                } else {
                    selectedVideo = videos[0];
                    log.substep('Step4', 'B站:默认选择', `使用第一个: ${selectedVideo.title}`);
                }
            } catch {
                selectedVideo = videos[0];
                log.substep('Step4', 'B站:降级选择', `使用第一个: ${selectedVideo.title}`);
            }

            // 检查来源去重
            const videoUrl = `https://www.bilibili.com/video/${selectedVideo.bvid}`;
            const dup = this.library.checkDuplicateSource(selectedVideo.bvid);
            if (dup.exists) {
                log.substep('Step4', 'B站:来源去重', `已存在相同来源: ${dup.filePath}`);
                const existingContent = this.library.readFile(dup.filePath, this.maxContentLength);
                if (existingContent) {
                    return { bvid: selectedVideo.bvid, title: selectedVideo.title, summary: existingContent, url: videoUrl, fromCache: true };
                }
            }

            log.substep('Step4', 'B站:获取综合信息', `BV号: ${selectedVideo.bvid}`);
            const summary = await getVideoSummary(selectedVideo.bvid);
            log.substep('Step4', 'B站:完成', `总结长度: ${summary.length}`);

            return { bvid: selectedVideo.bvid, title: selectedVideo.title, summary, url: videoUrl };
        } catch (err) {
            log.substep('Step4', 'B站:失败', err.message);
            return null;
        }
    }
}

module.exports = { Orchestrator };
