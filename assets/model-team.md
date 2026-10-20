---
name: model-team
description: >
  多模型团队（DSH 原生版）：用 DSH 插件工具 model_team 并发调用已注册模型，做事后审计、设计分叉与专责推理；
  带 SQLite 账本、周报工具与插件页面。触发：/model-team、/多模型团队、事后审计、事后复查、设计分叉、专责推理、
  多模型对比、问 Kimi K3、增减复查模型、周报、总评、阶段评估。在 DeepSeek Harness 里本技能遮蔽同名的外部 CLI 版。
whenToUse: 用户要求在 DeepSeek Harness（本机 DSH）里做多模型审计/分叉/推理，或提到多模型团队、事后审计、设计分叉、专责推理。
---

# 多模型团队（DSH 原生）

在 DeepSeek Harness 里，「多模型团队」就是**插件工具 `model_team`**，不是外部 CLI。
本技能取代旧的 `~/.agents/skills/model-team`（那套是 `node dist/cli.js run` + 手写 `pi`/`grok`/`zcode`/`opencode`/`devin`/`cline` argv）。
`~/.dsh/skills` 的发现优先级（400）高于 `~/.agents/skills`（500），同名 `model-team` 以本技能为准。

## 硬规则

1. **不要手动运行外部模型 CLI**（也不要手写 argv 复制粘贴）。要接 CLI，就在插件配置的 `harnesses` 里按协议定义，让插件统一执行。
2. **模型名单 = DSH 已注册路由 ∪ `cliModels` 里的 CLI 模型**。DSH 模型先在设置里配 provider 路由；CLI 模型用 `cliModels` 挂进来（合成 provider `cli-<harness>`）。
3. **不要手起 subagent 冒充某家模型**：`mode=subagent` 由插件按候选的 provider/model 派活，才是「这家在干活」；自己 spawn 的 subagent 默认继承父模型。
4. **每场必须有收尾**：读完各家 `answer` 后逐条对照代码判定成立/不成立/可选，再给用户结论；禁止只把模型正文复述一遍就收工。

## 调用

```
model_team(
  packet: "<Task Packet，1–3K token>",
  kind: "audit" | "design" | "reason",   // 默认 audit
  models: ["provider/model", "provider/model@@effort", "cli-pi/k3@@max"],  // 省略 = 按这类活动绑定的执行组跑
  mode: "llm" | "subagent",              // 默认 llm；要读代码就用 subagent；CLI 条目忽略此参数
  files: ["src/a.js", "src/b.js"],       // 本次涉及的文件；相对路径要配 workspace
  workspace: "/abs/path/to/repo",        // files 的解析基准；CLI 条目的 cwd（必填）
  max_depth: 1,                          // 仅 mode=subagent：子代理的分包深度
)
```

- `kind=audit` 事后审计：找本次切片缺陷，1～5 重要性。
- `kind=design` 设计分叉：**2～4 个方向、禁止拍板**；每个方向写一句话、对使用者意味着什么、取舍、失败时怎样、非目标。
- `kind=reason` 专责推理：结论、步骤、风险、非目标；不要改写成多个方向。
- `mode=llm`：每家一次纯推理调用（`ctx.llm.stream`），**看不到仓库**；`files` 的正文会带行号拼进提示词，适合只审几份文件。
- `mode=subagent`：每家起一个能读仓库的子 Agent；`files` 只给**清单**（正文让它自己读），审计要顺着 import 追代码时用它。
- **CLI 条目**（`cli-pi/k3` 这类）不看 `mode`：它按 harness 定义自己的工具能力与只读纪律执行，`files` 同样只给清单。

**点名 = 接管同款，不取消绑定**：`models` 里只要命中某个执行组的任一候选，该组就**整组改走点名的那条路由**（主备链只留它）；没被命中的绑定组照常参与；点名里绑定没有的模型作为独立条目追加。想只跑点名的那几家，先到设置里清空/收窄绑定。点名的模型必须能解析，否则**响亮报错并列出可用项**。

## CLI harness（可选）

插件内置 8 家无头模式定义：`agent` / `pi` / `zcode` / `opencode` / `qoder` / `devin` / `cline` / `grok`；
其它 CLI 在 `cordis.patch.yml` 的 `harnesses` 里按协议追加，再用 `cliModels` 把模型挂进目录
（合成 provider `cli-<harness>`，示例见 `docs/cli-models.example.json`）：

```yaml
cliModels:
  - { id: k3, tool: pi, provider: magpie, model: group/auto-kimi-k3, name: Kimi K3, modelKey: kimi-k3 }
```

- 点名/编组写 `cli-pi/k3@@max`；`modelKey` 与 DSH 路由一致时可在同一执行组里主备回落。
- CLI 条目必须有绝对 `workspace`（cwd）；`files` 只给清单，CLI 自己读。
- 默认只读：pi 排除 `edit/write`，opencode 用 `OPENCODE_PERMISSION` 拒绝 edit/write/bash/task；
  凭证由各 CLI 自己的登录态管理，插件不存密钥。
- 没装/没配的 CLI 不会出现在厂商路由里（缓存 30s）；未登录仍会列出，调用时失败。
- 默认自动发现各 CLI 的模型（读配置或跑模型列表命令，缓存 30 分钟）；`cliModels` 可覆盖/补充，
  同 `tool + modelKey` 时显式条目优先。不想发现就设 `discoverCli: false`。
- 设置页最上方「可用 CLI 范围」决定哪些 CLI 参与（DSH 也在范围内）；范围外不发现、不列、不可调用。
- 字段、占位符、argv 顺序、错误/取消语义见 `docs/harness-protocol.md`。

## Task Packet 写法

必须自包含（被调模型看不到你的会话）：

```
# Task Packet：<切片名>

## 目标
<这次要回答什么；audit 要写"找出本切片的缺陷">

## 入口
<文件路径 + 行号 + 关键函数；把最关键的 20～60 行代码原样贴进来，llm 模式尤其需要>

## 硬约束
<不能改哪、口径是什么、已知的真机事实>

## 已试 / 待决
<跑过什么、失败真因、还有哪些疑点要判>
```

设计分叉还要写清「必须让用户选的是哪几个分叉」；专责推理写清「结论要落到哪一步」。

**事后审计要把涉及到的文件写进 `files`**：subagent 模式只拿清单，但清单本身就是审计范围；
不给清单，子代理会乱翻或只读 packet。`workspace` 必须是绝对路径（Host 进程的 cwd 不是项目目录）。

## 结果与账本

- 返回 `models[]`：每家一行（`model` / `provider` / `name` / `reasoningEffort` / `tool` / `status` / `seconds` / `usage` / `text` / `error` / `tried` / `logPath`）。
- `status`：`done` 有结果 / `no-result` 空正文 / `failed` 抛错 / `stopped` 被用户停止或整场取消。
- **先看总开关**：设置 → 多模型团队 → 「保存数据」打开时才写账本与会话日志；关着时「用完即走」，周报与报告会明确报「开关是关的」。
- 打开后每次调用自动落账本：`$DSH_HOME/model-team/ledger.db`（`runs` / `calls` / `call_metric` / `reports`），
  会话日志落 `$DSH_HOME/model-team/runs/<场次ID>/`（`packet.txt`、`prompt.md`、每跳会话 JSON、`*.balance.json`）。
  文件名带模型/路由/强度/槽位，同场同模型跑多次不会互相覆盖。
- 执行组回落：组内第 1 个有结果即停，后面的只在前面失败时启用；`tried` 里能看到试过哪几跳。
  账本只记最终生效的那一条，失败的前几跳不进周报。

## 周报

```
model_team_weekly(days: 7, model: "provider/model")   // model 省略 = 设置页的「周报总结模型」
```
聚合账本窗口并让一个模型写总结；总结失败只记 `summaryError`，聚合数据照常落库。
页面还有一个「执行报告」按钮：把账本渲染成自包含 HTML（`<报告目录>/reports/`），
设置里打开「生成报告后自动上传」且目录在 git 仓、仓有远端时才会自动 commit+push。

## 页面与配置

- 设置 → **多模型团队**，或 设置 → 插件 → 多模型团队。
- **保存数据**：总开关，控制账本/会话日志/周报/报告；默认关。
- **执行组**：一个组 = 同一模型的多个厂商路由（主备顺序即回落顺序）；「停用」的组不参加默认执行。
- **绑定**：每类活动（audit/design/reason）各自绑定哪些组；不绑定时退回全部启用的组；绑定的组全被删/停用时直接报错，不会退化成跑全目录。
- **偏好**：周报总结模型、报告目录（默认 `~/.model-team`，报告写在其 `reports/` 下）、自动上传开关。
- 落点：`~/.dsh/storages/model_team_config.json`（执行组/偏好/绑定）。
- 对话内的实时进度窗挂在输入框上方：逐模型显示阶段（思考/工具/回答/完成）、耗时与最新输出；
  运行中可单家「停止」，结束后点 × 关闭，下次执行会自动重新打开。

## 当前限制

1. `mode=subagent` 的子代理 **token 用量拿不到**（host 的 `activation.result` 没有 usage），
   账本里记 0、报告里显示 `—`；这不代表模型没烧 token。
2. 执行组里**失败的前几跳**只出现在 `tried` 里，不进账本/周报（账本只记最终生效的那一条）。
3. 单家「停止」按 job id 定位场次（Host 内部有 job id → runId 别名表）；点完要等这一家被 abort、结算成 `stopped`。
4. `mode=llm` 下发起了工具调用的回答一律算失败（模型没按「不调工具」的约束作答）。
5. CLI harness 的 token 用量取决于该 CLI 的事件流；拿不到时记 0、报告显示 `—`。
   CLI 未安装/未登录会在该行失败，并带上 stderr 尾部；凭证由 CLI 自己的登录态管理。
6. 外部 CLI 技能的账本在 `~/.model-team/`，插件账本在 `$DSH_HOME/model-team/`，**两本账不混**。

## 自检

```
cordis_inspect_query(platform: "host", provider: "Tool", method: "listTools")   // 确认 model_team / model_team_weekly 在列
```
不在列说明插件没挂载：看 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 是否含 `@vastplan/model-team`。
Host 半改了要**重载插件**；Client 半改了要重载并把 `client.js` 的 `BUILD` 升一版，再刷新页面。
