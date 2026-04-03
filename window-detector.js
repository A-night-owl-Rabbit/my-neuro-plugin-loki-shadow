/**
 * 洛基之影 - Windows 游戏窗口检测
 * 通过 PowerShell 获取当前运行的进程窗口标题，匹配已知游戏名
 */

const { exec } = require('child_process');

const GAME_KEYWORDS = {
    '鸣潮': ['Wuthering Waves', '鸣潮', 'WutheringWaves'],
    '绝区零': ['ZenlessZoneZero', '绝区零', 'Zenless Zone Zero', 'zzz'],
    '原神': ['GenshinImpact', '原神', 'Genshin Impact', 'YuanShen'],
    '崩坏：星穹铁道': ['StarRail', '崩坏：星穹铁道', 'Honkai: Star Rail', 'HonkaiStarRail'],
    '炉石传说': ['Hearthstone', '炉石传说'],
    '隐形守护者': ['The Invisible Guardian', '隐形守护者'],
    '歧路旅人': ['OCTOPATH TRAVELER', '歧路旅人', 'Octopath'],
    '黑神话：悟空': ['Black Myth', '黑神话', 'b1'],
    '消逝的光芒': ['Dying Light', '消逝的光芒'],
    '空之轨迹': ['Sora No Kiseki', '空之轨迹', 'Trails in the Sky'],
    '燕云十六声': ['燕云十六声', 'yysls'],
    '数码宝贝': ['Digimon', '数码宝贝'],
    '八方旅人': ['OCTOPATH', '八方旅人'],
    '寂静岭': ['Silent Hill', '寂静岭'],
    '合金装备': ['Metal Gear', '合金装备'],
    'Minecraft': ['Minecraft', 'minecraft'],
};

const DETECTION_CACHE_MS = 60000;
const VIDEO_PROCESS_KEYWORDS = ['chrome', 'msedge', 'firefox', 'potplayer', 'vlc', 'mpv', 'qqlive', 'iqiyi', 'youku', 'bilibili'];

let cachedDetection = null;

function execPowerShellJson(script, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const escapedScript = script.replace(/"/g, '\\"');
        const psCommand = `chcp 65001 >nul && powershell -NoProfile -Command "${escapedScript}"`;

        exec(psCommand, { encoding: 'utf8', timeout }, (error, stdout) => {
            if (error) {
                reject(new Error(`PowerShell 执行失败: ${error.message}`));
                return;
            }

            const trimmed = stdout.trim();
            if (!trimmed) {
                resolve(null);
                return;
            }

            try {
                resolve(JSON.parse(trimmed));
            } catch (parseErr) {
                reject(new Error(`解析 PowerShell 输出失败: ${parseErr.message}`));
            }
        });
    });
}

/**
 * 获取当前所有带窗口标题的进程
 * @returns {Promise<Array<{processName: string, windowTitle: string}>>}
 */
function getWindowProcesses() {
    return execPowerShellJson(`Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object ProcessName, MainWindowTitle | ConvertTo-Json -Compress`)
        .then(parsed => {
            if (!parsed) return [];
            const processes = Array.isArray(parsed) ? parsed : [parsed];
            return processes.map(p => ({
                processName: p.ProcessName || '',
                windowTitle: p.MainWindowTitle || ''
            }));
        });
}

async function getForegroundWindowProcess() {
    const parsed = await execPowerShellJson([
        `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; public static class Win32 { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId); }'`,
        '$hwnd = [Win32]::GetForegroundWindow()',
        'if ($hwnd -eq [IntPtr]::Zero) { return }',
        '$title = New-Object System.Text.StringBuilder 1024',
        '[void][Win32]::GetWindowText($hwnd, $title, $title.Capacity)',
        '$pid = 0',
        '[void][Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid)',
        '$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue',
        'if (-not $proc) { return }',
        '[pscustomobject]@{ ProcessName = $proc.ProcessName; MainWindowTitle = $title.ToString() } | ConvertTo-Json -Compress'
    ].join('; '), 5000);

    if (!parsed) {
        return null;
    }

    return {
        processName: parsed.ProcessName || '',
        windowTitle: parsed.MainWindowTitle || ''
    };
}

/**
 * 检测当前正在运行的游戏
 * @returns {Promise<{detected: boolean, gameName: string|null, windowTitle: string|null, allWindows: Array}>}
 */
async function detectCurrentGame() {
    return detectCurrentGameWithOptions();
}

function normalizeText(value = '') {
    return String(value || '').toLowerCase();
}

function buildCandidate(proc) {
    const title = proc.windowTitle || '';
    const processName = proc.processName || '';
    const titleLower = normalizeText(title);
    const processLower = normalizeText(processName);
    const videoLikeProcess = VIDEO_PROCESS_KEYWORDS.some(keyword => processLower.includes(keyword));
    let bestCandidate = null;

    for (const [gameName, keywords] of Object.entries(GAME_KEYWORDS)) {
        let score = 0;
        let titleMatched = false;
        let processMatched = false;
        const matchedKeywords = [];

        for (const keyword of keywords) {
            const keywordLower = normalizeText(keyword);
            const shortKeyword = keywordLower.length < 3;
            const matchedTitle = !shortKeyword && titleLower.includes(keywordLower);
            const matchedProcess = processLower.includes(keywordLower);

            if (!matchedTitle && !matchedProcess) continue;

            if (matchedTitle) {
                titleMatched = true;
                score += 2;
            }
            if (matchedProcess) {
                processMatched = true;
                score += 3;
            }

            matchedKeywords.push(keyword);
        }

        if (!score || (videoLikeProcess && !processMatched)) continue;

        const candidate = {
            detected: true,
            gameName,
            windowTitle: title,
            processName,
            matchedKeywords,
            matchedBy: {
                windowTitle: titleMatched,
                processName: processMatched
            },
            confidence: titleMatched && processMatched ? 'high' : (processMatched ? 'medium' : 'low'),
            score
        };

        if (!bestCandidate || candidate.score > bestCandidate.score) {
            bestCandidate = candidate;
        }
    }

    return bestCandidate;
}

function detectGameFromProcesses(processes) {
    let bestCandidate = null;

    for (const proc of processes) {
        const candidate = buildCandidate(proc);
        if (candidate && (!bestCandidate || candidate.score > bestCandidate.score)) {
            bestCandidate = candidate;
        }
    }

    return bestCandidate
        ? {
            ...bestCandidate,
            allWindows: processes,
            cacheHit: false,
            cacheAgeMs: 0
        }
        : {
            detected: false,
            gameName: null,
            windowTitle: null,
            processName: null,
            matchedKeywords: [],
            matchedBy: {
                windowTitle: false,
                processName: false
            },
            confidence: 'none',
            allWindows: processes,
            cacheHit: false,
            cacheAgeMs: 0
        };
}

async function detectCurrentGameWithOptions(options = {}) {
    const forceRefresh = options.forceRefresh === true;
    const now = Date.now();

    if (!forceRefresh && cachedDetection && (now - cachedDetection.timestamp < DETECTION_CACHE_MS)) {
        return {
            ...cachedDetection.value,
            cacheHit: true,
            cacheAgeMs: now - cachedDetection.timestamp
        };
    }

    const processes = await getWindowProcesses();
    const result = detectGameFromProcesses(processes);

    cachedDetection = {
        timestamp: now,
        value: result
    };

    return result;
}

module.exports = {
    detectCurrentGame,
    detectCurrentGameWithOptions,
    detectGameFromProcesses,
    getForegroundWindowProcess,
    getWindowProcesses,
    GAME_KEYWORDS
};
