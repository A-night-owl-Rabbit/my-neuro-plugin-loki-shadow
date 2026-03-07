/**
 * 洛基之影 - B站视频获取
 * 通过 global.localToolManager 调用已加载的 bilibili_mcp.js 工具
 * 降级方案：直接 require bilibili_mcp.js
 */

const path = require('path');

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

let _bilibiliModule = null;

function getBilibiliModule() {
    if (_bilibiliModule) return _bilibiliModule;
    try {
        _bilibiliModule = require(path.join(__dirname, '..', '..', '..', 'server-tools', 'bilibili_mcp.js'));
    } catch {
        _bilibiliModule = null;
    }
    return _bilibiliModule;
}

/**
 * 搜索B站视频
 * @param {string} keyword - 搜索关键词
 * @param {number} limit - 返回数量
 * @returns {Promise<Array<{title: string, author: string, bvid: string, play: number, duration: string, description: string}>>}
 */
async function searchVideo(keyword, limit = 3) {
    let rawResult;

    // 优先通过 localToolManager
    if (global.localToolManager && global.localToolManager.isEnabled) {
        try {
            const toolCall = makeToolCall('search_bilibili_video', { keyword, limit });
            const result = await global.localToolManager.handleToolCalls([toolCall]);
            rawResult = extractContent(result);
        } catch {}
    }

    // 降级直接调用模块
    if (!rawResult) {
        const mod = getBilibiliModule();
        if (mod) {
            rawResult = await mod.executeFunction('search_bilibili_video', { keyword, limit });
        }
    }

    if (!rawResult) {
        throw new Error('B站搜索不可用：localToolManager 和直接模块加载均失败');
    }

    // 解析结果
    try {
        const parsed = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
        if (parsed.videos && Array.isArray(parsed.videos)) {
            return parsed.videos;
        }
        if (Array.isArray(parsed)) return parsed;
    } catch {}

    return [];
}

/**
 * 获取B站视频综合信息（含内容总结）
 * @param {string} bvid - BV号
 * @returns {Promise<string>} 视频综合信息文本
 */
async function getVideoSummary(bvid) {
    let rawResult;

    if (global.localToolManager && global.localToolManager.isEnabled) {
        try {
            const toolCall = makeToolCall('get_bilibili_video_comprehensive_info', { bvid });
            const result = await global.localToolManager.handleToolCalls([toolCall]);
            rawResult = extractContent(result);
        } catch {}
    }

    if (!rawResult) {
        const mod = getBilibiliModule();
        if (mod) {
            rawResult = await mod.executeFunction('get_bilibili_video_comprehensive_info', { bvid });
        }
    }

    if (!rawResult) {
        throw new Error(`B站视频信息获取失败 (${bvid})`);
    }

    return typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
}

module.exports = { searchVideo, getVideoSummary };
