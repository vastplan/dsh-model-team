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

内置定义在 [`src/harness/defs.js`](../src/harness/defs.js)：`agent`、`pi`、`zcode`、`opencode`、`qoder`、`devin`、`cline`、`grok`。
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
| `prompt` | 否 | `{ via: "argv" }` | `{ via: argv\|stdin\|file\|none, separator, template }`；`none` = 提示词已在 args 的 `{prompt}` 里 |
| `env` | 否 | `{ inherit: true }` | `{ inherit, set, unset }` |
| `output` | 否 | `{ parser: "auto" }` | `{ parser, args }`；parser = `auto\|jsonl\|text\|pi\|opencode` |
| `discover` | 否 | `null` | `{ command?, argv, parser }`；自动发现模型列表（parser 见「自动发现」） |
| `usage` | 否 | `{ source: "stream", aggregate: "auto" }` | 用量口径；`aggregate` 传给解析器 |
| `capabilities` | 否 | 只读 | `{ readOnlyByDefault, streamsUsage, backgroundAgents }` |
| `probe` | 否 | `null` | `{ args, classify }`，就绪探测（设置页用，P2） |
| `availability` | 否 | `{}` | `{ fallbacks, commands: [{ command, fallbacks, env }], files }`；目录构建时判断 CLI 是否可用，不可用则不列出 |
| `timeoutMs` / `silenceMs` | 否 | `0` | 机制层自己的总超时/无输出看门狗（0=不启用） |
| `cwd` | 否 | `workspace` | `workspace` 或绝对路径 |
| `hooks.plan` | 否 | `null` | 代码型钩子（仅内置/JS）：`(entry, prompt, context) => { argv, env?, cwd?, stdin?, prepare? }`；用于 zcode 这类要改临时配置的 CLI |
| `hooks.discover` | 否 | `null` | 代码型钩子：`() => ({ id, name, provider? })[]`；读本机配置（pi/zcode/cline） |

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
| `{node}` | 当前 Node 可执行文件（`process.execPath`） |
| `{pkgDir}` | 插件包根（引用随包脚本，如 devin 的 ACP 客户端） |

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

## 2. 内置定义（8 家）

对齐原型 `runner_interface.ts`，全部在 [`src/harness/defs.js`](../src/harness/defs.js)：

| id | command | 关键 argv（简化） | 只读默认 | 备注 |
| --- | --- | --- | --- | --- |
| `agent` | `agent` | `--print --output-format stream-json --mode ask --trust --workspace {workspace} --model {model} <prompt>` | `ask` | 强度写在模型 slug（如 `gemini-3.8-flash-high`） |
| `pi` | `pi` | `--print --mode json --no-session [--provider p] --model m --thinking e --exclude-tools edit,write -- <prompt>` | `exclude-tools` | 用量按 `message_end.usage` 逐轮相加 |
| `zcode` | `node zcode.cjs` | `--prompt <prompt> --cwd {workspace} --mode plan --disallowed-tools "Bash Edit Write"` | `disallowed-tools` | 读改写用户 config，`HOME` 指到临时目录（**hook**） |
| `opencode` | `opencode` | `run --format json --thinking -m {model}#{thinking} <prompt>` | `OPENCODE_PERMISSION` | 强度拼进 `#variant`；v2 事件无 usage |
| `qoder` | `qoderclicn` | `-p --output-format stream-json --no-session-persistence -m m --reasoning-effort e --disallowed-tools Write,Edit -- <prompt>` | `disallowed-tools` | 可选 `--context-window`（当前未暴露） |
| `devin` | `{node} {pkgDir}/scripts/devin_acp.mjs` | `--model m --mode ask -- <prompt>` | ACP `ask` | 随包 ACP 客户端，固定只读 |
| `cline` | `cline` | `--json -c {workspace} -p [-P p] -m m --thinking e <prompt>` | `-p` plan | `max` 自动落 `xhigh` |
| `grok` | `grok` | `-p <prompt> --output-format streaming-json --model m --reasoning-effort e --disallowed-tools write,search_replace` | `disallowed-tools` | 提示词必须紧跟 `-p`，用 `prompt.via: none` |

几家的细节：

- **zcode**：必须装 ZCode 应用、且有 `~/.zcode/cli/config.json`；hook 把
  `defaultVariant` 改成本次强度，并把 `HOME` 指到 `${tmp}/zcode-home-*` 隔离本机配置。
- **devin**：`scripts/devin_acp.mjs` 随包发布，用 `DEVIN_BIN` 环境变量可覆盖 `devin` 可执行文件；
  会话固定 `ask`，`set_mode` 失败即失败。
- **cline**：默认 `-p`（plan）只读；要 act 档需要另写一个定义（或覆盖 `args`）。
- **grok**：`prompt.via: none`，所以 `{prompt}` 必须出现在 `args` 里。

### 自动发现来源

| CLI | 来源 |
| --- | --- |
| pi | `~/.pi/agent/models.json` 的 `providers[].models[]` |
| zcode | `~/.zcode/cli/config.json` 的 `builtin:bigmodel-coding-plan` |
| cline | `~/.cline/data/settings/providers.json` 的当前模型（CLI 无完整列表命令） |
| opencode | `opencode models` |
| agent | `agent --list-models` |
| grok | `grok models` |
| devin | `devin models list` |
| qoder | `qoderclicn --list-models` |

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

- 8 家的示例条目见 [`docs/cli-models.example.json`](cli-models.example.json)，按本机实际模型/路由改。
- **自动发现默认开**：`listCatalog()` 会调用各 CLI 的 `discover`/`hooks.discover`；`cliModels` 用于
  覆盖/补充（同 `tool + modelKey` 显式优先）。关掉用 `discoverCli: false`。
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

## 5. 自动发现

`listCatalog()` 在目录构建时对**可用**的 CLI 跑发现：

- 定义里的 `discover`（命令 + parser）或 `hooks.discover()`（读配置）；
- 解析器：`lines` / `opencode` / `id-dash-name` / `bullet` / `devin-table` / `qoder-table`；
- 按**逻辑模型**去重：取最后一段路由、去掉 `auto-`、归一 `[-_.]`；同一逻辑模型的多个路由
  只留优先级最高的一条（原生 id → `auto/` → `devin/` → `workbuddy/` → `opencode-go/` →
  `zcode/` → `grok/`）；
- 结果缓存 30 分钟；装好 CLI/新增模型后最多等 30 分钟或重载插件；
- `cliModels` 优先：同 `tool + modelKey` 的显式条目覆盖自动条目；
- **范围**：设置页的「可用 CLI 范围」（`prefs.enabledHarnesses`，`null`=全部，含 `'dsh'`）决定哪些 CLI 参与；
  范围外的 CLI 不跑发现、不进目录，调用时也会被拒绝。
- `discoverCli: false` 完全关闭自动发现（范围仍生效）。

**注意**：agent/devin/grok 的模型 id 里带 effort/fast 变体（如 `swe-2-max`、`claude-opus-5-5-high`），
自动发现会按逻辑 id 去重，但**不会把 effort 变体合并**（它们是不同的 id，本机全量约 1,300 条）。
嫌多可以 `discoverCli: false` 只用手写条目，或用 `cliModels` 精确补充。

## 6. 可用性过滤

`listCatalog()` 构建目录时会检查每家 CLI 的 `availability`：

- 主命令：绝对路径 / PATH / `fallbacks`；
- 额外命令：`commands`（devin 的 `devin`，可用 `DEVIN_BIN` 覆盖）；
- 额外文件：`files`（zcode 的 `~/.zcode/cli/config.json`、devin 的随包脚本）。

不可用的 CLI **不会进入模型目录**，执行组的「厂商路由」里也就看不到它；
结果缓存 30s，装好 CLI 后最多等 30s 或重载插件。
**只判断装没装/配没配，不判断登录态**——未登录仍会列出，调用时由 stderr 暴露。

## 7. 安全与只读

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

## 8. 测试

```bash
node --test scripts/harness.test.mjs
```

覆盖：8 家的 argv、zcode hook、定义校验、起进程/进度/解析/用量、取消（AbortError）、
非零退出、`cliModels` 目录、以及 `runTeam` 的 CLI 与 DSH 双路径（用 `scripts/fake-cli.mjs`，
不需要真实 CLI）。

接新 CLI 时建议先加一个定义 + 一条测试，再接真实二进制。
