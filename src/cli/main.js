/**
 * CLI 入口分发。每个子命令一个模块，按需动态载入（`model-team --help` 不启动任何 harness）。
 */
import { parseArgs } from './args.js';

const HELP = `model-team —— 多模型团队命令行（独立于 DSH，只走 CLI harness）

用法：
  model-team <command> [options]

执行
  run                跑一场多模型审计/分叉/推理
                     --kind audit|design|reason  --packet <file|->  --slice <名字>
                     --models a,b  --workspace <绝对路径>  --commit <sha>
                     --timeout <秒>  --json（默认就是 JSON）

评估闭环
  record-findings    记录对照结论（--run-id <id> --json <file> [--write]）
  record-outcome     记录用户选择/契合分（--run-id <id> --json <file> [--write]）
  summary            汇总各模型表现（--kind audit|design|reason [--json]）
  selfcheck          账本/日志一致性自检（[--json]）

账本维护
  normalize          模型名归一（[--write]）
  refresh-usage      从会话日志回填 token/金额（[--run-id <id>] [--write] [--only-empty]）
  backfill           被中断场次从日志重建账本行（--run-id <id> [--write]）
  usage              用量统计（--dim tool|provider|model --range 7d [--json]）

报告
  weekly             生成周报（[--week 2026-W45|--current] [--model <spec>] [--json]）
  post               重写周报简报（[--week ...]）
  report             导出数据 JSON（--out <file>）
  index              重建归档入口页

模型与诊断
  models list        列出可用模型（* = 默认名单）
  models catalog     模型对照表
  models check       校验默认名单能否解析
  models prices      价格表（读 ~/.model-team/models.json）
  routes             执行序编排一屏看
  doctor             本机 harness 就绪探测（只读、不耗 token）
  quota              账户余额/额度

通用
  --config <path>    配置文件（默认 ~/.model-team/cli.json）
  --db <path>        账本路径（默认统一库）
  --quiet            关掉 stderr 进度
  -h, --help         显示本帮助
`;

/**
 * 分发。
 *
 * @param argv - `process.argv.slice(2)`
 * @returns 进程退出码
 */
export async function main(argv) {
  const parsed = parseArgs(argv);
  const command = parsed.command;
  if (!command || command === 'help' || parsed.flags.has('-h') || parsed.flags.has('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  const { loadCliConfig } = await import('./config.js');
  const config = loadCliConfig(parsed.flags.get('--config') ?? '');

  try {
    switch (command) {
      case 'run': {
        const { runCliTeam, readPacket } = await import('./run.js');
        const { buildCliCatalog } = await import('./catalog.js');
        const { listFlag, flagOf, hasFlag, numberFlag } = await import('./args.js');
        const { catalog } = await buildCliCatalog(config, { quiet: hasFlag(parsed, '--quiet') });
        const packet = readPacket(flagOf(parsed, '--packet'));
        const outcome = await runCliTeam({
          kind: flagOf(parsed, '--kind', 'audit'),
          packet,
          slice: flagOf(parsed, '--slice'),
          models: listFlag(parsed, '--models'),
          fallback: config.defaultModels,
          catalog,
          workspace: flagOf(parsed, '--workspace', process.cwd()),
          timeoutSec: numberFlag(parsed, '--timeout'),
          ledgerPath: flagOf(parsed, '--db', config.ledgerPath),
          runsRoot: config.runsRoot,
          onProgress: (event) => {
            if (hasFlag(parsed, '--quiet')) return;
            if (event.type === 'start') process.stderr.write(`▶ ${event.model}\n`);
            if (event.type === 'done') process.stderr.write(`  ${event.status === 'done' ? '✔' : '✘'} ${event.model} ${event.seconds}s\n`);
          },
        });
        process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
        return 0;
      }
      case 'models': {
        const { modelsList, modelsCatalog, modelsCheck, renderModelsTable } = await import('./models.js');
        const { buildCliCatalog } = await import('./catalog.js');
        const sub = parsed.positionals[0] ?? 'list';
        const { catalog } = await buildCliCatalog(config, { quiet: true });
        if (sub === 'list') {
          const rows = modelsList(catalog, config);
          if (parsed.flags.has('--json')) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
          else process.stdout.write(`${renderModelsTable(rows)}\n`);
          return 0;
        }
        if (sub === 'catalog') {
          process.stdout.write(`${JSON.stringify(modelsCatalog(catalog), null, 2)}\n`);
          return 0;
        }
        if (sub === 'check') {
          // 没有 defaultModels 就没什么可校验的——不要「把全目录当名单」虚报 500 条都通过。
          if (!config.defaultModels.length) {
            process.stdout.write(`${JSON.stringify({ ok: true, checked: 0, missing: [], note: '未配置 defaultModels；用 --config 指定' }, null, 2)}\n`);
            return 0;
          }
          const rows = modelsCheck(catalog, config.defaultModels);
          const bad = rows.filter((row) => !row.ok);
          process.stdout.write(`${JSON.stringify({ ok: bad.length === 0, missing: bad.map((row) => row.spec), checked: rows.length }, null, 2)}\n`);
          return bad.length ? 1 : 0;
        }
        if (sub === 'prices') {
          const { loadPricing } = await import('./models.js');
          process.stdout.write(`${JSON.stringify(loadPricing(), null, 2)}\n`);
          return 0;
        }
        if (sub === 'add' || sub === 'remove') {
          const { editDefaultModels } = await import('./models.js');
          const specs = (parsed.positionals.slice(1).length ? parsed.positionals.slice(1) : parsed.flags.get('--models')?.split(',') ?? [])
            .map((item) => String(item).trim()).filter(Boolean);
          if (!specs.length) throw new Error(`用法：model-team models ${sub} <spec...>`);
          const result = editDefaultModels(config, specs, sub === 'add');
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return 0;
        }
        throw new Error(`未知子命令：models ${sub}（list | catalog | check | prices）`);
      }
      case 'doctor': {
        const { runDoctor, renderDoctor } = await import('./doctor.js');
        const { numberFlag } = await import('./args.js');
        const report = await runDoctor({
          config,
          timeoutS: numberFlag(parsed, '--timeout', 8),
          rangeMs: numberFlag(parsed, '--range-days', 7) * 24 * 3600 * 1000,
        });
        if (parsed.flags.has('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        else process.stdout.write(`${renderDoctor(report)}\n`);
        const unhealthy = report.targets.filter((item) => item.status !== 'ready' && item.status !== 'installed');
        return parsed.flags.has('--strict') && unhealthy.length ? 1 : 0;
      }
      default: {
        const { dispatchExtra } = await import('./commands.js');
        return await dispatchExtra(command, parsed, config);
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
