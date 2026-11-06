/**
 * 一键测试的数据校验。
 *
 * 测试按钮不是「调通模型就完事」：它强制 `save: true`，真实走一遍
 * `runTeam → 会话日志 → 账本`，然后把落盘的数据读回来，按系统约定逐项检查。
 * 只有全部检查通过，页面才显示「测试通过」。
 *
 * 校验口径来自两处，改字段时两边要一起改：
 * - 账本：`src/ledger.js` 的 DDL / `METRIC_NAMES` / `TEXT_EXCERPT_CHARS`；
 * - 会话日志：`src/sessionlog.js` 的 `writeSessionLog` 文档结构。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { METRIC_NAMES, TEXT_EXCERPT_CHARS, callKeyOf } from './ledger.js';

/** 会话日志必须存在的顶层字段（与 `writeSessionLog` 的文档结构一致）。 */
export const SESSION_LOG_FIELDS = Object.freeze([
  'started', 'finished', 'duration_s', 'duration_min', 'tool', 'model', 'thinking',
  'exit_code', 'stop_note', 'usage', 'cost', 'answer', 'messages', 'unmapped', 'markers',
]);

/** 会话日志 `usage` 必须存在的键。 */
export const USAGE_FIELDS = Object.freeze(['input', 'output', 'cache_write', 'cache_read', 'reasoning']);

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isNonNegativeNumber = (value) => isNumber(value) && value >= 0;

/**
 * 校验一场测试的落盘数据。
 *
 * @param options.ledger - `Ledger` 句柄。
 * @param options.runId - 测试场次 id。
 * @param options.group - 执行组（需要 groupId/name/mode）。
 * @param options.candidate - 本次测试的路由 `{ model, provider, reasoningEffort }`。
 * @param options.mode - 期望的场次 mode：`llm` / `subagent` / `cli`。
 * @returns `{ ok, checks }`；checks 每项 `{ id, label, ok, detail }`。
 */
export function validateTestRun({ ledger, runId, group, candidate, mode }) {
  const checks = [];
  const check = (id, label, ok, detail = '') => {
    checks.push({ id, label, ok: Boolean(ok), detail: String(detail ?? '') });
  };

  if (!ledger) {
    check('ledger-ready', '账本可用', false, '账本未就绪：SQLite 打不开');
    return { ok: false, checks };
  }

  const run = typeof ledger.runById === 'function' ? ledger.runById(runId) : null;
  check('run-exists', '账本存在测试场次', Boolean(run), run ? '' : `找不到 run_id=${runId}`);
  if (!run) return { ok: false, checks };

  check('run-kind', '场次类型为 test', run.kind === 'test', `实际 kind=${run.kind}`);
  check('run-mode', '场次执行方式正确', run.mode === mode, `期望 ${mode}，实际 ${run.mode}`);
  check('run-total', '场次调用数正确', run.total === 1, `实际 total=${run.total}`);
  check('run-answered', '场次有结果数为 1', run.answered === 1, `实际 answered=${run.answered}`);
  check('run-started', '开始时间是有效时间戳', isNumber(run.startedAt) && run.startedAt > 0, `实际 ${run.startedAt}`);
  check('run-finished', '结束时间不早于开始时间',
    isNumber(run.finishedAt) && run.finishedAt >= run.startedAt,
    `started=${run.startedAt} finished=${run.finishedAt}`);

  const calls = ledger.callsOf([runId]);
  check('call-count', '账本恰好一条调用行', calls.length === 1, `实际 ${calls.length} 条`);
  const row = calls[0];
  if (!row) return { ok: false, checks };

  const expectedCallId = callKeyOf(candidate.model, candidate.reasoningEffort ?? '');
  check('call-id', '调用主键符合 model@@effort', row.callId === expectedCallId,
    `期望 ${expectedCallId}，实际 ${row.callId}`);
  check('call-slot', '槽位等于执行组 id', row.slot === group.groupId,
    `期望 ${group.groupId}，实际 ${row.slot}`);
  check('call-model', '模型字段完整', row.model === candidate.model, `实际 ${row.model}`);
  check('call-provider', '厂商字段完整', Boolean(row.provider), `实际 ${row.provider}`);
  check('call-name', '显示名完整', Boolean(row.name), `实际 ${row.name}`);
  check('call-status', '调用状态为 done', row.status === 'done', `实际 ${row.status}`);
  check('call-excerpt', `摘要不超过 ${TEXT_EXCERPT_CHARS} 字`,
    String(row.excerpt ?? '').length <= TEXT_EXCERPT_CHARS,
    `实际 ${String(row.excerpt ?? '').length} 字`);
  check('call-excerpt-filled', '摘要非空', String(row.excerpt ?? '').trim().length > 0);
  check('call-seconds', '耗时为非负数', isNonNegativeNumber(row.seconds), `实际 ${row.seconds}`);
  check('call-finished-at', '完成时间是有效时间戳', isNumber(row.finishedAt) && row.finishedAt > 0,
    `实际 ${row.finishedAt}`);
  check('call-finished-sync', '调用完成时间与场次一致', row.finishedAt === run.finishedAt,
    `call=${row.finishedAt} run=${run.finishedAt}`);

  const logPath = String(row.logPath ?? '');
  check('call-log-path', '会话日志路径已写入', Boolean(logPath), 'log_path 为空');
  const logExists = Boolean(logPath) && existsSync(logPath);
  check('call-log-exists', '会话日志文件存在', logExists, logPath || '(无路径)');

  // 指标：即使 provider 没回 usage，账本也必须写 5 条 0 值指标，不能缺行。
  const metrics = ledger.metricsFor(runId, row.callId, row.slot);
  const missingMetrics = METRIC_NAMES.filter((name) => !(name in metrics));
  check('metric-keys', '五个 token 指标齐全', missingMetrics.length === 0,
    missingMetrics.length ? `缺少 ${missingMetrics.join(', ')}` : '');
  const badMetrics = METRIC_NAMES.filter((name) => name in metrics && !isNonNegativeNumber(metrics[name]));
  check('metric-values', 'token 指标为非负数', badMetrics.length === 0,
    badMetrics.length ? `非法 ${badMetrics.join(', ')}` : '');

  // 场次目录：packet / prompt 快照必须落盘（这是事后复查的输入凭据）。
  if (logExists) {
    const runDir = dirname(logPath);
    check('run-packet', 'packet.txt 已落盘', existsSync(join(runDir, 'packet.txt')));
    check('run-prompt', 'prompt.md 已落盘', existsSync(join(runDir, 'prompt.md')));
  } else {
    check('run-packet', 'packet.txt 已落盘', false, '没有会话日志路径，无法定位场次目录');
    check('run-prompt', 'prompt.md 已落盘', false, '没有会话日志路径，无法定位场次目录');
  }

  if (logExists) {
    let document = null;
    try {
      document = JSON.parse(readFileSync(logPath, 'utf8'));
      check('log-json', '会话日志是合法 JSON', true);
    } catch (error) {
      check('log-json', '会话日志是合法 JSON', false, error instanceof Error ? error.message : String(error));
    }
    if (document) {
      const missing = SESSION_LOG_FIELDS.filter((field) => !(field in document));
      check('log-fields', '会话日志字段齐全', missing.length === 0,
        missing.length ? `缺少 ${missing.join(', ')}` : '');
      check('log-model', '会话日志 model 一致', document.model === candidate.model,
        `期望 ${candidate.model}，实际 ${document.model}`);
      check('log-thinking', '会话日志 thinking 一致',
        String(document.thinking ?? '') === String(candidate.reasoningEffort ?? ''),
        `期望 ${candidate.reasoningEffort ?? ''}，实际 ${document.thinking}`);
      check('log-exit-code', '会话日志 exit_code 为 0', document.exit_code === 0,
        `实际 ${document.exit_code}`);
      check('log-duration', '会话日志耗时与账本一致',
        isNumber(document.duration_s) && Number(document.duration_s) === Number(row.seconds),
        `日志=${document.duration_s} 账本=${row.seconds}`);
      check('log-answer', '会话日志 answer 非空',
        typeof document.answer === 'string' && document.answer.trim().length > 0,
        `实际 ${String(document.answer ?? '').slice(0, 80)}`);
      const usage = document.usage ?? {};
      const missingUsage = USAGE_FIELDS.filter((field) => !(field in usage));
      check('log-usage-keys', '会话日志 usage 字段齐全', missingUsage.length === 0,
        missingUsage.length ? `缺少 ${missingUsage.join(', ')}` : '');
      const badUsage = USAGE_FIELDS.filter((field) => field in usage && !isNonNegativeNumber(usage[field]));
      check('log-usage-values', '会话日志 usage 为非负数', badUsage.length === 0,
        badUsage.length ? `非法 ${badUsage.join(', ')}` : '');
      check('log-markers', '会话日志 markers 完整',
        Boolean(document.markers?.provider) && Boolean(document.markers?.tool)
          && document.markers?.status === 'done',
        `实际 ${JSON.stringify(document.markers ?? {})}`);
      check('log-markers-effort', '会话日志 markers 强度一致',
        String(document.markers?.reasoning_effort ?? '') === String(candidate.reasoningEffort ?? ''),
        `期望 ${candidate.reasoningEffort ?? ''}，实际 ${document.markers?.reasoning_effort}`);
    }
  }

  return { ok: checks.every((item) => item.ok), checks };
}
