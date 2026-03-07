/**
 * 洛基之影 - TapTap 攻略爬虫
 * 通过 TapTap webapiv2 JSON API 获取游戏攻略
 * 手游全品类覆盖，无需登录
 */

const crypto = require('crypto');
const { fetchWithRetry, sleep } = require('./retry-utils');

function buildXUA() {
    const uid = crypto.randomUUID();
    return encodeURIComponent(
        `V=1&PN=WebApp&LANG=zh_CN&VN_CODE=102&LOC=CN&PLT=PC&DS=Android&UID=${uid}&OS=Windows&OSV=10&DT=PC`
    );
}

const HEADERS = {
    'Accept': 'application/json',
    'Referer': 'https://www.taptap.cn/'
};

const KNOWN_GAMES = {
    '原神': 168332,
    '鸣潮': 234280,
    '崩坏星穹铁道': 229269,
    '星穹铁道': 229269,
    '星铁': 229269,
    '绝区零': 284890,
    '明日方舟': 26638,
    '王者荣耀': 13413,
    '崩坏3': 22498,
};

/**
 * 调用 TapTap webapiv2 接口
 */
async function taptapGet(apiPath) {
    const xua = buildXUA();
    const sep = apiPath.includes('?') ? '&' : '?';
    const url = `https://www.taptap.cn/webapiv2/${apiPath}${sep}X-UA=${xua}`;

    const resp = await fetchWithRetry(url, {
        maxRetries: 3,
        timeout: 15000,
        headers: HEADERS
    });

    if (!resp.data || !resp.data.success) {
        throw new Error(`TapTap API 失败: ${JSON.stringify(resp.data).substring(0, 200)}`);
    }
    return resp.data;
}

/**
 * 搜索游戏获取 app_id
 */
async function resolveGameId(gameName) {
    if (KNOWN_GAMES[gameName]) return KNOWN_GAMES[gameName];

    for (const [key, id] of Object.entries(KNOWN_GAMES)) {
        if (gameName.includes(key) || key.includes(gameName)) return id;
    }

    const result = await taptapGet(`search/v2/app?kw=${encodeURIComponent(gameName)}&from=0&limit=3`);
    const list = result.data?.list;
    if (!list || list.length === 0) return null;

    const bestMatch = list.find(item =>
        item.app?.title?.includes(gameName) || gameName.includes(item.app?.title)
    ) || list[0];

    return bestMatch.app?.id || null;
}

/**
 * 从攻略 landing 页获取 moment 列表
 * TapTap landing 结构：type=3 info_board_set（攻略分类），type=6 index（角色攻略）
 */
async function getMomentsFromLanding(appId, query) {
    const landing = await taptapGet(`game-guide/v1/landing?app_id=${appId}`);
    const sections = landing.data?.list || [];

    const allMoments = [];

    for (const section of sections) {
        // type 3: info_board_set（纳塔攻略、枫丹攻略、萌新指南等）
        if (section.type === 3 && section.info_board_set?.list) {
            for (const board of section.info_board_set.list) {
                const boardName = board.name || '';
                if (board.moments && Array.isArray(board.moments)) {
                    for (const m of board.moments) {
                        if (m.id_str) {
                            allMoments.push({
                                momentId: m.id_str,
                                boardName,
                                createdTime: m.created_time || 0
                            });
                        }
                    }
                }
                // 提取 entity-collection ID 用于后续获取更多攻略
                const collMatch = board.uri?.match(/entity-collection\?id=(\d+)/);
                if (collMatch) {
                    try {
                        const collResult = await taptapGet(
                            `game-guide/v1/guide-entity-collection-detail?id=${collMatch[1]}&from=0&limit=10`
                        );
                        const items = collResult.data?.list || [];
                        for (const item of items) {
                            const m = item.moment || item;
                            if (m.id_str) {
                                const title = m.sharing?.title || m.title || '';
                                allMoments.push({
                                    momentId: m.id_str,
                                    title,
                                    boardName,
                                    createdTime: m.created_time || 0
                                });
                            }
                        }
                        await sleep(400);
                    } catch {}
                }
            }
        }
    }

    return allMoments;
}

/**
 * 获取单篇攻略全文内容
 */
async function getGuideContent(momentId) {
    // 先尝试 moment detail，可能重定向到 topic
    let topicId = null;

    try {
        const momentResult = await taptapGet(`moment/v2/detail?id=${momentId}`);
        const mData = momentResult.data;
        if (mData?.topic?.id) {
            topicId = mData.topic.id;
        }
        // 检查重定向
        if (!topicId && momentResult.redirect?.web_url) {
            const match = momentResult.redirect.web_url.match(/\/topic\/(\d+)/);
            if (match) topicId = match[1];
        }
        // 如果 moment 本身有内容
        if (!topicId && mData?.moment?.first_post?.contents) {
            const contents = mData.moment.first_post.contents;
            const rawText = contents.raw_text || '';
            const htmlText = contents.text || '';
            const title = mData.moment?.sharing?.title || mData.moment?.title || '';
            return {
                title,
                content: cleanBBCode(rawText) || stripHtml(htmlText),
                url: `https://www.taptap.cn/moment/${momentId}`
            };
        }
    } catch {}

    // 用 topic 获取全文
    const id = topicId || momentId;
    try {
        const topic = await taptapGet(`topic/v1/detail?id=${id}`);
        const topicData = topic.data?.topic || {};
        const firstPost = topic.data?.first_post || {};

        const title = topicData.title || topicData.sharing?.title || '';
        const rawText = firstPost.contents?.raw_text || '';
        const htmlText = firstPost.contents?.text || '';
        const content = cleanBBCode(rawText) || stripHtml(htmlText);

        return {
            title,
            content,
            url: `https://www.taptap.cn/topic/${id}`
        };
    } catch {}

    return null;
}

function cleanBBCode(text) {
    if (!text) return '';
    return text
        .replace(/\[img\].*?\[\/img\]/gi, '')
        .replace(/\[url=([^\]]*)\](.*?)\[\/url\]/gi, '$2')
        .replace(/\[url\](.*?)\[\/url\]/gi, '$1')
        .replace(/\[b\](.*?)\[\/b\]/gi, '$1')
        .replace(/\[u\](.*?)\[\/u\]/gi, '$1')
        .replace(/\[i\](.*?)\[\/i\]/gi, '$1')
        .replace(/\[color=[^\]]*\](.*?)\[\/color\]/gi, '$1')
        .replace(/\[size=[^\]]*\](.*?)\[\/size\]/gi, '$1')
        .replace(/\[tapemoji=[^\]]*\]/gi, '')
        .replace(/\[hr\]/gi, '\n---\n')
        .replace(/\[\/?\w+[^\]]*\]/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<img[^>]*>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * 搜索并获取 TapTap 攻略（对外主入口）
 */
async function searchTapTapGuides(gameName, query, limit = 1) {
    const appId = await resolveGameId(gameName);
    if (!appId) return [];

    const moments = await getMomentsFromLanding(appId, query);
    if (moments.length === 0) return [];

    // 优先选标题匹配的
    const queryLower = query.toLowerCase();
    const keywords = queryLower.split(/[\s,，。、]+/).filter(k => k.length >= 2);

    const scored = moments.map(m => {
        const titleLower = (m.title || m.boardName || '').toLowerCase();
        const matchCount = keywords.filter(k => titleLower.includes(k)).length;
        return { ...m, score: matchCount };
    });
    scored.sort((a, b) => b.score - a.score || b.createdTime - a.createdTime);

    const results = [];
    for (const candidate of scored.slice(0, limit + 2)) {
        try {
            const detail = await getGuideContent(candidate.momentId);
            if (detail && detail.content && detail.content.length > 50) {
                results.push(detail);
                if (results.length >= limit) break;
            }
            await sleep(400);
        } catch {}
    }

    return results;
}

module.exports = { searchTapTapGuides, resolveGameId };
