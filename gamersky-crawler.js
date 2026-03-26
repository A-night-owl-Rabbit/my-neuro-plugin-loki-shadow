/**
 * 洛基之影 - 游民星空爬虫
 * 从 gamersky_server.txt 重构：搜索攻略 + 下载详情（含多页合并）
 * 不直接保存文件，返回结构化数据交由 guide-library 统一管理
 */

const axios = require('axios');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchPage(url, maxRetries = 3, timeout = 15000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const resp = await axios.get(url, {
                headers: { 'User-Agent': UA },
                timeout
            });
            return resp;
        } catch (err) {
            if (attempt === maxRetries) throw err;
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        }
    }
}

/**
 * 从搜索页 HTML 中提取攻略结果
 * @returns {Array<{title: string, url: string, type: string}>}
 */
function _extractGuidesFromPage($, limit) {
    const results = [];

    $('.Midtit').each((_, element) => {
        const $title = $(element);
        if ($title.find('.tit').text().trim() === '游戏攻略') {
            const $guideList = $title.next('ul.titlist');
            $guideList.find('li.li1').each((__, li) => {
                if (results.length >= limit) return false;
                const $item = $(li);
                const title = $item.find('.tit a').text().trim();
                const url = $item.find('.tit a').attr('href');
                if (title && url) {
                    results.push({
                        title,
                        url: url.startsWith('http') ? url : `https://www.gamersky.com${url}`,
                        type: 'guide'
                    });
                }
            });
            return false;
        }
    });

    if (results.length === 0) {
        const allLinks = [];
        $('a[href]').each((_, el) => {
            const $link = $(el);
            const title = $link.text().trim();
            const url = $link.attr('href');
                if (title && url && title.length > 3 && title.length < 100 &&
                    url.includes('gamersky.com') &&
                    !url.includes('down.gamersky.com') &&
                    !url.includes('/down/') &&
                    !url.includes('so.gamersky.com') &&
                    !url.includes('?s=') &&
                    (url.includes('/handbook/') || url.includes('/gl/') ||
                     url.includes('/content/') || url.includes('/news/') ||
                     url.match(/\/\d{6}\/\d+\.shtml/))) {
                allLinks.push({
                    title,
                    url: url.startsWith('http') ? url : `https://www.gamersky.com${url}`,
                    type: 'guide'
                });
            }
        });

        results.push(...allLinks.slice(0, limit));
    }

    return results;
}

/**
 * 生成搜索关键词降级变体（从精确到宽泛）
 * 例: "红色沙漠 采石场 攻略" → ["红色沙漠 采石场 攻略", "红色沙漠 采石场", "红色沙漠 攻略"]
 */
function _generateSearchVariants(keyword) {
    const variants = [keyword];
    const parts = keyword.split(/\s+/).filter(p => p.length > 0);

    if (parts.length >= 3) {
        variants.push(parts.slice(0, 2).join(' '));
        variants.push(`${parts[0]} 攻略`);
    } else if (parts.length === 2 && !parts[1].includes('攻略')) {
        variants.push(`${parts[0]} 攻略`);
    }

    return [...new Set(variants)];
}

/**
 * 搜索游民星空攻略（带自动关键词降级）
 * @param {string} keyword - 搜索关键词
 * @param {number} limit - 返回数量
 * @returns {Promise<Array<{title: string, url: string, type: string}>>}
 */
async function searchGuides(keyword, limit = 5) {
    const variants = _generateSearchVariants(keyword);

    for (const variant of variants) {
        const searchUrl = `https://so.gamersky.com/?s=${encodeURIComponent(variant)}`;
        const response = await fetchPage(searchUrl, 3, 10000);
        const $ = cheerio.load(response.data);
        const results = _extractGuidesFromPage($, limit);

        if (results.length > 0) {
            if (variant !== keyword) {
                console.log(`[游民星空] 原始关键词无结果，降级为 "${variant}" 后命中 ${results.length} 条`);
            }
            return results;
        }
    }

    return [];
}

/**
 * 下载攻略详情（支持多页合并）
 * @param {string} url - 攻略页面URL
 * @returns {Promise<{title: string, content: string, url: string, publishTime: string, totalPages: number}>}
 */
async function downloadGuideContent(url) {
    const normalizedUrl = url.replace(/_(\d+)\.shtml/, '.shtml');
    const firstResp = await fetchPage(normalizedUrl);
    const $first = cheerio.load(firstResp.data);

    const title = $first('.Mid2L_tit h1').text().trim() || $first('h1').first().text().trim() || '未知标题';
    const publishTime = $first('.Mid2L_tit .time').text().trim() || '未知时间';

    // 检测分页
    let maxPage = 1;
    const pageLinks = $first('div.Content_Paging ul li a');
    if (pageLinks.length > 0) {
        const pageNumbers = new Set();
        pageLinks.each((_, el) => {
            const text = $first(el).text().trim();
            const chineseMatch = text.match(/第(\d+)页/);
            if (chineseMatch) {
                pageNumbers.add(parseInt(chineseMatch[1]));
                return;
            }
            const numMatch = text.match(/^(\d+)$/);
            if (numMatch) {
                pageNumbers.add(parseInt(numMatch[1]));
                return;
            }
            const href = $first(el).attr('href') || '';
            const hrefMatch = href.match(/_(\d+)\.shtml/);
            if (hrefMatch) {
                pageNumbers.add(parseInt(hrefMatch[1]));
            }
        });
        if (pageNumbers.size > 0) maxPage = Math.max(...Array.from(pageNumbers));
    }

    // 并发下载所有页面
    const pageInfos = [];
    for (let p = 1; p <= maxPage; p++) {
        const pageUrl = p === 1 ? normalizedUrl : normalizedUrl.replace('.shtml', `_${p}.shtml`);
        pageInfos.push({ pageNumber: p, url: pageUrl });
    }

    const downloadResults = await downloadPagesInBatches(pageInfos, 5);
    downloadResults.sort((a, b) => a.pageNumber - b.pageNumber);

    let fullContent = '';
    for (const result of downloadResults) {
        if (!result.success) continue;
        try {
            const $ = cheerio.load(result.data);
            let pageContent = '';

            $('.Mid2L_con p, .Mid2L_con h2, .Mid2L_con h3').each((_, el) => {
                const text = $(el).text().trim();
                if (!text) return;
                if ($(el).is('h2, h3')) {
                    pageContent += `\n## ${text}\n\n`;
                } else {
                    pageContent += text + '\n\n';
                }
            });

            if (!pageContent) {
                $('.content p, .article-content p').each((_, el) => {
                    const text = $(el).text().trim();
                    if (text) pageContent += text + '\n\n';
                });
            }

            if (pageContent) {
                if (maxPage > 1) fullContent += `\n--- 第 ${result.pageNumber} 页 ---\n\n`;
                fullContent += pageContent;
            }
        } catch {}
    }

    fullContent = fullContent.replace(/\n\n\n+/g, '\n\n').trim();

    return { title, content: fullContent, url, publishTime, totalPages: maxPage };
}

async function downloadPagesInBatches(pages, batchSize = 5) {
    const results = [];
    for (let i = 0; i < pages.length; i += batchSize) {
        const batch = pages.slice(i, Math.min(i + batchSize, pages.length));
        const batchPromises = batch.map(async (pageInfo) => {
            try {
                const resp = await fetchPage(pageInfo.url, 3, 15000);
                return { success: true, pageNumber: pageInfo.pageNumber, data: resp.data, url: pageInfo.url };
            } catch (err) {
                return { success: false, pageNumber: pageInfo.pageNumber, error: err.message, url: pageInfo.url };
            }
        });

        const settled = await Promise.allSettled(batchPromises);
        for (const r of settled) {
            if (r.status === 'fulfilled') results.push(r.value);
        }

        if (i + batchSize < pages.length) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    return results;
}

module.exports = { searchGuides, downloadGuideContent };
