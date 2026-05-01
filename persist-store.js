/**
 * 洛基之影 - 轻量跨会话持久化（参考 Claude Game Companion / 桌宠类产品「跨游戏记忆」思路）
 * 将每个游戏的状态槽位与陪玩偏好写入插件运行时目录（v3.0.0 起默认位于 plugins/community/loki-shadow/.runtime/），
 * 进程重启后可恢复。
 *
 * API 形参名 `persistDir` 即「持久化文件存放目录」；历史代码可能传旧的攻略库路径，
 * 行为一致——只是把 .loki-shadow-persist.json 放进该目录。
 */

const fs = require('fs');
const path = require('path');

const STORE_VERSION = 1;
const FILE_NAME = '.loki-shadow-persist.json';

function _resolvePath(persistDir) {
    if (!persistDir || typeof persistDir !== 'string') return null;
    return path.join(persistDir, FILE_NAME);
}

function loadStore(persistDir) {
    const filePath = _resolvePath(persistDir);
    if (!filePath) return { version: STORE_VERSION, games: {} };
    try {
        if (fs.existsSync(filePath)) {
            const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (raw && typeof raw === 'object' && raw.games && typeof raw.games === 'object') {
                return { version: raw.version || STORE_VERSION, games: raw.games };
            }
        }
    } catch {
        /* ignore */
    }
    return { version: STORE_VERSION, games: {} };
}

function getGameSnapshot(persistDir, gameName) {
    if (!gameName) return null;
    const store = loadStore(persistDir);
    const snap = store.games[gameName];
    return snap && typeof snap === 'object' ? snap : null;
}

function saveGameSnapshot(persistDir, gameName, snapshot) {
    if (!persistDir || !gameName || !snapshot) return;
    const filePath = _resolvePath(persistDir);
    const store = loadStore(persistDir);
    store.version = STORE_VERSION;
    store.games[gameName] = {
        ...snapshot,
        updatedAt: Date.now()
    };
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf8');
    } catch {
        /* ignore */
    }
}

module.exports = {
    getGameSnapshot,
    saveGameSnapshot,
    loadStore
};
