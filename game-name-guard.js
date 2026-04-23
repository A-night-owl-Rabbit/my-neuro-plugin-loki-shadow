/**
 * 拒绝将视频站、浏览器、播放器等应用名误当作 game_name 传入洛基之影。
 * 仅做精确匹配与少量前缀规则，避免误判真实游戏名（如含子串 "live" 等）。
 */

const EXACT_NON_GAME = new Set([
    // B 站系
    '哔哩哔哩', 'bilibili', 'b站', 'acfun', 'a站',
    // 视频/直播
    'youtube', '优酷', 'youku', '爱奇艺', 'iqiyi', '腾讯视频', '抖音', '快手',
    '西瓜视频', '斗鱼', '虎牙', 'niconico', 'ニコニコ',
    // 播放器 / 工具
    'potplayer', 'vlc', 'mpv', 'obs', 'obs studio',
    // 浏览器 / 系统
    'chrome', 'google chrome', 'microsoft edge', 'msedge', 'firefox', '火狐浏览器',
    'safari', 'opera', 'brave', '资源管理器', '任务管理器', '文件资源管理器',
    'explorer', 'windows terminal', 'powershell', 'cmd', '命令提示符',
    // 通讯 / 音乐 / 办公（常见误填窗口名）
    '微信', 'wechat', 'qq', 'tim', 'discord', 'telegram', 'slack',
    '网易云音乐', 'qq音乐', 'spotify', '酷狗音乐', '酷我音乐',
    'vscode', 'visual studio code', 'cursor', 'notepad++', '记事本', 'notepad',
    'word', 'excel', 'powerpoint', 'onenote', 'outlook',
]);

/**
 * @param {string} raw
 * @returns {string|null} 拒绝原因码；null 表示通过
 */
function getTrackGameNameRejection(raw) {
    const t = String(raw || '').trim();
    if (!t) return 'empty';

    const lower = t.toLowerCase().replace(/\s+/g, ' ').trim();

    if (EXACT_NON_GAME.has(t) || EXACT_NON_GAME.has(lower)) return 'denylist_exact';

    // 哔哩哔哩客户端 / 直播姬等标题常以「哔哩」开头
    if (t.startsWith('哔哩') || lower.startsWith('bilibili')) return 'denylist_bilibili_family';

    return null;
}

module.exports = {
    EXACT_NON_GAME,
    getTrackGameNameRejection,
};
