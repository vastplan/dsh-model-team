# CLI Harness 协议（v1）

多模型团队除了 DSH 原生模型，还可以把 **pi / opencode 等 CLI 的无头模式**接进来。
接法不是改执行层，而是给每家 CLI 写一份**协议定义**（纯数据），由
`src/harness/` 统一起进程、解析事件、推进度、取消与落账。

```
定义（JSON/YAML/JS 对象）
   │  validateHarness()
   ▼
协议层  protocol.js   —— 校验、注册表、buildLaunch()（argv/env/cwd/stdin）
   │
   ▼
机制层  exec.js       —— spawn / 逐行流 / 超时 / 看门狗 / 取消 / parse
   │
   ▼
目录层  catalog.js    —— cliModels → 合成 provider `cli-<harness>`
```

内置定义在 [`src/harness/defs.js`](../src/harness/defs.js)：`pi`、`opencode`。
参考实现来自 `skill-project/model-team` 的 `harness_protocol` / `runner_interface` /
`invoke_exec` / `invoke_parse`，本插件把它收敛成纯数据 + 一个机制层。

---

## 1. 定义字段

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | 是 | — | `[a-z0-9-]`，合成 provider 用 `cli-<id>` |
| `label` | 否 | `id` | 显示名（目录里显示为「模型 · label」） |
| `command` | 是 | — | 可执行文件；裸名走 PATH，也可写绝对路径 |
| `args` | 否 | `[]` | 基础 argv，支持占位符 |
| `model` | 否 | `null` | `{ flag, format, prefix }`，见下 |
| `provider` | 否 | `null` | `{ flag, format }`，例如 pi 的 `--provider magpie` |
| `thinking` | 否 | `null` | `{ flag, format, default, values, map, viaModelFormat }` |
| `tools.exclude` | 否 | `null` | `{ flag, join, default }`，只读纪律的 argv 落实 |
| `prompt` | 否 | `{ via: "argv" }` | `{ via: argv\|stdin\|file, separator, template }` |
| `env` | 否 | `{ inherit: true }` | `{ inherit, set, unset }` |
| `output` | 否 | `{ parser: "auto" }` | `{ parser, args }`；parser = `auto\|jsonl\|text\|pi\|opencode` |
| `usage` | 否 | `{ source: "stream", aggregate: "auto" }` | 用量口径；`aggregate` 传给解析器 |
| `capabilities` | 否 | 只读 | `{ readOnlyByDefault, streamsUsage, backgroundAgents }` |
| `probe` | 否 | `null` | `{ args, classify }`，就绪探测（设置页用，P2） |
| `timeoutMs` / `silenceMs` | 否 | `0` | 机制层自己的总超时/无输出看门狗（0=不启用） |
| `cwd` | 否 | `workspace` | `workspace` 或绝对路径 |

未列出的字段会被忽略；协议版本固定为 1（`PROTOCOL_VERSION`）。

### 占位符

`args` / `format` / `env.set` / `prompt.template` 里可用：

| 占位符 | 值 |
| --- | --- |
| `{model}` | 条目的 `harnessModel`（带 `model.prefix`） |
| `{provider}` | 条目的 `harnessProvider` |
| `{thinking}` | 条目强度经 `thinking.map` 翻译后的值 |
| `{workspace}` | 本次 workspace（绝对路径） |
| `{tmp}` | 临时目录（`file` 模式写 prompt） |
| `{prompt}` | 完整提示词（`argv` 模式） |
| `{promptFile}` | prompt 文件路径（`file` 模式） |

### argv 顺序

```
command
→ args…
→ provider.flag provider.format
→ model.flag   model.format
→ thinking.flag thinking.format（viaModelFormat=true 时跳过）
→ tools.exclude.flag  join(default)
→ output.args…
→ prompt（argv: separator + template；file: 路径；stdin: 走 stdin）
```

---

## 2. 三个内置定义

### pi

```yaml
id: pi
command: pi
args: ["--print", "--mode", "json", "--no-session"]
provider: { flag: "--provider" }
model: { flag: "--model", format: "{model}" }
thinking: { flag: "--thinking", default: high, values: ["", low, medium, high, xhigh, max] }
tools: { exclude: { flag: "--exclude-tools", default: [edit, write] } }
prompt: { via: argv, separator: "--" }
output: { parser: pi }
usage: { aggregate: sum-turns }
capabilities: { readOnlyByDefault: true, streamsUsage: true }
```

### opencode

```yaml
id: opencode
command: opencode
args: ["run", "--format", "json", "--thinking", "--title", "vastplan-model-team"]
model: { flag: "-m", format: "{model}#{thinking}" }   # 强度拼进 #variant
thinking: { default: max, viaModelFormat: true }
prompt: { via: argv }
env:
  set:
    OPENCODE_PERMISSION: '{"edit":"deny","write":"deny","bash":{"*":"deny"},"task":"deny"}'
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true"
output: { parser: opencode }
capabilities: { readOnlyByDefault: true, streamsUsage: true, backgroundAgents: true }
```

> `harnessModel` 要写**完整通道**（如 `opencode/space-bunny-free`），因为 opencode 的
> `-m` 需要 `provider/model#variant`。

---

## 3. 在配置里接新 CLI

`cordis.patch.yml` 的 `config` 下加 `harnesses`（定义）与 `cliModels`（模型）：

```yaml
- insert:
    - id: model-team
      name: '@vastplan/model-team'
      config:
        harnesses:
          - id: foo
            label: foo
            command: foo
            args: ["--print", "--output-format", "json"]
            model: { flag: "--model", format: "{model}" }
            thinking: { flag: "--thinking", default: high }
            prompt: { via: argv, separator: "--" }
            output: { parser: auto }
        cliModels:
          - id: k3
            tool: pi
            provider: magpie
            model: group/auto-kimi-k3
            name: Kimi K3
            modelKey: kimi-k3
```

- `tool` 必须是已登记的 harness id（内置或 `harnesses` 里定义的）。
- 合成 provider 是 `cli-<tool>`；上面两条分别得到 `cli-pi/k3`、`cli-foo/...`。
- `modelKey` 决定页面把哪些路由聚成一个执行组。要和 DSH 的 `kimi-k3` 合组，
  就写同一个 `modelKey`（如 `kimi-k3`）；不写则按 `id` 单独成组。
- `efforts` 不写时用定义里的 `thinking.values`；`defaultEffort` 不写时用 `thinking.default`。

### 使用

```
model_team(
  packet: "...",
  kind: "audit",
  mode: "llm",                                  // CLI 条目忽略 mode
  models: ["cli-pi/k3@@max"],
  files: ["index.js"],                          // 只给清单，CLI 自己读
  workspace: "/Users/me/project"                // CLI 的 cwd，必须是绝对路径
)
```

执行组候选同样可以写 `cli-pi/k3@@max`，与 DSH 路由混排做回落：

```
Kimi K3: magpie/group/auto-kimi-k3@@high → cli-pi/k3@@max
```

---

## 4. 结果与错误

成功返回：

```js
{
  text, reasoning, usage, messages,
  exitCode: 0, stopNote: '', unmapped: []
}
```

- `usage` 全 0 时归一为 `null`（未采集），账本记 0、报告显示 `—`。
- `unmapped` 是流里**没认出来**的事件类型，写进会话日志，便于发现解析口径漂移。
- 非零退出 → 抛错，错误上带 `partialText` / `messages` / `usage` / `exitCode` /
  `stopNote`；失败行仍保留半截正文。
- 取消（`signal` abort）→ 终止子进程，抛 `AbortError`，行状态记 `stopped`。
- 超时/无输出 → `stopNote` 为 `超时` / `无输出超时`，行状态记 `failed`。

---

## 5. 安全与只读

- **显式 opt-in**：只有配置了 `cliModels` 才会调用 CLI；不会自动发现本机 CLI。
- **只走 argv**：`spawn(argv, {shell:false})`，不拼 shell 字符串。
- **只读默认**：pi 用 `--exclude-tools edit,write`；opencode 用
  `OPENCODE_PERMISSION` 把 edit/write/bash/task 全 deny。新定义应把它们作为默认值。
- **密钥不落配置**：`env.set` 只放非敏感值；凭证交给各 CLI 自己的登录态。
  `env.inherit` 默认继承宿主环境，`env.unset` 可剔除 `FORCE_COLOR` 之类会污染输出的变量。
- **可见**：设置页（P2）会展示最终 argv 与就绪状态；没有登录态时应报 `auth-required`，
  而不是跑出空正文。
- **子进程治理**：优先走 `ctx.subprocess`（与宿主同一执行世界）；宿主没有该服务时
  退回 `node:child_process`，行为一致但绕过宿主的沙箱治理。

---

## 6. 测试

```bash
node --test scripts/harness.test.mjs
```

覆盖：pi/opencode 的 argv、定义校验、起进程/进度/解析/用量、取消（AbortError）、
非零退出、`cliModels` 目录、以及 `runTeam` 的 CLI 端到端路径（用 `scripts/fake-cli.mjs`，
不需要真实 CLI）。

接新 CLI 时建议先加一个定义 + 一条测试，再接真实二进制。
