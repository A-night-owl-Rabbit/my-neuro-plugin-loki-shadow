/**
 * 洛基之影 - 米游社爬虫
 * 通过米游社 Web API 获取米哈游系游戏攻略
 * 仅覆盖：原神、星铁、绝区零、崩坏3、未定事件簿
 */

const { fetchWithRetry, sleep } = require('./retry-utils');

const MIYOUSHE_HEADERS = {
    'Referer': 'https://www.miyoushe.com/',
    'Origin': 'https://www.miyoushe.com',
    'Accept': 'application/json'
};

const MIYOUSHE_GAMES = {
    '原神':         { gids: 2, forum_id: 43, prefix: 'ys' },
    '崩坏星穹铁道': { gids: 6, forum_id: 61, prefix: 'sr' },
    '星穹铁道':     { gids: 6, forum_id: 61, prefix: 'sr' },
    '星铁':         { gids: 6, forum_id: 61, prefix: 'sr' },
    '绝区零':       { gids: 8, forum_id: 65, prefix: 'zzz' },
    '崩坏3':        { gids: 1, forum_id: 14, prefix: 'bh3' },
    '崩坏学园2':    { gids: 3, forum_id: 51, prefix: 'bh2' },
    '未定事件簿':   { gids: 4, forum_id: 60, prefix: 'wd' },
};

function resolveGame(gameName) {
    if (MIYOUSHE_GAMES[gameName]) return MIYOUSHE_GAMES[gameName];
    for (const [key, config] of Object.entries(MIYOUSHE_GAMES)) {
        if (gameName.includes(key) || key.includes(gameName)) return config;
    }
    return null;
}

async function miyousheGet(url) {
    const resp = await fetchWithRetry(url, {
        maxRetries: 3,
        timeout: 15000,
        headers: MIYOUSHE_HEADERS
    });

    const data = resp.data;
    if (data.retcode !== 0) {
        throw new Error(`米游社 API 错误: ${data.message} (code: ${data.retcode})`);
    }
    return data.data;
}

/**
 * 获取攻略版块帖子列表
 */
async function getForumPosts(forumId, gids, isGood = false, pageSize = 20) {
    const url = `https://bbs-api.miyoushe.com/post/wapi/getForumPostList?forum_id=${forumId}&gids=${gids}&is_good=${isGood}&is_hot=false&page_size=${pageSize}&sort_type=2`;
    const data = await miyousheGet(url);

    return (data?.list || []).map(item => {
        const post = item.post || {};
        const stat = item.stat || {};
        return {
            post_id: post.post_id,
            title: post.subject || '',
            views: stat.view_num || 0,
            likes: stat.like_num || 0,
            view_type: post.view_type || 0
        };
    }).filter(p => p.post_id);
}

/**
 * 获取推荐内容（质量更高的帖子）
 */
async function getRecommendedPosts(gids, pageSize = 20) {
    const url = `https://bbs-api-static.miyoushe.com/apihub/wapi/webHome?gids=${gids}&page=1&page_size=${pageSize}`;
    const resp = await fetchWithRetry(url, {
        maxRetries: 2,
        timeout: 15000,
        headers: MIYOUSHE_HEADERS
    });

    const data = resp.data;
    if (data.retcode !== 0) return [];

    return (data.data?.recommended_posts || []).map(item => {
        const post = item.post || {};
        const stat = item.stat || {};
        return {
            post_id: post.post_id,
            title: post.subject || '',
            views: stat.view_num || 0,
            likes: stat.like_num || 0,
            view_type: post.view_type || 0
        };
    }).filter(p => p.post_id);
}

/**
 * 获取帖子完整内容
 */
async function getPostContent(postId, prefix) {
    const url = `https://bbs-api.miyoushe.com/post/wapi/getPostFull?post_id=${postId}`;
    const data = await miyousheGet(url);

    const postWrapper = data?.post || {};
    const post = postWrapper.post || {};
    const stat = postWrapper.stat || {};

    const title = post.subject || '';
    const htmlContent = post.content || '';
    const structuredContent = post.structured_content || '';

    let textContent = '';

    if (structuredContent) {
        try {
            textContent = parseQuillDelta(structuredContent);
        } catch {}
    }

    if (!textContent || textContent.length < 30) {
        textContent = parseHtmlContent(htmlContent);
    }

    return {
        title,
        content: textContent,
        url: `https://www.miyoushe.com/${prefix || 'ys'}/article/${postId}`,
        views: stat.view_num || 0,
        likes: stat.like_num || 0
    };
}

function parseQuillDelta(json) {
    let ops;
    try {
        ops = typeof json === 'string' ? JSON.parse(json) : json;
    } catch {
        return '';
    }
    if (!Array.isArray(ops)) return '';

    let text = '';
    for (const op of ops) {
        if (typeof op.insert === 'string') {
            text += op.insert;
        } else if (op.insert && typeof op.insert === 'object') {
            if (op.insert.link_card) {
                text += `[${op.insert.link_card.title || '链接'}] `;
            }
            if (op.insert.divider) {
                text += '\n---\n';
            }
        }
    }
    return text.replace(/\n{3,}/g, '\n\n').trim();
}

function parseHtmlContent(html) {
    if (!html) return '';
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<img[^>]*>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * 米游社攻略搜索主入口
 */
async function searchMiyousheGuides(gameName, query, limit = 1) {
    const gameConfig = resolveGame(gameName);
    if (!gameConfig) return [];

    let allPosts = [];

    // 并行获取精华帖、最新帖和推荐帖，增大覆盖面
    const [goodResult, normalResult, recResult] = await Promise.allSettled([
        getForumPosts(gameConfig.forum_id, gameConfig.gids, true, 30),
        getForumPosts(gameConfig.forum_id, gameConfig.gids, false, 30),
        getRecommendedPosts(gameConfig.gids, 20)
    ]);

    if (goodResult.status === 'fulfilled') allPosts.push(...goodResult.value);
    if (normalResult.status === 'fulfilled') allPosts.push(...normalResult.value);
    if (recResult.status === 'fulfilled') allPosts.push(...recResult.value);

    if (allPosts.length === 0) return [];

    // 去重
    const seen = new Set();
    allPosts = allPosts.filter(p => {
        if (seen.has(p.post_id)) return false;
        seen.add(p.post_id);
        return true;
    });

    // 按标题关键词评分，优先文字类帖子 (view_type=1)
    const queryLower = query.toLowerCase();
    const keywords = queryLower.split(/[\s,，。、]+/).filter(k => k.length >= 2);

    const scored = allPosts.map(p => {
        const titleLower = (p.title || '').toLowerCase();
        const matchCount = keywords.filter(k => titleLower.includes(k)).length;
        const typeBonus = (p.view_type === 1) ? 0.5 : 0;
        const viewBonus = Math.min(p.views / 10000, 1);
        return { ...p, score: matchCount + typeBonus + viewBonus };
    });
    scored.sort((a, b) => b.score - a.score);

    // 优先取标题匹配的，其次取热度高的文字帖
    let bestPosts = scored.filter(p => p.score >= 1).slice(0, limit + 2);
    if (bestPosts.length === 0) {
        bestPosts = scored.filter(p => p.view_type === 1).slice(0, limit + 2);
    }
    if (bestPosts.length === 0 && scored.length > 0) {
        bestPosts = scored.slice(0, limit + 2);
    }

    const results = [];
    for (const post of bestPosts) {
        try {
            const detail = await getPostContent(post.post_id, gameConfig.prefix);
            if (detail.content && detail.content.length > 20) {
                results.push(detail);
                if (results.length >= limit) break;
            }
            await sleep(500);
        } catch (err) {
            console.log(`[米游社] 获取帖子 ${post.post_id} 失败: ${err.message}`);
        }
    }

    return results;
}

module.exports = { searchMiyousheGuides, resolveGame };
