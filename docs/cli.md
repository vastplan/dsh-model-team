# model-team CLI

给**其他 agent / 脚本**用的命令行入口：不依赖 DSH，只走 CLI harness（claude / agy / grok / pi / opencode / qoder / devin / zcode / cline / agent）。

与插件内的 `model_team` 工具**共用同一本账**（`~/.model-team/ledger/model-audit-reviews.db`）与同一套会话日志（`~/.model-team/runs/<场次ID>/`）。

## 安装

```bash
# 全局可用（npm link 到本仓库）
npm link

# 或直接跑
node /path/to/dsh-plugins/model-team/cli.js --help
```

## 输出约定

- **stdout**：JSON（或人读表格，取决于子命令）。
- **stderr**：进度与错误。
- 退出码：`0` 成功 / `1` 有未通过项 / `2` 参数或运行错误。

## 配置（可选）

默认读 `~/.model-team/cli.json`（`--config <path>` 或 `$MODEL_TEAM_CLI_CONFIG` 覆盖）：

```json
{
  "defaultModels": ["cli-claude/claude-sonnet-5-5", "cli-grok/grok-4-7"],
  "cliModels": [],
  "discoverCli": true,
  "ledgerPath": "",
  "runsRoot": ""
}
```

`defaultModels` 只在**页面没有可用执行组**时兜底。

### 模型来源优先级

1. `--models` 命令行点名；
2. `--group <id|名字>` 只跑某个执行组；
3. **DSH 页面配置**（`$DSH_HOME/storages/model_team_config.json`）：按 `--kind` 取绑定的执行组，
   组内候选按顺序回落、停用组跳过——与插件页同一套语义；
4. `~/.model-team/cli.json` 的 `defaultModels`。

排查用 `--plan-only`（不调模型）：

```bash
model-team run --kind audit --plan-only
```

输出 `roster_source` 与每个组的候选列表。

## 子命令

| 命令 | 说明 |
| --- | --- |
| `run` | 跑一场审计/分叉/推理，输出 `{run_id, kind, ledger, quality_eval, next, runs[]}` |
| `record-findings` | 写对照结论（`--run-id --json --write`），自动重算 `session_summary` |
| `record-outcome` | 写契合分/满意度/选用匹配 |
| `summary` | 按模型汇总声称/成立/假阳性/独有/质量分 |
| `selfcheck` | 账本与日志一致性自检 |
| `normalize` | 模型名归一（`--write` 落库） |
| `refresh-usage` | 从会话日志回填 token（`--write`，`--only-empty` 只补空值） |
| `backfill` | 被中断场次从日志重建 `calls` 行 |
| `usage` | 按 tool / provider / model 统计近 N 天用量 |
| `weekly` / `post` | 生成/重写周报（`~/.model-team/weekly/<ISO周>/`） |
| `report` | 导出窗口数据 JSON |
| `index` | 重建归档入口页 |
| `models list/catalog/check/prices` | 名单与对照表 |
| `routes` | 默认名单 + 每家 harness + 近 7 天用量 |
| `doctor` | harness 就绪探测（只读、不耗 token） |
| `quota` | 余额缓存（读 `~/.model-team/balance/quota-cache.json`） |

## 给其他 agent 的调用示例

```bash
model-team run \
  --kind audit \
  --packet /tmp/packet.md \
  --slice order-service \
  --models cli-claude/claude-sonnet-5-5,cli-grok/grok-4-7 \
  --workspace /abs/path/to/repo \
  --timeout 600
```

返回里每条形如：

```json
{
  "model": "cli-claude/claude-sonnet-5-5",
  "status": "done",
  "answer": "...",
  "duration_s": 42.1,
  "input_tokens": 21025,
  "output_tokens": 812,
  "log": "/Users/.../runs/<run_id>/xxx.json"
}
```

拿到 `run_id` 后必须收尾：

```bash
cat > /tmp/findings.json <<'EOF'
[{"model":"Claude Sonnet 5.5","title":"并发写丢更新","claimed":"缺陷","severity":4,"verdict":"成立","action":"已修","note":"..."}]
EOF
model-team record-findings --run-id <run_id> --json /tmp/findings.json --write
```

## 嵌套保护

CLI 会读 `MODEL_TEAM_ACTIVE`：被调模型若再执行 `model-team`，立即退出（避免指数级嵌套烧 token）。
