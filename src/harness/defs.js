/**
 * 内置 CLI harness 定义：两家先落地，其余按同一协议在配置里追加。
 *
 * 这些是**纯数据**：没有 import 任何具体 CLI、没有 argv 分支。
 * 想接新 CLI，要么在 `cordis.patch.yml` 的 `harnesses` 里写一份同样的定义，
 * 要么在这里加一个常量并登记。
 */

/** pi：`--print --mode json` 出 JSON 事件流；`--` 之后是提示词；默认排除改文件工具。 */
export const PI_HARNESS = {
  id: 'pi',
  label: 'pi',
  command: 'pi',
  args: ['--print', '--mode', 'json', '--no-session'],
  provider: { flag: '--provider' },
  model: { flag: '--model', format: '{model}' },
  thinking: {
    flag: '--thinking',
    default: 'high',
    values: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
  },
  tools: { exclude: { flag: '--exclude-tools', default: ['edit', 'write'] } },
  prompt: { via: 'argv', separator: '--' },
  output: { parser: 'pi' },
  usage: { source: 'stream', aggregate: 'sum-turns' },
  capabilities: { readOnlyByDefault: true, streamsUsage: true },
  probe: { args: ['--version'], classify: 'exit0' },
  env: { unset: ['FORCE_COLOR'] },
};

/**
 * opencode：`run --format json`；思考档拼进 `-m provider/model#variant`；
 * 只读权限走 `OPENCODE_PERMISSION` 环境变量（edit/write/bash/task 全 deny）。
 * 注意 `harnessModel` 要写带通道前缀的完整模型（如 `opencode/space-bunny-free`）。
 */
export const OPENCODE_HARNESS = {
  id: 'opencode',
  label: 'opencode',
  command: 'opencode',
  args: ['run', '--format', 'json', '--thinking', '--title', 'vastplan-model-team'],
  model: { flag: '-m', format: '{model}#{thinking}' },
  thinking: {
    default: 'max',
    values: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
    viaModelFormat: true,
  },
  prompt: { via: 'argv' },
  env: {
    set: {
      OPENCODE_PERMISSION: JSON.stringify({
        edit: 'deny',
        write: 'deny',
        bash: { '*': 'deny' },
        task: 'deny',
      }),
      OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true',
    },
    unset: ['FORCE_COLOR'],
  },
  output: { parser: 'opencode' },
  usage: { source: 'stream', aggregate: 'auto' },
  capabilities: { readOnlyByDefault: true, streamsUsage: true, backgroundAgents: true },
  probe: { args: ['auth', 'list'], classify: 'exit0' },
};

export const BUILTIN_HARNESSES = [PI_HARNESS, OPENCODE_HARNESS];
