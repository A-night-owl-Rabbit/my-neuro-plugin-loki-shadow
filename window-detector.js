/**
 * 洛基之影 - Windows 游戏窗口检测
 * 通过 PowerShell 获取当前运行的进程窗口标题，匹配已知游戏名
 */

const { exec } = require('child_process');

const GAME_KEYWORDS = {
    '鸣潮': ['Wuthering Waves', '鸣潮', 'WutheringWaves'],
    '绝区零': ['ZenlessZoneZero', '绝区零', 'Zenless Zone Zero'],
    '原神': ['GenshinImpact', '原神', 'Genshin Impact'],
    '崩坏：星穹铁道': ['StarRail', '崩坏：星穹铁道', 'Honkai: Star Rail'],
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

/**
 * 获取当前所有带窗口标题的进程
 * @returns {Promise<Array<{processName: string, windowTitle: string}>>}
 */
function getWindowProcesses() {
    return new Promise((resolve, reject) => {
        const psCommand = `chcp 65001 >nul && powershell -NoProfile -Command "Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object ProcessName, MainWindowTitle | ConvertTo-Json -Compress"`;

        exec(psCommand, { encoding: 'utf8', timeout: 10000 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`PowerShell 执行失败: ${error.message}`));
                return;
            }

            try {
                const trimmed = stdout.trim();
                if (!trimmed) {
                    resolve([]);
                    return;
                }

                let parsed = JSON.parse(trimmed);
                if (!Array.isArray(parsed)) parsed = [parsed];

                resolve(parsed.map(p => ({
                    processName: p.ProcessName || '',
                    windowTitle: p.MainWindowTitle || ''
                })));
            } catch (parseErr) {
                reject(new Error(`解析进程列表失败: ${parseErr.message}`));
            }
        });
    });
}

/**
 * 检测当前正在运行的游戏
 * @returns {Promise<{detected: boolean, gameName: string|null, windowTitle: string|null, allWindows: Array}>}
 */
async function detectCurrentGame() {
    const processes = await getWindowProcesses();

    for (const proc of processes) {
        const title = proc.windowTitle;
        const pName = proc.processName.toLowerCase();

        for (const [gameName, keywords] of Object.entries(GAME_KEYWORDS)) {
            for (const kw of keywords) {
                if (title.includes(kw) || pName.includes(kw.toLowerCase())) {
                    return {
                        detected: true,
                        gameName,
                        windowTitle: title,
                        processName: proc.processName,
                        allWindows: processes
                    };
                }
            }
        }
    }

    return {
        detected: false,
        gameName: null,
        windowTitle: null,
        allWindows: processes
    };
}

module.exports = { detectCurrentGame, getWindowProcesses, GAME_KEYWORDS };
