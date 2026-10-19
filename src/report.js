/**
 * 静态报告：把账本渲染成一个自包含的 HTML 文件，用浏览器直接打开。
 *
 * 为什么不做进设置页：执行情况与周报是**查阅**用途，塞进配置页既挤又难读。
 * 按技能侧的既定做法（`~/.model-team/` 那套归档），产物落成静态文件，
 * 页面自己读数据渲染；这里为了单文件可携带，把样式与数据都内联进去。
 *
 * 视觉口径与技能侧 `report.css` 一致：深色底、等宽数值、表格细线分隔。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 报告落点：配置的目录本身（不再套一层 `reports/`）。
 *
 * 默认是技能侧归档根 `~/.model-team`，用户可在设置里改。
 * 报告写在 `<dir>/reports/` 下，避免和归档根已有的 index.html / weekly/ 混在一起。
 */
export function reportsDir(base) {
  return join(base, 'reports');
}

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const fmtSeconds = (seconds) => (Number(seconds) || 0) < 60
  ? `${Math.round(Number(seconds) || 0)}s`
  : `${Math.round((Number(seconds) || 0) / 60)}m`;

const fmtTime = (epoch) => new Date(Number(epoch) || 0).toLocaleString('zh-CN', { hour12: false });

/** 一份报告的数据模型（页面脚本据此重绘，也可直接看表格）。 */
function collect(ledger, from, to) {
  const facts = ledger.aggregate(from, to);
  const runs = ledger.recentRuns(200).filter((run) => run.finishedAt >= from && run.finishedAt < to);
  const calls = ledger.callsOf(runs.map((run) => run.runId));
  const reports = ledger.recentReports(10)
    .filter((report) => report.to >= from && report.from < to);
  return { facts, runs, calls, reports, from, to };
}

const STYLE = `
:root{--bg:#0f1012;--panel:#17181c;--line:#2a2d33;--fg:#e8e9ec;--dim:#9aa0a8;--ok:#3fb950;--bad:#f85149;--accent:#4c8dff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:22px}
main{max-width:1080px;margin:0 auto;padding:40px 32px 80px}
header{margin-bottom:32px}
h1{margin:0;font-size:24px;font-weight:500;line-height:32px}
.sub{margin:6px 0 0;color:var(--dim);font-size:13px;line-height:20px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:24px 0 32px}
.kpi{background:var(--panel);border:.5px solid var(--line);border-radius:12px;padding:14px 16px}
.kpi .label{color:var(--dim);font-size:12px;line-height:18px}
.kpi .value{font-size:22px;line-height:30px;font-variant-numeric:tabular-nums;margin-top:4px}
section{margin:32px 0 0}
h2{font-size:15px;font-weight:500;line-height:24px;margin:0 0 12px}
table{width:100%;border-collapse:collapse;font-size:13px;line-height:20px}
th{text-align:left;font-weight:400;color:var(--dim);padding:8px 16px 8px 0;border-bottom:.5px solid var(--line);white-space:nowrap}
td{padding:9px 16px 9px 0;border-bottom:.5px solid var(--line);vertical-align:middle}
tr:last-child td{border-bottom:0}
.mono{font-variant-numeric:tabular-nums;font-family:"SF Mono",Menlo,monospace;font-size:12px}
.dim{color:var(--dim)}
.ok{color:var(--ok)}
.bad{color:var(--bad)}
.empty{color:var(--dim);font-size:13px}
pre{background:var(--panel);border:.5px solid var(--line);border-radius:12px;padding:16px;
  white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:21px;margin:0 0 12px}
footer{margin-top:48px;color:var(--dim);font-size:12px;line-height:18px}
`;

const SCRIPT = `
// 数据内联；页面本身不再请求任何资源（可直接双击打开、可单独备份）。
const REPORT = JSON.parse(document.getElementById('report-data').textContent);
`;

/**
 * 渲染报告 HTML。
 *
 * @param ledger - SQLite 账本句柄。
 * @param options - 窗口与标题。
 * @returns `{ path, html }`。
 */
export function renderReport(ledger, options) {
  const from = options.from;
  const to = options.to;
  const data = collect(ledger, from, to);
  const { facts, runs, calls, reports } = data;

  const totals = facts.totals;
  const answered = calls.filter((call) => call.status === 'done').length;
  const failed = calls.filter((call) => call.status === 'failed').length;

  const kpi = (label, value) => `<div class="kpi"><div class="label">${escapeHtml(label)}</div>`
    + `<div class="value">${escapeHtml(value)}</div></div>`;

  const runRows = runs.length
    ? runs.map((run) => `<tr>
        <td class="mono">${escapeHtml(run.runId)}</td>
        <td>${escapeHtml(run.kind)}</td>
        <td>${escapeHtml(run.mode)}</td>
        <td class="mono">${run.answered}/${run.total}</td>
        <td class="dim">${escapeHtml(fmtTime(run.finishedAt))}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty">这个窗口里没有场次。</td></tr>';

  const modelRows = facts.models.length
    ? facts.models.map((row) => `<tr>
        <td>${escapeHtml(row.name)} <span class="dim mono">@${escapeHtml(row.reasoningEffort || 'default')}</span></td>
        <td class="mono">${row.runs}</td>
        <td class="mono ok">${row.answered}</td>
        <td class="mono ${row.failed ? 'bad' : 'dim'}">${row.failed}</td>
        <td class="mono">${escapeHtml(fmtSeconds(row.runs ? row.seconds / row.runs : 0))}</td>
        <td class="mono">${row.outputTokens}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="empty">还没有调用记录。</td></tr>';

  const reportBlocks = reports.length
    ? reports.map((report) => `<pre>${escapeHtml(report.summary)}</pre>`).join('')
    : '<p class="empty">这个窗口里还没有生成过周报。</p>';

  const window = `${fmtTime(from)} → ${fmtTime(to)}`;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>多模型团队 · ${escapeHtml(options.title)}</title>
<style>${STYLE}</style>
</head><body><main>
<header>
  <h1>多模型团队 · ${escapeHtml(options.title)}</h1>
  <p class="sub">统计窗口：${escapeHtml(window)}　生成于 ${escapeHtml(fmtTime(Date.now()))}</p>
</header>

<div class="kpis">
  ${kpi('场次', String(facts.runs))}
  ${kpi('调用', String(facts.calls))}
  ${kpi('有结果', String(answered))}
  ${kpi('失败', String(failed))}
  ${kpi('总耗时', fmtSeconds(totals.seconds))}
  ${kpi('输出 token', String(totals.outputTokens))}
</div>

<section>
  <h2>模型表现</h2>
  <table>
    <thead><tr><th>模型</th><th>调用</th><th>有结果</th><th>失败</th><th>平均耗时</th><th>输出 token</th></tr></thead>
    <tbody>${modelRows}</tbody>
  </table>
</section>

<section>
  <h2>场次</h2>
  <table>
    <thead><tr><th>场次</th><th>类型</th><th>模式</th><th>有结果</th><th>结束时间</th></tr></thead>
    <tbody>${runRows}</tbody>
  </table>
</section>

<section>
  <h2>周报</h2>
  ${reportBlocks}
</section>

<footer>
  数据来自 DSH 插件账本（$DSH_HOME/model-team/ledger.db）；本文件自包含，可直接归档或分享。
</footer>
</main>
<script id="report-data" type="application/json">${JSON.stringify({
    from, to, facts, runs, calls, reports,
  }).replace(/</g, '\\u003c')}</script>
<script>${SCRIPT}</script>
</body></html>`;
}

/**
 * 生成并落盘一份报告。
 *
 * @returns `{ path, from, to, title }`。
 */
export function writeReport(ledger, base, options) {
  const dir = reportsDir(base);
  mkdirSync(dir, { recursive: true });
  const html = renderReport(ledger, options);
  const stamp = new Date(options.to).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const path = join(dir, `${options.kind ?? 'report'}-${stamp}.html`);
  writeFileSync(path, html, 'utf8');
  const latest = join(dir, `${options.kind ?? 'report'}-latest.html`);
  writeFileSync(latest, html, 'utf8');
  return { path, latest, from: options.from, to: options.to, title: options.title };
}
