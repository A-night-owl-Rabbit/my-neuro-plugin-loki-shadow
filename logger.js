/**
 * 洛基之影 - 结构化步骤日志系统
 * 为每次查询创建独立会话，记录工作流每个步骤的执行情况
 */

let logToTerminal;
try {
    logToTerminal = require('../../../js/api-utils.js').logToTerminal;
} catch {
    logToTerminal = (level, msg) => console.log(`[${level}] ${msg}`);
}

const TAG = '🗡️ [洛基之影]';

let sessionCounter = 0;

class LokiLogger {
    constructor() {
        sessionCounter++;
        this.sessionId = `LS-${Date.now().toString(36)}-${sessionCounter}`;
        this.steps = [];
        this.startTime = Date.now();
    }

    step(stepName, status, detail = '') {
        const elapsed = Date.now() - this.startTime;
        const entry = {
            step: stepName,
            status,
            detail,
            elapsed,
            timestamp: new Date().toISOString()
        };
        this.steps.push(entry);

        const statusIcon = status === 'ok' ? '✅' : status === 'skip' ? '⏭️' : status === 'fail' ? '❌' : '🔄';
        const msg = `${TAG} [${this.sessionId}] ${statusIcon} ${stepName} (${elapsed}ms) ${detail}`;
        logToTerminal(status === 'fail' ? 'error' : 'info', msg);
    }

    substep(parentStep, name, detail = '') {
        const elapsed = Date.now() - this.startTime;
        const entry = {
            step: `${parentStep} > ${name}`,
            status: 'info',
            detail,
            elapsed,
            timestamp: new Date().toISOString()
        };
        this.steps.push(entry);

        logToTerminal('info', `${TAG} [${this.sessionId}]   ├─ ${name}: ${detail}`);
    }

    error(stepName, error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.step(stepName, 'fail', msg);
    }

    getSummary() {
        const totalTime = Date.now() - this.startTime;
        const failedSteps = this.steps.filter(s => s.status === 'fail');
        const lines = [
            `=== 洛基之影 执行摘要 [${this.sessionId}] ===`,
            `总耗时: ${totalTime}ms`,
            `步骤数: ${this.steps.length}`,
            `失败数: ${failedSteps.length}`,
            '---'
        ];
        for (const s of this.steps) {
            lines.push(`[${s.elapsed}ms] ${s.step}: ${s.status} ${s.detail}`);
        }
        return lines.join('\n');
    }
}

module.exports = { LokiLogger };
