/**
 * 洛基之影 - 通用重试工具
 * 支持指数退避、自定义回调、超时控制
 */

const axios = require('axios');

/**
 * 通用重试包装器
 * @param {Function} fn - 要执行的异步函数，接收 (attempt) 参数
 * @param {object} options
 * @param {number} [options.maxRetries=3]
 * @param {number} [options.baseDelay=1000] - 基础延迟(ms)
 * @param {number} [options.maxDelay=15000] - 最大延迟(ms)
 * @param {Function} [options.onRetry] - 重试时的回调 (attempt, error, delay)
 * @param {Function} [options.shouldRetry] - 判断是否应该重试 (error) => boolean
 * @returns {Promise<*>}
 */
async function withRetry(fn, options = {}) {
    const {
        maxRetries = 3,
        baseDelay = 1000,
        maxDelay = 15000,
        onRetry = null,
        shouldRetry = null
    } = options;

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            lastError = err;
            if (attempt === maxRetries) break;
            if (shouldRetry && !shouldRetry(err)) break;

            const jitter = Math.random() * 500;
            const delay = Math.min(baseDelay * Math.pow(2, attempt) + jitter, maxDelay);
            if (onRetry) onRetry(attempt + 1, err, delay);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastError;
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 带重试的 HTTP GET 请求
 */
async function fetchWithRetry(url, options = {}) {
    const {
        maxRetries = 3,
        timeout = 15000,
        headers = {},
        onRetry = null,
        responseType = undefined
    } = options;

    return withRetry(
        async () => {
            const resp = await axios.get(url, {
                headers: { 'User-Agent': DEFAULT_UA, ...headers },
                timeout,
                responseType
            });
            return resp;
        },
        { maxRetries, onRetry }
    );
}

/**
 * 带重试的 HTTP POST 请求
 */
async function postWithRetry(url, data, options = {}) {
    const {
        maxRetries = 3,
        timeout = 15000,
        headers = {},
        onRetry = null,
        contentType = 'application/json'
    } = options;

    const finalHeaders = { 'User-Agent': DEFAULT_UA, ...headers };
    if (contentType) finalHeaders['Content-Type'] = contentType;

    return withRetry(
        async () => {
            const resp = await axios.post(url, data, {
                headers: finalHeaders,
                timeout
            });
            return resp;
        },
        { maxRetries, onRetry }
    );
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

module.exports = { withRetry, fetchWithRetry, postWithRetry, sleep, DEFAULT_UA };
