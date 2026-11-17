---
name: model-team
description: >
  多模型团队：并行调多家 CLI 模型做事后审计、设计分叉与专责推理，产出账本、findings 与周报。
  触发：/model-team、/多模型团队、事后审计、事后复查、设计分叉、专责推理、多模型对比、总评、阶段评估。
---

# 多模型团队（命令行版）

本技能是**执行端入口**：所有动作都走 `model-team` 命令（已通过 `npm link` 装到 PATH）。
不要手写 `pi` / `agent` / `zcode` / `opencode` / `qoder` / `devin` / `cline` / `grok` / `claude` / `agy` 的 argv，
也不要再调用旧技能仓库里的 `node dist/cli.js`。

## 硬规则

1. **每场必须收尾**：读完 `runs[].answer` 后逐条对照代码判定成立/不成立，然后 `record-findings`。
   零项也要跑（`--json` 传 `[]`）。禁止只把模型正文复述一遍就收工。
2. **语言**：提交给被测模型的 Task Packet **一律英文**；拿到回复后翻成中文再向用户汇报。
3. **嵌套保护**：被调模型不得再执行 `model-team`（CLI 会用 `MODEL_TEAM_ACTIVE` 直接退出）。
4. **数据根**：账本 `~/.model-team/ledger/model-audit-reviews.db`，会话日志 `~/.model-team/runs/<场次ID>/`；
   可用 `MODEL_TEAM_HOME` 改根，`--db` / `--config` 单次覆盖。
   **唯一的例外是审查点**：它记在 `<workspace>/.model-team/review-points.json`，见「一·五」。
   理由：账本与日志是**跨项目**的调用记录，属于这台机器；审查点是**单个仓库**的审计游标，
   跟着项目走才不会被别的仓库顶掉，换机器/新克隆也有意义。它同样**不进版本历史**
   （仓库里把 `.model-team/` 加进 `.gitignore`）——结论应该落在项目自己的文档里。

## 一、跑一场

```bash
# 1) 写 Task Packet（英文，自包含：目标 / 入口 file:line + 关键代码 / 硬约束 / 已试待决）
model-team run \
  --kind audit \
  --packet /tmp/packet.md \
  --slice "order-service" \
  --workspace /abs/path/to/repo \
  --models cli-claude/claude-sonnet-5-5,cli-grok/grok-4-7 \
  --review-point auto \
  --timeout 600
```

- `--kind`：`audit`（事后审计，默认）/ `design`（设计分叉，2～4 个方向、禁止拍板）/ `reason`（专责推理）。
- **模型从哪来（优先级从高到低）**：
  1. `--models a,b`（命令行点名）；
  2. `--group <groupId|名字>`（只跑页面里的某个执行组）；
  3. **页面配置**（设置 → 多模型团队）：按 `kind` 取绑定的执行组，组内候选按顺序回落
     ——与插件页完全一致；停用组自动跳过；
  4. 页面没有可用组时，才退回 `~/.model-team/cli.json` 的 `defaultModels`。
- 排查「为什么跑的不是我配的模型」：`model-team run --kind audit --plan-only` 会打印
  `roster_source` 和解析出的每个组/候选，**不调模型**。
- `--packet -` 可从 stdin 读。
- stdout 是 JSON：`{ run_id, kind, ledger, log_dir, quality_eval, next, runs[] }`；
  每条 run 有 `model / provider / status / duration_s / input_tokens / output_tokens / answer / log`。
- stderr 是进度；`--quiet` 关掉。

## 一·五、审查点（review point）——审计默认是增量的

审计最怕两件事：重复报同一批已经处理过的结论，以及每次都从头读整个仓库。
审查点解决它：**记住上一次审到哪个提交，下一次只审那之后的新变动。**

### 存在哪

`<workspace>/.model-team/review-points.json`，按项目存。

- **不提交进 git**（仓库里加 `.model-team/` 到 `.gitignore`）。它是**游标**不是**结论**：
  结论应该落在项目自己的文档里（例如 `docs/progress.md` 的缺口台账），
  而游标每次审计都会变，提交它只会往产品历史里塞无意义的提交。
- 用 `MODEL_TEAM_REVIEW_POINTS` 可覆盖路径；没有 `workspace` 时兜底到 `~/.model-team/`。

### 怎么用

DSH 的 `model_team` 工具：`kind="audit"` 时自动生效，无需额外参数。

```jsonc
{ "kind": "audit", "reviewPoint": "auto" }   // 默认：增量
{ "kind": "audit", "reviewPoint": "reset" }  // 清掉游标，强制全量
{ "kind": "audit", "reviewPoint": "off" }    // 本次既不读也不写
```

CLI：`--review-point auto|reset|off`（默认 auto），另有两个只读/维护子命令：

```bash
model-team review-point show  --workspace /abs/path/to/repo   # 当前游标 + 下次增量范围
model-team review-point reset --workspace /abs/path/to/repo   # 清游标，下次全量
```

### 行为

- 跑之前把 `REVIEW SCOPE` 段追加到 packet 末尾：上一审查点的提交、之后的 N 个提交与
  M 个改动文件、以及「聚焦这些变动，但跨切面风险仍要报」的指令。
  `llm` 模式的模型看不到仓库，这段是它唯一知道「审什么」的来源。
- 跑完之后（至少一家成功）把游标推进到被审的 HEAD。
- **算不出增量就退回全量，并说明原因**，绝不假装增量：
  - `no-review-point`：这个工作空间还没审过
  - `history-rewritten`：记录的提交已不是 HEAD 的祖先（rebase/force-push）
  - `not-a-git-worktree`：不是 git 仓库
  - `no-new-commits`：HEAD 就是审查点，没什么可审

### 第一次用

游标为空时是**全量**。如果这个项目之前已经审过，把游标播种到那次审的提交上，
下一次就自动变成增量：

```bash
node -e 'import("./src/review-points.js").then((m) => {
  const ws = "/abs/path/to/repo";
  m.setReviewPoint(m.resolveReviewPointPath(ws), ws, { commit: "<上次审的 SHA>", reviewedAt: new Date().toISOString(), runId: "seeded" });
})'
```

## 二、对照与收尾

读 `runs[].answer`，**逐条对照代码**判定，然后：

```bash
cat > /tmp/findings.json <<'EOF'
[
  {"model":"Claude Sonnet 5.5","title":"问题标题","claimed":"缺陷","severity":4,
   "verdict":"成立","action":"已修 abc123","note":"依据 file:line"}
]
EOF
model-team record-findings --run-id <run_id> --json /tmp/findings.json --write
```

- `claimed`：`缺陷`（审计）/ `方向`（分叉）/ `方案`（推理）；`severity` 1～5。
- `verdict`：`成立` / `不成立` / `不采用` / `待验证`。
- 不带 `--write` 是演练；`model` 必须是本场参评模型（会校验）。
- 用户选定方案后再跑 `record-outcome`：

```bash
model-team record-outcome --run-id <run_id> --json /tmp/outcome.json --write
# [{"model":"...","fit":4,"satisfaction":5,"match":"是"}]
```

## 三、查看与维护

| 命令 | 用途 |
| --- | --- |
| `model-team summary --kind 事后审计` | 各模型声称/成立/假阳性/独有/质量分 |
| `model-team models list` | 可用模型（`*` = 默认名单） |
| `model-team models add/remove <spec>` | 增删默认名单 |
| `model-team routes` | 默认名单 + harness + 近 7 天用量 |
| `model-team doctor` | 本机 harness 就绪探测（只读、不耗 token） |
| `model-team run --plan-only` | 只打印执行计划（不调模型），排查配置 |
| `model-team usage --dim tool --range-days 7` | 用量统计 |
| `model-team selfcheck` | 账本与日志一致性 |
| `model-team backfill --run-id <id> --write` | 中断场次从日志补账 |
| `model-team refresh-usage --write --only-empty` | 回填 token |
| `model-team weekly --week current` | 生成周报（`~/.model-team/weekly/<ISO周>/`） |
| `model-team review-point show` | 看当前审查点与下次增量范围（`--workspace` 指定仓库） |
| `model-team review-point reset` | 清掉审查点，下次审计退回全量 |

## 四、模型名怎么写

`cli-<harness>/<model-id>`，例如：

- `cli-claude/claude-sonnet-5-5`
- `cli-grok/grok-4-7`
- `cli-agy/claude-sonnet-5-5-high`（agy 的强度写在模型 id 里）
- `cli-devin/swe-2@@max`（需要单独强度时用双 `@@`）

不确定就先 `model-team models list | grep <关键词>`；名字写错会**响亮报错**并列出可用项。

## 五、失败语义

- `status`：`done` 有正文 / `no-result` 空正文 / `failed` 抛错或非零退出。
- 失败原因写在 `runs[].error`（含 CLI stderr 尾部）。
- CLI harness 的 token 由各 CLI 事件流决定；拿不到时记 0，不代表没消耗。
- 某家配额耗尽（如 `RESOURCE_EXHAUSTED 429`）会明确失败——换一家，别重试到天亮。
