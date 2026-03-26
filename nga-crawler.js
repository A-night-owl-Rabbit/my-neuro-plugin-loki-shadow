/**
 * 洛基之影 - NGA 论坛爬虫
 * 通过 ngabbs.com app_api 获取游戏攻略帖
 * 覆盖面最广的硬核游戏社区
 */

const { postWithRetry, sleep } = require('./retry-utils');

const NGA_BASE = 'https://ngabbs.com/app_api.php';

const NGA_GAME_FORUMS = {
    '原神': 650,
    '鸣潮': 854,
    '崩坏星穹铁道': 818,
    '星穹铁道': 818,
    '星铁': 818,
    '绝区零': 853,
    '崩坏3': 549,
    '崩坏学园2': 550,
    '明日方舟': -34587507,
    '黑神话': 510472,
    '黑神话悟空': 510472,
    '怪物猎人': 489,
    '怪物猎人荒野': 489,
    '艾尔登法环': 831,
    '王者荣耀': 516,
    '最终幻想14': -362960,
    '无限暖暖': 510373,
    '流放之路': 510481,
    '塞尔达': 510397,
    '红色沙漠': 414,
};

function resolveForumId(gameName) {
    if (NGA_GAME_FORUMS[gameName]) return NGA_GAME_FORUMS[gameName];
    for (const [key, fid] of Object.entries(NGA_GAME_FORUMS)) {
        if (gameName.includes(key) || key.includes(gameName)) return fid;
    }
    return null;
}

function ngaHeaders() {
    return {
        'X-User-Agent': 'NGA_skull/6.0.5(iPhone10,3;iOS 12.0.1)',
        'Cookie': `guestJs=${Math.floor(Date.now() / 1000)};`
    };
}

/**
 * NGA App API POST 请求
 */
async function ngaPost(lib, act, params = {}) {
    const url = `${NGA_BASE}?__lib=${lib}&__act=${act}`;
    const formData = new URLSearchParams(params).toString();

    const resp = await postWithRetry(url, formData, {
        maxRetries: 3,
        timeout: 15000,
        headers: ngaHeaders(),
        contentType: 'application/x-www-form-urlencoded'
    });

    return resp.data;
}

/**
 * 搜索帖子（fid 为 null 时进行全站搜索）
 */
async function searchThreads(fid, keyword, limit = 5) {
    const params = { key: keyword };
    if (fid != null) params.fid = String(fid);
    const data = await ngaPost('subject', 'search', params);

    let threads = data.result?.data;
    if (!threads) return [];

    if (!Array.isArray(threads)) {
        threads = Object.values(threads).filter(v => v && typeof v === 'object' && v.tid);
    }

    return threads.slice(0, limit).map(t => ({
        tid: t.tid,
        title: cleanNgaText(t.subject || ''),
        author: t.author || '',
        replies: t.replies || 0,
        url: `https://bbs.nga.cn/read.php?tid=${t.tid}`
    }));
}

/**
 * 获取帖子内容
 */
async function getThreadContent(tid, maxPages = 1) {
    const allPosts = [];

    for (let page = 1; page <= maxPages; page++) {
        const data = await ngaPost('post', 'list', { tid: String(tid), page: String(page) });

        // NGA post/list 返回格式: result: { '0': post, '1': post, ... }
        // 帖子在 result 的数字键中，不是在 result.data 里
        const resultObj = data.result || {};
        let posts = [];

        if (Array.isArray(resultObj.data)) {
            posts = resultObj.data;
        } else {
            // 提取所有数字键对应的对象（即楼层内容）
            for (const key of Object.keys(resultObj)) {
                const val = resultObj[key];
                if (val && typeof val === 'object' && (val.content || val.subject)) {
                    posts.push(val);
                }
            }
        }

        if (posts.length === 0 && page > 1) break;
        allPosts.push(...posts);

        const totalPage = resultObj.__PAGE || resultObj.__T__ROWS_PAGE || resultObj.totalPage || data.totalPage || 1;
        if (page >= totalPage || page >= maxPages) break;
        await sleep(800);
    }

    let content = '';
    let title = '';

    for (const post of allPosts) {
        if (!title && post.subject) {
            title = cleanNgaText(post.subject);
        }
        if (post.content) {
            content += cleanNgaBBCode(post.content) + '\n\n';
        }
    }

    return {
        title,
        content: content.replace(/\n{3,}/g, '\n\n').trim()
    };
}

function cleanNgaBBCode(text) {
    if (!text) return '';
    return text
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/\[img\].*?\[\/img\]/gi, '')
        .replace(/\[url=([^\]]*)\](.*?)\[\/url\]/gi, '$2')
        .replace(/\[url\](.*?)\[\/url\]/gi, '$1')
        .replace(/\[b\](.*?)\[\/b\]/gi, '**$1**')
        .replace(/\[u\](.*?)\[\/u\]/gi, '$1')
        .replace(/\[i\](.*?)\[\/i\]/gi, '$1')
        .replace(/\[quote\]([\s\S]*?)\[\/quote\]/gi, '> $1\n')
        .replace(/\[collapse=([^\]]*)\]([\s\S]*?)\[\/collapse\]/gi, '\n【$1】\n$2\n')
        .replace(/\[color=[^\]]*\](.*?)\[\/color\]/gi, '$1')
        .replace(/\[size=[^\]]*\](.*?)\[\/size\]/gi, '$1')
        .replace(/\[align=[^\]]*\]([\s\S]*?)\[\/align\]/gi, '$1')
        .replace(/\[list\]([\s\S]*?)\[\/list\]/gi, '$1')
        .replace(/\[\*\]/gi, '• ')
        .replace(/\[pid=[^\]]*\].*?\[\/pid\]/gi, '')
        .replace(/\[uid=[^\]]*\].*?\[\/uid\]/gi, '')
        .replace(/\[tid=[^\]]*\].*?\[\/tid\]/gi, '')
        .replace(/\[s\](.*?)\[\/s\]/gi, '')
        .replace(/\[del\](.*?)\[\/del\]/gi, '')
        .replace(/\[table\]([\s\S]*?)\[\/table\]/gi, '$1')
        .replace(/\[tr\]([\s\S]*?)\[\/tr\]/gi, '$1\n')
        .replace(/\[td\]([\s\S]*?)\[\/td\]/gi, '$1 | ')
        .replace(/\[\/?\w+[^\]]*\]/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function cleanNgaText(text) {
    if (!text) return '';
    return text.replace(/<[^>]+>/g, '').replace(/\[\/?\w+[^\]]*\]/g, '').trim();
}

/**
 * 生成 NGA 搜索降级关键词列表
 * NGA 搜索对多关键词匹配非常严格，需要逐步精简
 */
function _ngaSearchVariants(gameName, query) {
    const variants = [];
    const coreWords = query.replace(/攻略|流程|打法|怎么[打做过]|指南|教程|心得/g, '').trim();

    variants.push(query);
    if (coreWords && coreWords !== query) variants.push(coreWords);

    const parts = coreWords.split(/[\s,，。、]+/).filter(p => p.length >= 2);
    if (parts.length > 1) {
        parts.forEach(p => variants.push(p));
    }

    variants.push(gameName + ' 攻略');

    return [...new Set(variants.filter(v => v.length > 0))];
}

/**
 * NGA 攻略搜索主入口（支持关键词降级 + 无版块ID全站搜索降级）
 */
async function searchNGAGuides(gameName, query, limit = 1) {
    const fid = resolveForumId(gameName);
    const variants = _ngaSearchVariants(gameName, query);

    let threads = [];

    if (fid) {
        for (const variant of variants) {
            threads = await searchThreads(fid, variant, limit + 4);
            if (threads.length > 0) break;
        }
    }

    if (threads.length === 0) {
        for (const variant of variants) {
            const globalKeyword = variant.includes(gameName) ? variant : `${gameName} ${variant}`;
            threads = await searchThreads(null, globalKeyword, limit + 4);
            if (threads.length > 0) break;
        }
    }

    if (threads.length === 0) return [];

    const results = [];
    for (const thread of threads.slice(0, limit + 1)) {
        try {
            const detail = await getThreadContent(thread.tid, 2);
            if (detail.content && detail.content.length > 30) {
                results.push({
                    title: detail.title || thread.title,
                    content: detail.content,
                    url: thread.url
                });
                if (results.length >= limit) break;
            }
            await sleep(800);
        } catch (err) {
            console.log(`[NGA] 获取帖子 ${thread.tid} 失败:`, err.message);
        }
    }

    return results;
}

module.exports = { searchNGAGuides, resolveForumId };
