/**
 * 周报的提示词与事实文本。
 *
 * 聚合数据由 `src/ledger.js#Ledger.aggregate()` 产出；这里只负责把聚合结果
 * 渲染成给总结模型看的紧凑文本，以及周报的写作约束。
 *
 * 总结模型由设置页的 `prefs.reportModel` 指定（`provider/model@@effort` 或裸 model id）；
 * 缺席时退回静态配置。总结失败不吞掉聚合数据——报告仍落库，`summary` 记真因。
 */

// 聚合在 `src/ledger.js#Ledger.aggregate()`（SQLite、走索引、带 slot 维度）。
// 这里曾有一份内存版 `aggregate(ledger, ...)`，调用 `ledger.table()`——`Ledger` 没有这个方法，
// 而且从来没人引用；留着只会被误用，已删除。

/** 给总结模型看的紧凑事实文本（不塞整份 JSON）。 */
export function factsForModel(facts) {
  const lines = [
    `统计窗口：${new Date(facts.from).toISOString()} → ${new Date(facts.to).toISOString()}`,
    `场次 ${facts.runs} 场，调用 ${facts.calls} 次；分布：${Object.entries(facts.kinds).map(([kind, count]) => `${kind} ${count}`).join('、') || '无'}`,
    `总耗时 ${Math.round(facts.totals.seconds / 60)} 分钟，输入 ${facts.totals.inputTokens} token，输出 ${facts.totals.outputTokens} token`,
    '',
    '各家表现（按调用次数）：',
  ];
  for (const row of facts.models) {
    lines.push(
      `- ${row.name}（${row.callId}）：调用 ${row.runs} 次，有结果 ${row.answered}，无结果 ${row.noResult}，失败 ${row.failed}，`
      + `平均 ${row.runs ? Math.round(row.seconds / row.runs) : 0}s，输出 ${row.outputTokens} token`,
    );
  }
  return lines.join('\n');
}

export const WEEKLY_PREAMBLE = [
  '你是多模型团队周报的撰写者。下面是本周期的调用统计。',
  '请写一份中文周报，包含：',
  '1. 本周期总体情况（场次、调用量、耗时）；',
  '2. 各模型表现对比，点出稳定的与不稳定的（有数字支撑，不臆测原因）；',
  '3. 需要关注的问题（失败/无结果的集中点）；',
  '4. 下周建议（一两句，具体可执行）。',
  '硬规则：只用给定数字，不编造模型名或数据；不超过 500 字；不要分点套话。',
  '',
].join('\n');
