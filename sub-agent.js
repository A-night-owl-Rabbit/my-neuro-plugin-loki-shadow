/**
 * 洛基之影 - DeepSeek 下级智能体
 * 封装所有需要 LLM 推理的环节：文件选择、内容分析、答案生成、标签生成、综合整理
 */

const axios = require('axios');

class SubAgent {
    /**
     * @param {object} config - sub_agent 配置段
     * @param {string} config.api_url
     * @param {string} config.api_key
     * @param {string} config.model
     * @param {number} [config.temperature]
     * @param {number} [config.max_tokens]
     */
    constructor(config) {
        this.apiUrl = config.api_url || 'https://api.siliconflow.cn/v1';
        this.apiKey = config.api_key;
        this.model = config.model || 'deepseek-ai/DeepSeek-V3.2';
        this.temperature = config.temperature || 0.3;
        this.maxTokens = config.max_tokens || 20000;
    }

    async _call(systemPrompt, userMessage, retries = 2) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const resp = await axios.post(`${this.apiUrl}/chat/completions`, {
                    model: this.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userMessage }
                    ],
                    temperature: this.temperature,
                    max_tokens: this.maxTokens
                }, {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 120000
                });

                return resp.data.choices[0].message.content;
            } catch (err) {
                if (attempt === retries) {
                    throw new Error(`DeepSeek 调用失败 (已重试${retries}次): ${err.message}`);
                }
                await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            }
        }
    }

    /**
     * 从文件列表中选择最相关的文件
     * @returns {Promise<number>} 文件序号 (1-based)，0 表示未找到
     */
    async selectRelevantFile(gameName, query, fileList) {
        const fileListStr = fileList.map((f, i) => `${i + 1}. ${f.relativePath || f.fileName}`).join('\n');

        const system = `你是一个游戏信息检索助手。根据游戏名称和问题，从文件列表中选择最相关的文件。
规则：
1. 分析游戏名称和问题，理解用户需要什么
2. 优先选择文件名同时包含游戏名和关键词的文件
3. 只返回文件的序号（纯数字），不返回其他内容
4. 如果没有相关文件，返回 "0"`;

        const user = `游戏名称：${gameName}\n问题：${query}\n\n文件列表：\n${fileListStr}\n\n请返回最相关文件的序号：`;

        const response = await this._call(system, user);
        const num = parseInt(response.trim());
        return isNaN(num) ? 0 : num;
    }

    /**
     * 分析攻略内容是否能回答用户的问题
     * @returns {Promise<{canAnswer: boolean, confidence: string, reason: string}>}
     */
    async analyzeContent(query, content, fileName) {
        const system = `你是一个游戏攻略分析专家。判断给定的攻略内容是否能回答用户的问题。
返回JSON格式：{"canAnswer": true/false, "confidence": "high/medium/low", "reason": "判断理由"}
只返回JSON，不要其他内容。`;

        const user = `用户问题：${query}\n\n攻略文件：${fileName}\n内容摘要（前3000字）：\n${content.substring(0, 3000)}`;

        const response = await this._call(system, user);
        try {
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) return JSON.parse(jsonMatch[0]);
        } catch {}
        return { canAnswer: false, confidence: 'low', reason: '解析失败' };
    }

    /**
     * 从攻略内容生成精准答案
     */
    async generateAnswer(query, content, fileName) {
        const system = `你是一个游戏信息专家。根据用户的问题，从攻略文档中提取最相关、最实用的信息，生成精准详细的回答。

要求：
1. 直接回答问题，不要废话
2. 提取关键要点（打法技巧、注意事项、推荐配置、剧情内容等）
3. 如有具体步骤，按顺序列出
4. 内容要详细具体，进行完整转述
5. 如果内容与问题无关，说明"未找到相关信息"`;

        const user = `用户问题：${query}\n\n攻略文档（来源：${fileName}）：\n${content}`;

        return await this._call(system, user);
    }

    /**
     * 为新攻略文件生成标签
     * @returns {Promise<string[]>}
     */
    async generateTags(gameName, query, content) {
        const system = `你是一个游戏攻略标签生成专家。为攻略内容生成2-5个简短标签，用于文件名和快速检索。
要求：
1. 标签应该概括攻略的核心内容（如：Boss战、剧情、任务、角色、装备等）
2. 每个标签2-6个字
3. 返回JSON数组格式：["标签1", "标签2", "标签3"]
4. 不要包含游戏名（游戏名会单独标注）
只返回JSON数组，不要其他内容。`;

        const user = `游戏：${gameName}\n问题：${query}\n\n内容摘要：\n${content.substring(0, 2000)}`;

        const response = await this._call(system, user);
        try {
            const jsonMatch = response.match(/\[[\s\S]*\]/);
            if (jsonMatch) return JSON.parse(jsonMatch[0]);
        } catch {}
        const fallbackTags = query.split(/[\s,，。]+/).filter(w => w.length >= 2).slice(0, 3);
        return fallbackTags.length > 0 ? fallbackTags : ['攻略'];
    }

    /**
     * 从B站搜索结果中选择最匹配的视频
     * @returns {Promise<number>} 视频序号 (1-based)，0 表示无合适视频
     */
    async selectBestVideo(query, searchResults) {
        const listStr = searchResults.map((v, i) =>
            `${i + 1}. 标题: ${v.title} | UP主: ${v.author} | 播放: ${v.play} | 时长: ${v.duration}`
        ).join('\n');

        const system = `你是一个游戏视频筛选助手。从B站视频搜索结果中选择最适合回答用户问题的视频。
优先选择：攻略教程 > 剧情解说 > 游戏评测
排除：直播录像、纯娱乐、无关内容
只返回视频序号（纯数字），如果都不合适返回 "0"`;

        const user = `问题：${query}\n\n视频列表：\n${listStr}\n\n请返回最合适视频的序号：`;

        const response = await this._call(system, user);
        const num = parseInt(response.trim());
        return isNaN(num) ? 0 : num;
    }

    /**
     * 综合两个来源的内容，生成整合攻略
     */
    async combineAndSummarize(gameName, query, gamerskyContent, bilibiliSummary) {
        const system = `你是一个游戏攻略整合专家。将来自不同来源的游戏信息进行综合整理。

要求：
1. 保留所有重要细节，不要遗漏
2. 按逻辑组织内容，去除重复部分
3. 标注信息来源（[游民星空] 或 [B站视频]）
4. 内容要详细具体，将所有内容进行完整转述
5. 如有矛盾信息，同时保留并注明
6. 输出格式清晰，分段分点`;

        let user = `游戏：${gameName}\n问题：${query}\n\n`;
        if (gamerskyContent) {
            user += `=== 来源1：游民星空 ===\n${gamerskyContent.substring(0, 10000)}\n\n`;
        }
        if (bilibiliSummary) {
            user += `=== 来源2：B站视频 ===\n${bilibiliSummary.substring(0, 10000)}\n\n`;
        }
        user += '请综合整理以上信息：';

        return await this._call(system, user);
    }
}

module.exports = { SubAgent };
