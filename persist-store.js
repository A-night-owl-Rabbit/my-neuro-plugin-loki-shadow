/**
 * 洛基之影 - 轻量跨会话持久化（参考 Claude Game Companion / 桌宠类产品「跨游戏记忆」思路）
 * 将每个游戏的状态槽位与陪玩偏好写入攻略库目录旁，进程重启后可恢复。
 */

const fs = require('fs');
const path = require('path');

const STORE_VERSION = 1;
const FILE_NAME = '.loki-shadow-persist.json';

function _resolvePath(guideLibraryPath) {
    if (!guideLibraryPath || typeof guideLibraryPath !== 'string') return null;
    return path.join(guideLibraryPath, FILE_NAME);
}

function loadStore(guideLibraryPath) {
    const filePath = _resolvePath(guideLibraryPath);
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

function getGameSnapshot(guideLibraryPath, gameName) {
    if (!gameName) return null;
    const store = loadStore(guideLibraryPath);
    const snap = store.games[gameName];
    return snap && typeof snap === 'object' ? snap : null;
}

function saveGameSnapshot(guideLibraryPath, gameName, snapshot) {
    if (!guideLibraryPath || !gameName || !snapshot) return;
    const filePath = _resolvePath(guideLibraryPath);
    const store = loadStore(guideLibraryPath);
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
