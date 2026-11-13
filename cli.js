#!/usr/bin/env node
/**
 * 多模型团队命令行入口（独立于 DSH，只走 CLI harness）。
 *
 * 给**其他 agent** 用：`model-team run --kind audit --packet /tmp/p.txt --slice foo --models ...`
 * 输出 JSON 到 stdout，进度到 stderr，便于管道解析。
 *
 * 嵌套保护在这里也做一次：被调模型若再执行本 CLI，会立刻退出。
 */
const MIN_NODE = [22, 5];

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const [major = 0, minor = 0] = process.versions.node.split('.').map((part) => Number(part));
if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
  fail(`model-team 需要 Node >= ${MIN_NODE[0]}.${MIN_NODE[1]}（账本用内建 node:sqlite），当前 ${process.versions.node}。`);
}

// 版本号不猜：直接试载入 node:sqlite，失败就报真因。
try {
  await import('node:sqlite');
} catch (error) {
  fail(`当前 Node 用不了内建 node:sqlite：${String(error?.message ?? error)}\n`
    + `建议 Node 22.13+ / 23.4+ / 24 LTS；22.5～22.12 需要加 --experimental-sqlite。当前 ${process.versions.node}。`);
}

if (String(process.env.MODEL_TEAM_ACTIVE ?? '').trim()) {
  fail('MODEL_TEAM_ACTIVE 已设置：当前已在 model-team 场次内，禁止嵌套调用。');
}

const { main } = await import('./src/cli/main.js');
const code = await main(process.argv.slice(2));
process.exitCode = code;
