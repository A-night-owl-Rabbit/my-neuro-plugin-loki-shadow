/**
 * 洛基之影 - 硅基流动 Embedding 召回与缓存
 *
 * 使用硅基流动 API 调用 `Qwen/Qwen3-Embedding-8B` 生成文本向量。
 * 本地只保存向量缓存与检索结果，不再依赖本地向量模型。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

class SiliconFlowEmbeddingModel {
    constructor(options = {}) {
        this.apiKey = options.apiKey || '';
        this.apiUrl = (options.apiUrl || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
        this.model = options.model || 'Qwen/Qwen3-Embedding-8B';
        this.cacheDir = options.cacheDir || path.join(__dirname, '.vector-cache');
        this.chunkSize = options.chunkSize || 420;
        this.chunkOverlap = options.chunkOverlap || 100;
        this.timeout = options.timeout || 120000;
        this.schemaVersion = options.schemaVersion || 7;
    }

    _ensureDir(dir) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    _safeFileName(name) {
        return String(name).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120) || 'vector';
    }

    _hash(text) {
        return crypto.createHash('sha1').update(`${this.model}\n${String(text)}`).digest('hex');
    }

    _cachePath(kind, text) {
        const dir = path.join(this.cacheDir, kind);
        this._ensureDir(dir);
        return path.join(dir, `${this._safeFileName(this._hash(text))}.json`);
    }

    _readCachedVector(cachePath) {
        if (!fs.existsSync(cachePath)) return null;
        try {
            const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
            return Array.isArray(cached?.vector) ? cached.vector : null;
        } catch {
            return null;
        }
    }

    _writeCachedVector(cachePath, text, vector) {
        this._ensureDir(path.dirname(cachePath));
        fs.writeFileSync(cachePath, JSON.stringify({
            model: this.model,
            textHash: this._hash(text),
            vector,
            updatedAt: Date.now()
        }), 'utf-8');
    }

    _normalize(vec) {
        if (!Array.isArray(vec) || vec.length === 0) return null;
        const numeric = vec.map(v => Number(v) || 0);
        let sum = 0;
        for (const value of numeric) sum += value * value;
        const norm = Math.sqrt(sum);
        if (!norm) return numeric;
        return numeric.map(v => v / norm);
    }

    _cosineSimilarity(a, b) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return -1;
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < a.length; i++) {
            const x = Number(a[i]) || 0;
            const y = Number(b[i]) || 0;
            dot += x * y;
            normA += x * x;
            normB += y * y;
        }
        if (normA === 0 || normB === 0) return -1;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    _extractQueryTerms(query) {
        const parts = String(query || '')
            .split(/[\s,，。！？!?；;：:、\/\\()（）\[\]【】<>《》"'`~|]+/)
            .map(v => v.trim())
            .filter(Boolean)
            .filter(v => v.length >= 2);

        return [...new Set(parts)];
    }

    _contentMatchBonus(queryTerms, chunkText) {
        if (!Array.isArray(queryTerms) || queryTerms.length === 0 || !chunkText) return 0;
        const haystack = String(chunkText);
        let hits = 0;
        for (const term of queryTerms) {
            if (haystack.includes(term)) hits++;
        }
        return hits / queryTerms.length;
    }

    _narrativeBonus(query, chunkText) {
        const q = String(query || '');
        const t = String(chunkText || '');
        if (!t) return 0;

        const storyLike = /(剧情|发生|会发生|对话|故事|台词|剧情内容|发生什么)/.test(q);
        if (!storyLike) return 0;

        const sentenceMarks = (t.match(/[。！？!?]/g) || []).length;
        const bulletMarks = (t.match(/(^|\n)\s*(?:[-*•]|\d+\.|\d+、)/gm) || []).length;
        const proseScore = Math.min(1, sentenceMarks / 8);
        const bulletPenalty = Math.min(1, bulletMarks / 4);
        const lengthScore = Math.min(1, t.length / 500);
        const sceneWords = (t.match(/之后|来到|会合|闷闷不乐|生活|意识到|以前|现在|宿舍|寝室|对话|看着|询问|告诉/g) || []).length;
        const sceneScore = Math.min(1, sceneWords / 8);

        return Math.max(0, (proseScore * 0.35 + lengthScore * 0.2 + sceneScore * 0.45) - bulletPenalty * 0.5);
    }

    _buildDocumentText(chunks) {
        if (!Array.isArray(chunks) || chunks.length === 0) return '';
        if (chunks.length <= 3) {
            return chunks.join('\n\n');
        }

        const first = chunks[0];
        const middle = chunks[Math.floor(chunks.length / 2)];
        const last = chunks[chunks.length - 1];
        const selected = [first, middle, last].filter(Boolean);
        return [...new Set(selected)].join('\n\n');
    }

    splitText(text) {
        const clean = String(text || '').replace(/\r\n/g, '\n').trim();
        if (!clean) return [];

        const lineUnits = clean.split('\n').map(line => line.trim()).filter(Boolean);
        const paras = clean.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
        const units = lineUnits.length >= Math.max(12, paras.length * 2) ? lineUnits : paras;
        const chunks = [];

        const pushSlidingWindows = (segment) => {
            const text = String(segment || '').trim();
            if (!text) return;
            if (text.length <= this.chunkSize) {
                chunks.push(text);
                return;
            }

            const step = Math.max(1, this.chunkSize - this.chunkOverlap);
            for (let start = 0; start < text.length; start += step) {
                const slice = text.slice(start, start + this.chunkSize).trim();
                if (slice) chunks.push(slice);
                if (start + this.chunkSize >= text.length) break;
            }
        };

        let current = '';
        for (const para of units) {
            if (!current) {
                current = para;
                continue;
            }

            if ((current.length + para.length + 2) <= this.chunkSize) {
                current += '\n\n' + para;
                continue;
            }

            pushSlidingWindows(current);
            current = para;
        }

        if (current) pushSlidingWindows(current);
        return chunks.filter(Boolean);
    }

    _authHeaders() {
        if (!this.apiKey) {
            throw new Error('SiliconFlow API Key is missing');
        }
        return {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
        };
    }

    async _callEmbeddingApi(inputs) {
        if (!Array.isArray(inputs) || inputs.length === 0) return [];

        const response = await axios.post(
            `${this.apiUrl}/embeddings`,
            {
                model: this.model,
                input: inputs,
                encoding_format: 'float'
            },
            {
                headers: this._authHeaders(),
                timeout: this.timeout
            }
        );

        const payload = response.data || {};
        const items = Array.isArray(payload.data)
            ? payload.data.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
            : null;

        if (items && items.length > 0) {
            return items.map(item => this._normalize(
                item.embedding || item.vector || item.embedding_vector || item.output || []
            ));
        }

        if (Array.isArray(payload.embeddings)) {
            return payload.embeddings.map(vec => this._normalize(vec));
        }

        if (Array.isArray(payload.embedding)) {
            return [this._normalize(payload.embedding)];
        }

        throw new Error('Embedding API response missing vector data');
    }

    async embed(text) {
        const clean = String(text || '').trim();
        if (!clean) return null;

        const cachePath = this._cachePath('texts', clean);
        const cached = this._readCachedVector(cachePath);
        if (cached) return cached;

        const vectors = await this._callEmbeddingApi([clean]);
        const vector = vectors[0];
        if (!Array.isArray(vector)) return null;

        this._writeCachedVector(cachePath, clean, vector);
        return vector;
    }

    async embedMany(texts, batchSize = 8) {
        const items = (texts || []).map(t => String(t || '').trim());
        const vectors = new Array(items.length).fill(null);
        const pending = [];

        for (let i = 0; i < items.length; i++) {
            const text = items[i];
            if (!text) continue;

            const cachePath = this._cachePath('texts', text);
            const cached = this._readCachedVector(cachePath);
            if (cached) {
                vectors[i] = cached;
            } else {
                pending.push({ index: i, text, cachePath });
            }
        }

        for (let i = 0; i < pending.length; i += batchSize) {
            const batch = pending.slice(i, i + batchSize);
            const batchVectors = await this._callEmbeddingApi(batch.map(item => item.text));

            if (batchVectors.length !== batch.length) {
                throw new Error('Embedding API returned mismatched vector count');
            }

            batch.forEach((item, idx) => {
                const vector = batchVectors[idx];
                vectors[item.index] = vector;
                if (Array.isArray(vector)) {
                    this._writeCachedVector(item.cachePath, item.text, vector);
                }
            });
        }

        return vectors;
    }

    async buildEntry({ id, title, gameName, content, fileName, relativePath, fullPath, force = false }) {
        const sourceKey = id || relativePath || fileName || title;
        if (!sourceKey) throw new Error('missing source key');

        const cachePath = this._cachePath('entries', String(sourceKey));
        let statKey = `${fullPath || relativePath || fileName || title}`;
        try {
            if (fullPath && fs.existsSync(fullPath)) {
                const stat = fs.statSync(fullPath);
                statKey = `${stat.size}:${stat.mtimeMs}`;
            }
        } catch {
            // ignore
        }

        if (!force && fs.existsSync(cachePath)) {
            try {
                const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
                if (cached && cached.schemaVersion === this.schemaVersion && cached.statKey === statKey && Array.isArray(cached.chunks) && Array.isArray(cached.chunkVectors) && Array.isArray(cached.docVector)) {
                    return cached;
                }
            } catch {
                // rebuild
            }
        }

        const chunks = this.splitText(content);
        const chunkVectors = await this.embedMany(chunks);
        const docText = this._buildDocumentText(chunks);
        const docVector = docText ? await this.embed(docText) : null;
        const paired = chunks
            .map((chunk, index) => ({ chunk, vector: chunkVectors[index] }))
            .filter(item => Array.isArray(item.vector));

        const entry = {
            schemaVersion: this.schemaVersion,
            id: sourceKey,
            title: title || fileName || sourceKey,
            gameName: gameName || '',
            fileName: fileName || '',
            relativePath: relativePath || '',
            fullPath: fullPath || '',
            statKey,
            docText,
            docVector,
            chunks: paired.map(item => item.chunk),
            chunkVectors: paired.map(item => item.vector),
            updatedAt: Date.now()
        };

        this._ensureDir(this.cacheDir);
        fs.writeFileSync(cachePath, JSON.stringify(entry), 'utf-8');
        return entry;
    }

    async search(query, entries, topK = 5) {
        const queryVector = await this.embed(query);
        if (!Array.isArray(queryVector)) return [];

        const queryTerms = this._extractQueryTerms(query);
        const isStoryQuery = /(剧情|发生|会发生|具体剧情|对话|故事|台词|进入宿舍|宿舍内部)/.test(String(query || ''));
        const weights = isStoryQuery
            ? { vector: 0.34, doc: 0.16, lexical: 0.10, narrative: 0.40 }
            : { vector: 0.56, doc: 0.24, lexical: 0.10, narrative: 0.10 };

        const scored = [];
        for (const entry of entries || []) {
            if (!entry || !Array.isArray(entry.chunkVectors) || entry.chunkVectors.length === 0) continue;

            const docScore = Array.isArray(entry.docVector)
                ? this._cosineSimilarity(queryVector, entry.docVector)
                : -1;

            const localScores = [];
            for (let i = 0; i < entry.chunkVectors.length; i++) {
                const chunkText = entry.chunks[i] || '';
                const vectorScore = this._cosineSimilarity(queryVector, entry.chunkVectors[i]);
                const lexicalBonus = this._contentMatchBonus(queryTerms, chunkText);
                const narrativeBonus = this._narrativeBonus(query, chunkText);
                const score = vectorScore * weights.vector + docScore * weights.doc + lexicalBonus * weights.lexical + narrativeBonus * weights.narrative;

                localScores.push({
                    entry,
                    fullPath: entry.fullPath || '',
                    score,
                    vectorScore,
                    docScore,
                    lexicalBonus,
                    narrativeBonus,
                    chunkIndex: i,
                    chunkText
                });
            }

            localScores.sort((a, b) => b.score - a.score);
            const perEntryTopN = isStoryQuery ? 3 : 1;
            scored.push(...localScores.slice(0, perEntryTopN));
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK);
    }

    _ensureDir(dir) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}

module.exports = { SiliconFlowEmbeddingModel };
