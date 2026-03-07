/**
 * 洛基之影 - 游戏攻略库管理
 * 扫描、搜索、读取、写入、来源去重
 */

const fs = require('fs');
const path = require('path');

class GuideLibrary {
    /**
     * @param {string} libraryPath - 攻略库根目录
     */
    constructor(libraryPath) {
        this.libraryPath = libraryPath;
    }

    /**
     * 确保攻略库目录存在
     */
    ensureDirectory() {
        if (!fs.existsSync(this.libraryPath)) {
            fs.mkdirSync(this.libraryPath, { recursive: true });
        }
    }

    /**
     * 递归扫描攻略库中所有 txt 文件
     * @param {string} [gameName] - 可选，按游戏名过滤
     * @returns {Array<{relativePath: string, fileName: string, fullPath: string}>}
     */
    scanFiles(gameName = null) {
        const files = [];
        this._scanDir(this.libraryPath, this.libraryPath, files);

        if (gameName) {
            const nameLower = gameName.toLowerCase();
            return files.filter(f => f.fileName.toLowerCase().includes(nameLower));
        }
        return files;
    }

    _scanDir(dir, baseDir, files) {
        try {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const fullPath = path.join(dir, item);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    this._scanDir(fullPath, baseDir, files);
                } else if (item.endsWith('.txt')) {
                    files.push({
                        relativePath: path.relative(baseDir, fullPath),
                        fileName: item,
                        fullPath
                    });
                }
            }
        } catch (err) {
            // 目录不存在或无权限
        }
    }

    /**
     * 根据关键词在文件名中搜索匹配的攻略
     * @param {string} gameName - 游戏名
     * @param {string[]} keywords - 搜索关键词
     * @returns {Array<{file: object, score: number}>}
     */
    searchByTags(gameName, keywords) {
        const files = this.scanFiles(gameName);
        const scored = [];

        for (const file of files) {
            const nameLower = file.fileName.toLowerCase();
            let score = 0;
            for (const kw of keywords) {
                if (nameLower.includes(kw.toLowerCase())) {
                    score++;
                }
            }
            if (score > 0) {
                scored.push({ file, score });
            }
        }

        scored.sort((a, b) => b.score - a.score);
        return scored;
    }

    /**
     * 读取攻略文件内容
     * @param {string} fullPath - 文件完整路径
     * @param {number} [maxLength] - 最大读取长度
     * @returns {string|null}
     */
    readFile(fullPath, maxLength = 0) {
        try {
            let content = fs.readFileSync(fullPath, 'utf-8');
            if (maxLength > 0 && content.length > maxLength) {
                content = content.substring(0, maxLength) + '\n...(内容已截断)';
            }
            return content;
        } catch {
            return null;
        }
    }

    /**
     * 检查是否已存在相同来源的攻略
     * 在文件头部搜索 "来源URL" 或 "来源" 字段
     * @param {string} sourceUrl - 来源URL
     * @returns {{exists: boolean, filePath: string|null}}
     */
    checkDuplicateSource(sourceUrl) {
        if (!sourceUrl) return { exists: false, filePath: null };

        const files = this.scanFiles();
        for (const file of files) {
            try {
                const head = fs.readFileSync(file.fullPath, 'utf-8').substring(0, 2000);
                if (head.includes(sourceUrl)) {
                    return { exists: true, filePath: file.fullPath };
                }
            } catch {
                // skip unreadable files
            }
        }
        return { exists: false, filePath: null };
    }

    /**
     * 保存新攻略文件到攻略库
     * @param {object} options
     * @param {string} options.gameName - 游戏名
     * @param {string[]} options.tags - 标签列表
     * @param {string} options.content - 完整内容
     * @param {Array<{type: string, url: string}>} options.sources - 来源列表
     * @returns {string} 保存的文件路径
     */
    saveGuide({ gameName, tags, content, sources }) {
        this.ensureDirectory();

        const sourceMarker = sources.map(s => {
            if (s.type === 'gamersky') return 'GS';
            if (s.type === 'bilibili') return 'BL';
            return 'OT';
        }).join('+');

        const safeTags = tags.map(t => t.replace(/[\\/:*?"<>|\s]/g, '_')).join('_');
        const safeGame = gameName.replace(/[\\/:*?"<>|\s]/g, '_');
        const fileName = `${safeGame}_${safeTags}_${sourceMarker}.txt`;
        const filePath = path.join(this.libraryPath, fileName);

        const sourceLines = sources.map(s => `  - ${s.type}: ${s.url}`).join('\n');

        const fileContent = [
            '=== 洛基之影 · 游戏攻略 ===',
            `游戏名称：${gameName}`,
            `标签：${tags.join(', ')}`,
            `来源：`,
            sourceLines,
            `生成时间：${new Date().toLocaleString('zh-CN')}`,
            '===========================',
            '',
            content,
            '',
            '---',
            '此文件由 洛基之影 插件自动生成',
            `生成时间：${new Date().toLocaleString('zh-CN')}`
        ].join('\n');

        fs.writeFileSync(filePath, fileContent, 'utf-8');
        return filePath;
    }
}

module.exports = { GuideLibrary };
