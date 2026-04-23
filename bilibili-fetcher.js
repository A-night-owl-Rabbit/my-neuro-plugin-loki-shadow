/**
 * 洛基之影 - B站视频获取 v2.1
 * 通过 global.pluginManager 调用 bilibili-tools 插件注册的工具
 *
 * v2.1 改动：
 * - 新增 checkBiliLogin()：调用前先检查 B 站登录状态
 * - 新增 getVideoContent()：优先字幕获取，降级用最快 whisper 模型（tiny）转录
 * - 保留 getVideoSummary() 兼容旧调用
 */

/**
 * 从工具结果中提取文本内容
 */
function extractContent(result) {
    if (typeof result === 'string') return result;
    if (Array.isArray(result)) {
        return result.map(r => r.content || JSON.stringify(r)).join('\n');
    }
    if (result && result.content) return result.content;
    return JSON.stringify(result);
}

// ========== 登录检查 ==========

/**
 * 检查 B 站是否已登录。
 * 通过尝试加载 bilibili-tools 的凭证模块来判断登录状态。
 * @returns {Promise<{ loggedIn: boolean, message: string }>}
 */
async function checkBiliLogin() {
    try {
        // 尝试引入 bilibili-tools 的凭证模块
        const biliCredential = require('../bilibili-tools/bili-credential.js');
        const biliApi = require('../bilibili-tools/bili-api.js');

        const credential = biliApi.getCredential();
        if (!credential) {
            return {
                loggedIn: false,
                message: '【B站未登录】未找到 B 站登录凭证。请让用户调用 login_bilibili_by_qrcode 工具扫码登录后再使用 B 站功能。'
            };
        }

        // 快速检查凭证是否有核心字段
        if (!credential.SESSDATA || !credential.bili_jct || !credential.DedeUserID) {
            return {
                loggedIn: false,
                message: '【B站未登录】B 站登录凭证不完整。请让用户调用 login_bilibili_by_qrcode 工具重新扫码登录。'
            };
        }

        return {
            loggedIn: true,
            message: `B站凭证有效 (UID: ${credential.DedeUserID})`
        };
    } catch (err) {
        // 无法加载凭证模块，可能 bilibili-tools 插件未安装
        console.log(`[洛基之影·B站] 凭证检查失败: ${err.message}`);
        return {
            loggedIn: false,
            message: '【B站不可用】无法加载 bilibili-tools 插件凭证模块，请确认插件已安装且启用。'
        };
    }
}

// ========== 搜索相关 ==========

/**
 * 多语义并发搜索：将 query 按空格拆分为独立关键词，
 * 每个关键词与 gameName 组合后并发搜索 B站，合并去重全部结果。
 */
function _buildSearchQueries(gameName, query) {
    const keywords = query.split(/\s+/).filter(k => k.length > 0);
    const queries = [];

    for (const kw of keywords) {
        const q = `${gameName} ${kw}`.trim();
        if (!queries.includes(q)) queries.push(q);
    }

    const full = `${gameName} ${query}`.trim();
    if (!queries.includes(full)) queries.push(full);

    if (!queries.includes(gameName)) queries.push(gameName);

    return queries;
}

/**
 * 尝试从搜索结果中解析出视频列表
 */
function _parseSearchResult(rawResult) {
    if (!rawResult || rawResult === 'null' || rawResult === 'undefined') return null;

    try {
        const parsed = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
        if (!parsed || typeof parsed !== 'object') return null;
        if (parsed.videos && Array.isArray(parsed.videos)) return parsed.videos;
        if (Array.isArray(parsed)) return parsed.length > 0 ? parsed : null;
        if (parsed.result && Array.isArray(parsed.result)) return parsed.result;
    } catch {}

    return null;
}

async function _doSearch(keyword, limit) {
    if (!global.pluginManager) {
        console.log('[洛基之影·B站] pluginManager 不可用，请确认插件系统已正常初始化');
        return [];
    }

    try {
        const result = await global.pluginManager.executeTool('search_bilibili_video', { keyword, limit });
        const rawResult = extractContent(result);
        const videos = _parseSearchResult(rawResult);
        if (!videos && rawResult) {
            console.log(`[洛基之影·B站] 搜索返回无法解析: ${String(rawResult).substring(0, 120)}`);
        }
        return videos || [];
    } catch (err) {
        console.log(`[洛基之影·B站] 搜索调用异常: ${err.message}`);
        return [];
    }
}

/**
 * 搜索B站视频（多语义并发搜索 + 合并去重）
 */
async function searchVideo(gameName, query, limit = 3) {
    const searchQueries = _buildSearchQueries(gameName, query);

    console.log(`[洛基之影·B站] 多语义并发搜索，共 ${searchQueries.length} 组: ${searchQueries.map(q => `"${q}"`).join(', ')}`);

    const searchPromises = searchQueries.map(q => _doSearch(q, limit));
    const allResults = await Promise.all(searchPromises);

    const seen = new Set();
    const merged = [];
    for (let i = 0; i < allResults.length; i++) {
        for (const video of allResults[i]) {
            if (video.bvid && !seen.has(video.bvid)) {
                seen.add(video.bvid);
                merged.push(video);
            }
        }
    }

    console.log(`[洛基之影·B站] 合并去重后共 ${merged.length} 条候选视频`);
    return merged;
}

// ========== 视频内容获取（字幕优先 + 快速转录降级）==========

/**
 * 获取B站视频内容 - 字幕优先策略
 *
 * 策略：
 * 1. 优先通过 get_bilibili_video_comprehensive_info 获取（内部已实现字幕优先 → whisper 降级）
 * 2. 强制使用最快的 whisper 模型 (tiny) 降级，减少转录耗时
 *
 * @param {string} bvid - BV号
 * @returns {Promise<{ text: string, source: string, needLogin?: boolean, message?: string }>}
 */
async function getVideoContent(bvid) {
    if (!global.pluginManager) {
        return {
            text: '',
            source: 'error',
            needLogin: false,
            message: 'pluginManager 不可用，请确认插件系统已正常初始化'
        };
    }

    try {
        // 使用 tiny 模型（最快）作为 whisper 降级方案
        // bilibili-tools 内部流程：字幕(bilibili-api-python) → whisper(tiny) → AI总结
        const result = await global.pluginManager.executeTool('get_bilibili_video_comprehensive_info', {
            bvid,
            model_size: 'tiny'  // 强制使用最快的 whisper 模型
        });
        const rawResult = extractContent(result);

        if (!rawResult) {
            return {
                text: '',
                source: 'error',
                message: `视频内容获取失败 (${bvid}): 返回为空`
            };
        }

        // 检查是否是登录相关的错误
        const rawStr = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
        if (rawStr.includes('未登录') || rawStr.includes('登录失效') || rawStr.includes('-101')) {
            return {
                text: '',
                source: 'error',
                needLogin: true,
                message: '【B站登录失效】获取视频内容时发现登录已失效。请让用户调用 login_bilibili_by_qrcode 工具扫码重新登录。'
            };
        }

        // 判断内容来源
        let source = '综合信息';
        if (rawStr.includes('CC字幕') || rawStr.includes('CC 字幕')) {
            source = 'CC字幕';
        } else if (rawStr.includes('Whisper') || rawStr.includes('语音转录')) {
            source = 'Whisper语音转录(tiny)';
        }

        return {
            text: rawStr,
            source
        };
    } catch (err) {
        return {
            text: '',
            source: 'error',
            message: `视频内容获取失败 (${bvid}): ${err.message}`
        };
    }
}

/**
 * 获取B站视频综合信息（兼容旧接口）
 * @param {string} bvid - BV号
 * @returns {Promise<string>} 视频综合信息文本
 */
async function getVideoSummary(bvid) {
    const result = await getVideoContent(bvid);
    if (result.needLogin) {
        throw new Error(result.message);
    }
    if (!result.text) {
        throw new Error(result.message || `B站视频信息获取失败 (${bvid})`);
    }
    return result.text;
}

module.exports = { checkBiliLogin, searchVideo, getVideoContent, getVideoSummary };
