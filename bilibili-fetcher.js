/**
 * 洛基之影 - B站视频获取
 * 通过 global.localToolManager 调用 bilibili-tools 插件注册的工具
 */

/**
 * 构造标准 toolCall 对象
 */
function makeToolCall(name, params) {
    return {
        id: `call_loki_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'function',
        function: {
            name,
            arguments: JSON.stringify(params)
        }
    };
}

/**
 * 从 toolCall 结果中提取文本内容
 */
function extractContent(result) {
    if (typeof result === 'string') return result;
    if (Array.isArray(result)) {
        return result.map(r => r.content || JSON.stringify(r)).join('\n');
    }
    if (result && result.content) return result.content;
    return JSON.stringify(result);
}

/**
 * 多语义并发搜索：将 query 按空格拆分为独立关键词，
 * 每个关键词与 gameName 组合后并发搜索 B站，合并去重全部结果。
 * gameName 作为受保护的核心，始终出现在每组搜索词中。
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
 * @returns {Array|null} 视频列表，无法解析时返回 null
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
    if (!global.localToolManager || !global.localToolManager.isEnabled) {
        console.log('[洛基之影·B站] localToolManager 不可用，请确认 bilibili-tools 插件已启用');
        return [];
    }

    try {
        const toolCall = makeToolCall('search_bilibili_video', { keyword, limit });
        const result = await global.localToolManager.handleToolCalls([toolCall]);
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
 * 将 query 拆分为独立关键词，每个与 gameName 组合后并发搜索，
 * 合并所有结果按 bvid 去重，返回完整候选池供 Sub-Agent 选择。
 *
 * @param {string} gameName - 核心主题名（受保护）
 * @param {string} query - 搜索问题
 * @param {number} limit - 每组搜索的返回数量
 * @returns {Promise<Array>}
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

/**
 * 获取B站视频综合信息（含内容总结）
 * @param {string} bvid - BV号
 * @returns {Promise<string>} 视频综合信息文本
 */
async function getVideoSummary(bvid) {
    if (!global.localToolManager || !global.localToolManager.isEnabled) {
        throw new Error('B站视频信息获取失败: localToolManager 不可用，请确认 bilibili-tools 插件已启用');
    }

    try {
        const toolCall = makeToolCall('get_bilibili_video_comprehensive_info', { bvid });
        const result = await global.localToolManager.handleToolCalls([toolCall]);
        const rawResult = extractContent(result);

        if (!rawResult) {
            throw new Error(`B站视频信息获取失败 (${bvid}): 返回为空`);
        }

        return typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
    } catch (err) {
        throw new Error(`B站视频信息获取失败 (${bvid}): ${err.message}`);
    }
}

module.exports = { searchVideo, getVideoSummary };
