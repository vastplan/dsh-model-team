/**
 * 多模型团队（Host 半）。
 *
 * 调用面有两条：
 * - DSH 原生：`ctx.llm`（纯推理）与 `ctx.subagents`（读仓库的子 Agent）；
 * - CLI harness：pi / opencode 等外部 CLI 的无头模式，按 `src/harness/` 的协议定义接入。
 *
 * 可用模型 = DSH 已注册模型 ∪ `cliModels` 里声明的 CLI 模型。
 * 进度面仍是 `ctx.jobs`（每次 run 一个 job，逐模型一行），两条调用面共用。
 *
 * 账本面：`node:sqlite`（甲方案：独立库文件，不经过 storageDomain 的全量载入）。
 * 读取面：`TYPERT` 描述符（A1：Client 通过 `ctx.remote.modelTeam` 读账本与周报）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import z from '@deepseek-ai/schemastery';

import { callKeyOf, defaultLedgerPath, openLedger, packetHash } from './src/ledger.js';
import { buildInfo, buildInfoLine } from './src/buildinfo.js';
import { registerBundledSkill } from './src/skill.js';
import { listAttachments, readAttachments } from './src/attach.js';
import {
  cliCatalogEntries, harnessFor, listHarnesses, registerBuiltinHarnesses, registerConfiguredHarnesses, runHarness,
} from './src/harness/index.js';
import { harnessAvailable } from './src/harness/availability.js';
import { localStamp, newRunId, openRunDir, snapshotInput, writeBalanceLog, writeSessionLog } from './src/sessionlog.js';
import {
  candidatesOf, openConfig, readBinding, readBindings, readGroups, readPrefs,
  saveBinding,

  saveGroup as storeGroup, deleteGroup as dropGroup, savePrefs as storePrefs,
} from './src/groups.js';
import { resolveTeam, splitEffort } from './src/team.js';
import { factsForModel, WEEKLY_PREAMBLE } from './src/weekly.js';
import { reportsDir, writeReport } from './src/report.js';
import { publishReports } from './src/publish.js';

/**
 * 本入口模块被**求值**的时刻。
 *
 * 放在入口顶层而不是 `src/buildinfo.js` 里：ESM 模块实例在进程内只求值一次，
 * 共享依赖自己记的时间戳在插件重载后仍是首次 import 的旧值，自检会永远喊「落后」。
 * 入口每次重载都会重新求值，所以这个时刻才是可靠的判定基准。
 */
const ENTRY_LOADED_AT = Date.now();

/**
 * 三类活动的标签与开场提示词（与 model-team 技能同一套口径）。
 *
 * `preamble` 是 **llm 模式**（纯推理、看不到仓库）的口径：明确禁止调工具与开子代理，
 * 免得模型拿工具调用把一次简单推理变成一串无用的往返。
 *
 * `subagentPreamble` 是 **subagent 模式**的口径：那种模式的全部意义就是让模型**自己去读仓库**，
 * 再用 llm 的「不要调用任何工具」去约束它，等于把子代理废掉（真机：两家模型因此明确拒答，
 * 说「我被禁止调用工具，所以没读过 index.js」）。没写 `subagentPreamble` 的活动沿用 llm 版。
 */
export const KINDS = {
  audit: {
    label: '事后审计',
    preamble:
      '你就是被询问的模型。直接在本回复找本切片缺陷。不要调用任何工具、不要开并行名单、不要把任务描述再送审一轮。\n',
    subagentPreamble:
      '你就是被询问的模型。**先自己读代码再下结论**：用 read / grep / glob 打开被审文件，'
      + '每条结论都要落到 file:line，并引用原文。不要开并行名单、不要把任务描述再送审一轮、不要修改任何文件。\n'
      // 真机踩过：某个模型在思考里反复自我盘问、一遍遍推翻自己的结论，单家跑了 96 分钟。
      // 约束写在这里比只靠看门狗好——它让模型自己收敛，而不是等到被掐掉。
      + '**效率要求**：先把改动涉及的文件读完再动笔，不要一边读一边反复自我质疑；'
      + '结论定稿就写，不需要在思考里预演多遍。若某个判断无法用代码证实，标「待验证」即可，不要绕圈。\n',
  },
  design: {
    label: '设计分叉',
    preamble:
      '本场是设计分叉，不是事后审计，也不是专责推理。\n你就是被询问的模型。直接在本回复给出 2～4 个可执行方向。\n'
      + '硬规则：禁止拍板，禁止施工稿/文件清单/编码顺序。每个方向写清：一句话、对使用者意味着什么、取舍、失败时怎样、非目标。可以标一个推荐，推荐不是结论。\n',
  },
  reason: {
    label: '专责推理',
    preamble:
      '本场是专责推理，不是设计分叉，也不是事后审计。\n你就是被询问的模型。直接在本回复给出结构化方案：结论、步骤、风险、非目标。\n'
      + '硬规则：不要改成 2～4 个方向（那是设计分叉）。禁止施工稿/文件清单/编码顺序。可以标推荐，推荐不是用户已选定。\n',
  },
};

/**
 * 默认报告目录：技能侧的归档根 `~/.model-team`。
 *
 * 它本来就是 git 仓（公开归档），报告写进去后按目录的 git 状态自动决定是否推送。
 * 用户可在设置里改成别的目录。
 */
function defaultReportDir() {
  return join(homedir(), '.model-team');
}

/**
 * DSH 数据根：`DSH_HOME` 优先，否则 `~/.dsh`（与 dsh 自己的 `dshHomePath()` 同一约定）。
 * 账本放它下面的独立目录，不与会话、存储、技能混在一起。
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv) return fromEnv;
  return join(homedir(), '.dsh');
}

function usageOf(usage) {
  if (!usage) return null;
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
    reasoning: usage.reasoningTokens ?? 0,
  };
}

/**
 * 归一化模型标识，让「同一模型、不同厂商路由」能聚到一起。
 *
 * 例：`deepseek-v4.1-flash`（opencode-go）、`group/auto-deepseek-v4-1-flash`（magpie 路由组）
 * 都归到 `deepseek-v4.1.flash`。只做保守归一：小写、去路由前缀、把 `-`/`.` 视作同一分隔符。
 */
export function modelKeyOf(provider, id, name) {
  const raw = String(id ?? '').toLowerCase();
  // 去掉路由组前缀（magpie 的 group/auto-、opencode-go/ 之类）
  const stripped = raw
    .replace(/^(group\/auto-)/, '')
    .replace(/^(workbuddy-ai\/|workbuddy\/)/, '')
    .replace(/^[a-z0-9-]+\//, '');
  return stripped.replace(/[-_.]/g, '-').replace(/-+/g, '-');
}

/**
 * 设置页「可用 CLI 范围」的选项：DSH 自己 + 已登记的全部 harness。
 *
 * `available` 只做本机是否装好/配好的静态判断（与目录过滤同一口径），
 * 未安装的也列出来，但开关置灰——让用户知道「为什么它不在目录里」。
 */
function harnessScopeOptions() {
  return [
    { id: 'dsh', label: 'DSH（内置模型）', available: true, kind: 'dsh' },
    ...listHarnesses().map((definition) => ({
      id: definition.id,
      label: definition.label,
      available: harnessAvailable(definition),
      kind: 'cli',
    })),
  ];
}

/** 可用 CLI 范围的归一：`null` = 全部；否则只保留集合内的 id。 */
function enabledScopes(prefs) {
  const list = prefs?.enabledHarnesses;
  return Array.isArray(list) ? new Set(list.map((item) => String(item))) : null;
}

/**
 * 枚举 DSH 当前可调用的全部模型。
 *
 * - `'dsh'` 在范围内才列 DSH 原生模型；
 * - CLI 只列范围内的（`cliCatalogEntries` 的 `enabled`）；
 * - 范围外 CLII 不做模型发现。
 *
 * @param prefs - 用户偏好（读 `enabledHarnesses`）；缺省 = 全部。
 */
async function listCatalog(ctx, config = {}, prefs = null) {
  const scopes = enabledScopes(prefs);
  const dshInScope = !scopes || scopes.has('dsh');
  const catalog = [];
  for (const provider of (dshInScope ? ctx.llm.listProviders() : [])) {
    let models = [];
    try {
      models = await ctx.llm.listModels(provider.id);
    } catch {
      models = [];
    }
    for (const model of models) {
      // 每个模型支持哪些思考档由适配器决定（opencode 只给部分档、magpie 只有 low/high/max）；
      // 页面据此出下拉，不让用户手输（输错会被 provider 拒掉或静默降档）。
      let efforts = [];
      let defaultEffort = '';
      try {
        const info = await ctx.llm.resolveModelInfo(provider.id, model.id);
        efforts = (info.reasoning?.efforts ?? []).map((effort) => effort.id);
        defaultEffort = info.reasoning?.defaultEffort ?? '';
      } catch {
        efforts = [];
      }
      catalog.push({
        provider: provider.id,
        id: model.id,
        name: model.name ?? model.id,
        efforts,
        defaultEffort,
        // 跨厂商的同一模型标识：去掉 `provider/` 前缀与 `group/auto-` 之类的路由前缀后归一，
        // 页面按它把「同一模型的不同厂商路由」聚成一个执行组候选池。
        modelKey: modelKeyOf(provider.id, model.id, model.name ?? model.id),
      });
    }
  }
  // CLI harness 模型：显式 cliModels + 各 CLI 自动发现的模型（可用性过滤在 catalog 内）。
  const cliEntries = scopes && [...scopes].every((id) => id === 'dsh')
    ? []
    : await cliCatalogEntries(config, ctx.logger, {
      ctx,
      discover: config.discoverCli !== false,
      enabled: scopes ? new Set([...scopes].filter((id) => id !== 'dsh')) : null,
    });
  catalog.push(...cliEntries);
  return catalog;
}

/**
 * 一次纯推理调用：折叠 chunk 流为正文、思考与用量。失败只落在本行。
 *
 * @param options.onPhase - 阶段回调（可选）。流式过程中按 chunk 类型播报
 *   `thinking` / `answering` / `tool`，并带上该阶段最新的一小段文本，
 *   供进度窗显示「当前在做什么、说到哪儿了」。回调内部的异常一律吞掉——
 *   它只服务于可观测性，绝不能因为渲染失败把模型调用带崩。
 */
async function callLlm(ctx, entry, options, signal) {
  // 档位兜底：模型不支持该档时退回 provider 默认，而不是让这家直接失败
  // （历史配置里可能存着模型不支持的档，例如 Kimi K3 在 magpie 下没有 reasoningEfforts）。
  let effort = entry.reasoningEffort;
  if (effort) {
    try {
      const info = await ctx.llm.resolveModelInfo(entry.provider, entry.model);
      const supported = (info.reasoning?.efforts ?? []).map((item) => item.id);
      if (supported.length && !supported.includes(effort)) {
        ctx.logger?.warn?.(`model-team: ${entry.name} 不支持「${effort}」，改用默认档`);
        effort = '';
      } else if (!supported.length) {
        effort = '';
      }
    } catch {
      /* 查询不到就照原样尝试 */
    }
  }
  let text = '';
  let reasoning = '';
  let usage = null;
  let failure = '';
  const asked = [{ role: 'user', content: [{ type: 'text', text: options.prompt }] }];
  const chunks = [];
  /** 播报阶段；回调失败不影响调用（可观测性不能反向拖垮业务）。 */
  const phase = (name, snippet) => {
    try { options.onPhase?.(name, snippet); } catch { /* 忽略 */ }
  };
  for await (const chunk of ctx.llm.stream({
    provider: entry.provider,
    model: entry.model,
    // 传兜底后的 effort，而不是原值：不支持该档时才会真的退回默认档
    // （早先这里传的是 entry.reasoningEffort，兜底算了但没生效）。
    ...(effort ? { reasoningEffort: effort } : {}),
    messages: asked,
    signal,
  })) {
    chunks.push(chunk);
    if (chunk.type === 'reasoning-delta') {
      reasoning += chunk.text;
      phase('thinking', reasoning);
    } else if (chunk.type === 'text-delta') {
      text += chunk.text;
      phase('answering', text);
    } else if (chunk.type === 'tool-call-delta'
      // 工具的 `block-start` 用 `blockType`（不是 `block.type`）标识块类型。
      || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')) {
      phase('tool', '');
    } else if (chunk.type === 'usage') {
      usage = usageOf(chunk.usage);
    } else if (chunk.type === 'finish') {
      // `finish.reason.kind` 共 5 种（见 dsh-llm 的 FinishReasonMap）：
      // `stop`（正常）/ `tool-calls` / `max-tokens` / `aborted` / `error`。
      //
      // 早先只处理了后两种，另外两种会被**当成成功**：
      // - `max-tokens`：输出被截断，正文只写了一半，却记成 `done`，
      //   周报把它算成一次完整成功；
      // - `tool-calls`：模型在「不要调用工具」的 llm 模式下执意发起了工具调用，
      //   正文通常为空，却也可能残留前言。
      // 两者都必须标成失败并说清原因，不能让半截回答冒充结论。
      const kind = chunk.reason.kind;
      if (kind === 'error') failure = chunk.reason.failure?.message ?? '调用失败';
      else if (kind === 'aborted') failure = chunk.reason.failure?.message ?? '已取消';
      else if (kind === 'max-tokens') failure = `输出被截断（max-tokens），正文只有 ${text.length} 字，不可当作完整结论`;
      else if (kind === 'tool-calls') {
        // 一律失败：llm 模式不提供工具，出现 tool-calls 说明模型没按约束作答。
        // 有正文时通常只是「前言」，不能拿半截话冒充完整结论（早先只有正文为空才算失败）。
        failure = text.trim()
          ? '模型在 llm 模式下发起了工具调用（tool-calls），正文可能只是前言，不可当作完整结论'
          : '模型发起了工具调用（tool-calls），llm 模式下不提供工具，无正文';
      }
    }
  }
  // 消息按"请求 + 回复"落，与技能侧会话日志的 `messages` 语义对齐（按时间顺序）。
  const messages = [
    ...asked.map((message) => ({ role: message.role, content: message.content })),
    {
      role: 'assistant',
      content: [
        ...(reasoning ? [{ type: 'reasoning', text: reasoning }] : []),
        ...(text ? [{ type: 'text', text }] : []),
      ],
      ...(usage ? { usage } : {}),
    },
  ];
  if (failure) {
    const error = new Error(failure);
    error.messages = messages;
    // 只把**助手正文**作为部分结果：`messages` 里还有用户 prompt，
    // 让 catch 去 flatMap 全部 text block 会把 prompt 当成模型输出。
    error.partialText = text;
    // **把已采到的 usage 挂在 error 上**：宿主 adapter 在流中途报错/取消时，
    // 会先 yield `usage` 再 yield `finish(error)`（dsh-llm-pi-ai 的 mapUsage 顺序），
    // 所以这里通常已经拿到用量。早先抛错时把它丢了，失败行的 token 记成 0，
    // 与「失败也烧了钱」的事实相反。
    if (usage) error.usage = usage;
    throw error;
  }
  return { text, reasoning, usage, messages };
}

/**
 * 一次子 Agent 调用：子 Agent 继承工作区与工具，可读仓库；结果取它的最终文本。
 *
 * @param parentAgent - **必需的**当前活动 Agent（`exec.agent`）。Host 的
 *   `startActivation` 会校验 `agents.get(parent.id) === parent`，缺了直接抛
 *   UNAUTHORIZED（"subagent creation requires the exact live parent agent"）。
 *   早先没传，`mode=subagent` 每次必失败。
 */
async function callSubagent(ctx, subagents, entry, options, signal, parentAgent) {
  if (!parentAgent) {
    throw new Error('mode=subagent 需要当前活动的 Agent（缺 exec.agent），本次无法起子代理');
  }
  // 子代理自己的 stream 不经过我们这个 ctx（它在子 Agent 的会话里跑），
  // 所以拿不到 `text-delta`。但它每提交一个事件都会广播 `session/event`，
  // 里面有 `tool/call` / `tool/result` / `assistant/message` —— 订阅它就能
  // 把「正在调什么工具、调到第几步、最后说了什么」实时播报出去。
  // （早先只发一句「子代理执行中」，进度窗等于没有反馈。）
  try { options.onPhase?.('thinking', '子代理启动中'); } catch { /* 忽略 */ }
  const activation = await subagents.startActivation({
    provider: 'spawn',
    label: `team · ${entry.name}`,
    delivery: 'caller',
    signal,
    request: {
      // `parent` 与 `prompt` 是 Host 的必填项；`signal` 在 spec 顶层，不在 request 里。
      //
      // `prompt` 必须是 **ContentBlock[]**，不是字符串：Host 会执行
      // `[...prompt, { type: 'text', text: … }]` 往里追加指引（`withContinuableReturnGuidance`），
      // 传字符串会被逐字符展开。
      parent: parentAgent,
      prompt: [{ type: 'text', text: options.prompt }],
      agentOptions: {
        provider: entry.provider,
        model: entry.model,
        ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
      },
      ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    },
  });
  // 订阅子代理的**逐 chunk 流式帧**：`agent/assistant-stream` 是进程内即时发布，
  // 帧里带 `text-delta` / `reasoning-delta` / `tool-call-delta`——
  // 这正是各家 CLI 无头模式（`--print --output-format stream-json`）能给出的粒度，
  // 只是换成 DSH 原生事件拿。比 `session/event` 好：那是「提交后」才触发，
  // 一个步骤只在结束时响一次；这里每个 token 都能看到。
  //
  // 只在 `payload.agent.id === childId` 时取用，别把父会话或别家子代理的流混进来。
  let unsubscribe = null;
  try {
    const childId = String(activation.childId ?? '');
    // 累积正文与思考，供进度行显示「说到哪儿了」。
    let body = '';
    let thoughts = '';
    const emit = (name, snippet) => { try { options.onPhase?.(name, snippet); } catch { /* 忽略 */ } };
    if (childId) {
      const off = ctx.on?.('agent/assistant-stream', (payload) => {
        try {
          const frame = payload?.frame;
          // **帧里没有 `agent` 字段**（声明写的 `{ agent, frame }` 与实际 emit 不符：
          // agent-loop 只 `emit({ frame })`）。身份藏在 `attemptId` 里，格式是
          // `${sessionId}:${attempt}`（见 `AssistantStreamAttempt` 构造函数），
          // 所以按 `childId:` 前缀过滤才不会把父会话/别家的流混进来。
          // `agent.id` 就是子代理的 session id（实测与 `activation.childId` 逐字相同），
          // 按它过滤即可；`attemptId` 也带同一前缀，两者等价。
          if (String(payload?.agent?.id ?? '') !== childId) return;
          if (!frame || frame.type !== 'chunk') {
            // `start` = 这一轮模型调用开始：**清掉上一轮的累积**。
            // 不清的话第二轮的「回答」会从第一轮的正文接下去，tail 里看到的是拼接过的旧内容。
            if (frame?.type === 'start') {
              body = '';
              thoughts = '';
              emit('thinking', '开始推理');
            }
            return;
          }
          const chunk = frame.chunk;
          if (!chunk) return;
          if (chunk.type === 'reasoning-delta') {
            thoughts += chunk.text ?? '';
            emit('thinking', thoughts);
          } else if (chunk.type === 'text-delta') {
            body += chunk.text ?? '';
            emit('answering', body);
          } else if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')) {
            emit('tool', chunk.name ? `调用 ${chunk.name}` : '调用工具');
          }
        } catch { /* 帧形状不认识就跳过，绝不影响子代理本身 */ }
      });
      // `ctx.on` 返回 Cordis 的 effect disposer（可能不是普通函数），统一当可调用物处理。
      if (typeof off === 'function') unsubscribe = off;
    }
  } catch { /* 订阅失败只影响进度，不影响执行 */ }
  try {
    const result = await activation.result;
    const text = (result?.output ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('');
    // Host 的 activation.result **没有 usage**（`captureLocalResult` 只给
    // output/stopReason/structured），所以子代理的 token 一律记未采集，
    // 不要拿 undefined 去凑一个 0 出来冒充「用量为 0」。
    const usage = null;
    const messages = [
      { role: 'user', content: [{ type: 'text', text: options.prompt }] },
      { role: 'assistant', content: result?.output ?? [] },
    ];
    return { text, reasoning: '', usage, messages };
  } finally {
    try { unsubscribe?.(); } catch { /* 已释放 */ }
    await activation.dispose();
  }
}

/**
 * 一次 CLI harness 调用：把条目翻译成协议定义能吃的输入，交给 `runHarness`。
 *
 * CLI 的 `cwd` 必须是绝对 workspace（Host 进程的 cwd 不是项目目录）；
 * 取消、超时、看门狗、进度都由 `runHarness` 统一处理，返回形状与 `callLlm` 对齐。
 */
async function callCli(ctx, entry, options, signal) {
  const definition = harnessFor(entry.harness);
  const workspace = String(options.workspace ?? '').trim();
  if (!workspace || !isAbsolute(workspace)) {
    throw new Error(
      `CLI 条目「${entry.name}」需要绝对 workspace（作为 CLI 的 cwd）：${workspace || '(未给)'}；`
      + '请在 model_team 里传 workspace=<项目绝对路径>',
    );
  }
  return await runHarness({
    ctx,
    def: definition,
    entry,
    prompt: options.prompt,
    workspace,
    tmpDir: options.tmpDir,
    signal,
    onPhase: options.onPhase,
    timeoutMs: options.timeoutMs,
    silenceMs: options.silenceMs,
  });
}

const STATUS_LABEL = { queued: '排队', running: '运行', done: '完成', 'no-result': '无结果', failed: '失败', stopped: '已停止' };

/**
 * 结构化进度标记：写进 job 输出环的一行 JSON，Client 据此渲染「每模型一行」。
 *
 * job 名册只给任务级进度；逐模型状态必须自己往输出环里写，并由 Client 解析。
 * 前缀用不可见控制字符，确保不会和模型正文混在一起。
 */
export const TEAM_PROGRESS_PREFIX = '\u0000team-progress\u0000';

/**
 * 正在跑的场次 -> 停止句柄表。
 *
 * Client 的「停止某个模型」按钮走 Remote 方法 `stopModel(runId, id)`：
 * 页面拿得到 `runId`（进度行所属 job 的 detail 里有），但**拿不到** Host 里的
 * AbortController——只能通过这个进程级注册表转一手。
 * 场次结束即整条删除，避免长进程里越积越多。
 */
export const ACTIVE_RUNS = new Map();

/**
 * job id → 场次 runId 的别名表。
 *
 * 为什么需要：Client 的进度窗只拿得到 **job id**（`team-…`，由 `ctx.jobs` 生成），
 * 而 `ACTIVE_RUNS` 按场次 `runId`（`2026-…`，由 `newRunId()` 生成）建表。
 * 早先 `stopModel` 直接拿 job id 去查，两个命名空间永不相等，单家「停止」恒返回
 * `stopped:false`——按钮亮一下又复原，模型继续跑（真机踩过）。
 *
 * 别名在 `jobs.start()` 返回 job id 后立刻写入，场次结算时与 `ACTIVE_RUNS` 一起删除。
 */
export const JOB_RUN_IDS = new Map();

/** 一行进度最多带多少个字符的「当前输出」：够看出来在说什么，又不撑爆输出环。 */
const PROGRESS_TAIL_CHARS = 120;

/**
 * 取一段文本末尾用于进度展示：压平空白、截到 {@link PROGRESS_TAIL_CHARS}。
 *
 * 取的是**尾部**而不是开头：模型正在说什么，看最后一句最有信息量。
 * 前端还会再截一次（卡片窄），这里先给出足够短的一截，避免输出环被长正文挤爆
 * （job 输出环有保留上限，超出会丢最早的字节——那正是进度行的位置）。
 */
function progressTail(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= PROGRESS_TAIL_CHARS) return flat;
  return `…${flat.slice(-PROGRESS_TAIL_CHARS)}`;
}

/**
 * 生成一行结构化进度（供 job.append 使用）。
 *
 * `phase` 是执行中的当前动作：
 * - `queued` 排队、`thinking` 思考、`tool` 调工具、`answering` 回答、
 *   `done` 完成、`no-result` 无结果、`failed` 失败。
 *
 * `tail` 是该阶段最新的一小段输出，仅用于展示；不落账本、不进会话日志。
 */
/**
 * 控制行：`{\u0000team-control\u0000: {type, ...}}`。
 *
 * 为什么需要它：逐行进度写进 job 输出环，而输出环**会被截断**
 * （运行 256KB / 结算 16KB，Client 还有 128KB 上限）。行多、输出长时，
 * 最早的行会被整段丢掉——监控窗里「顺序乱跳」「已完成的消失」都是这个原因。
 *
 * 所以关键信息另外走两条**单条**消息：
 * - `roster`：开场写一次，列出本次全部模型**及其固定位次**（顺序从此不再靠推断）；
 * - `final`：收尾写一次，把每家的最终状态打包（它在最尾部，永远落在保留窗口里）。
 *
 * @param type - `roster` | `final`。
 * @param payload - 该类型的负载。
 * @returns 一行文本。
 */
export function teamControlLine(type, payload) {
  return `\u0000team-control\u0000${JSON.stringify({ type, ...payload })}\n`;
}

export function teamProgressLine(row) {
  return `${TEAM_PROGRESS_PREFIX}${JSON.stringify({
    // 进度行的身份 = `model@@effort` + 槽位。**必须带槽位**：两个执行组共用同一条
    // 模型路由时（或列表项与组胜出撞车），只按 `model@@effort` 生成 id，
    // 后到的行会覆盖先到的（客户端按 id 去重），进度窗里就少显示一家。
    // 与账本主键 (run_id, call_id, slot) 取同一维度。
    id: row.id ?? `${row.model}@@${row.reasoningEffort || 'default'}@${row.groupId ?? ''}`,
    name: row.label ? `${row.name}${row.label ? ` · ${row.label}` : ''}` : row.name,
    model: row.model,
    effort: row.reasoningEffort || '',
    status: row.status,
    phase: row.phase ?? row.status,
    tail: row.tail ? progressTail(row.tail) : '',
    seconds: row.seconds ?? null,
    error: row.error ?? '',
  })}\n`;
}

/** 表格单元格：竖线与换行会破坏 Markdown 表格，统一压平。 */
const cell = (text, max = 60) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/**
 * 把一场执行渲染成对话里的 Markdown：**每个模型一行**。
 *
 * 进度环里的逐行输出只有展开任务面板才看得到；对话里必须自己给出结果表，
 * 否则用户只看到一整段 JSON。
 */
export function renderTeamMarkdown(value) {
  const models = value?.models ?? [];
  if (!models.length) return '（没有模型参与）';
  const ok = models.filter((row) => row.status === 'done').length;
  const lines = [
    `**${value.label ?? value.kind}** · ${value.mode === 'subagent' ? '子代理' : '纯推理'} · `
      + `${ok}/${models.length} 有结果`,
  ];

  lines.push('');
  lines.push('| 模型 | 厂商路由 | 强度 | 状态 | 耗时 | tokens | 摘要 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const row of models) {
    const usage = row.usage ? `${row.usage.input ?? 0}/${row.usage.output ?? 0}` : '—';
    const summary = row.status === 'done' ? cell(row.text, 48) : cell(row.error, 60);
    lines.push(`| ${cell(row.name, 28)} | ${cell(row.model, 40)} | ${row.reasoningEffort || '默认'} `
      + `| ${STATUS_LABEL[row.status] ?? row.status} | ${row.seconds ?? 0}s | ${usage} | ${summary} |`);
  }

  // 每组试过哪些路由（主备回落时值得看一眼）
  const tried = models.filter((row) => Array.isArray(row.tried) && row.tried.length > 1);
  if (tried.length) {
    lines.push('');
    lines.push('回落记录：');
    for (const row of tried) lines.push(`- ${cell(row.name, 30)}：${row.tried.join(' → ')}`);
  }

  if (value.logDir) {
    lines.push('');
    lines.push(`会话日志：\`${value.logDir}\``);
  }
  // 阶段播报次数：进度窗只读 job 输出环，外部无法直接观察，这里补一行让它可见。
  // 数字是**节流后**的条数（同阶段 400ms 内合并），不是原始 chunk 数。
  const phases = models.map((row) => `${cell(row.name, 20)}=${row.phaseCount ?? 0}`).join(' · ');
  if (models.some((row) => row.phaseCount !== undefined)) {
    lines.push('');
    lines.push(`阶段播报：${phases}`);
  }

  // Host 半落后于磁盘源码时明确警告：DSH 的 HMR 只热更 Client 半，改完 index.js 必须重载插件。
  if (value.build && value.build.hostFresh === false) {
    lines.push('');
    lines.push(`⚠ ${value.build.note}`);
  }
  return lines.join('\n');
}

const statusLine = (row) =>
  `${STATUS_LABEL[row.status] ?? row.status}${row.usage ? ` · in ${row.usage.input} out ${row.usage.output}` : ''}`
  + `${row.seconds === undefined ? '' : ` · ${row.seconds}s`}`
  + `${row.error ? ` · ${row.error.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;

/** 一场执行：并发调用、逐行推进度、返回结构化结果。 */
export async function runTeam(ctx, handle, args, config, configStore, signal, parentAgent) {
  const kind = args.kind ?? 'audit';
  const meta = KINDS[kind];
  if (!meta) throw new Error('kind 只接受 audit、design 或 reason');
  const packet = String(args.packet ?? '').trim();
  if (!packet) throw new Error('packet 为空');

  const runPrefs = configStore ? readPrefs(configStore) : null;
  const scopes = enabledScopes(runPrefs);
  const catalog = await listCatalog(ctx, config, runPrefs);
  if (!catalog.length) {
    throw new Error(scopes
      ? '可用 CLI 范围里没有可调用的模型：请到 设置 → 多模型团队 打开 DSH 或至少一个 CLI'
      : 'DSH 里没有已注册的 LLM provider 或 provider 未列出模型，请先在设置里配置模型');
  }
  const viaSubagent = args.mode === 'subagent';
  if (viaSubagent && !ctx.get('subagents')) throw new Error('mode=subagent 需要 subagents 服务');
  const allGroups = readGroups(configStore);
  const enabledGroups = allGroups.filter((group) => group.enabled);
  const wantedGroups = args.groups ?? [];
  const askedModels = (args.models ?? []).filter((item) => String(item ?? '').trim());

  // 参与的执行组：
  //   1. 显式 `groups` 参数优先（按 id 或名字点）；
  //   2. 否则看这类活动（audit/design/reason）绑定了哪些组——绑定决定「谁参与」；
  //   3. 绑定为空时退回全部启用的组（兼容未配置绑定的旧用法）。
  const boundIds = readBinding(configStore, kind);
  // 选组：**解析为空就报错，绝不退回「跑全目录」**。
  //
  // 踩过：绑定的组被删光之后 `pickedGroups` 变成空数组，下游 `team` 走到
  // `resolveTeam([], catalog, config.models ?? [])`，而 `resolveTeam` 在两者都空时
  // 返回**整个 catalog**——一次审计把二十几家全叫起来，账单和时间都炸。
  // 所以这里把「没配置」和「配置了但解析不到」分开：后者必须响亮失败。
  let pickedGroups;
  if (wantedGroups.length) {
    pickedGroups = allGroups.filter(
      (group) => wantedGroups.includes(group.groupId) || wantedGroups.includes(group.name),
    );
    if (!pickedGroups.length) {
      const available = allGroups.map((group) => `${group.groupId}(${group.name})`).join(', ') || '（无）';
      throw new Error(`groups 里没有匹配的执行组：${wantedGroups.join(', ')}；可用：${available}`);
    }
  } else if (boundIds.length) {
    const boundGroups = allGroups.filter((group) => boundIds.includes(group.groupId));
    // `enabled=false` 表示「不参加默认执行」，绑定了也不该上场（字段语义见 src/groups.js）。
    pickedGroups = boundGroups.filter((group) => group.enabled);
    if (!pickedGroups.length) {
      const missing = boundIds.filter((id) => !allGroups.some((group) => group.groupId === id));
      const disabled = boundGroups.length - boundGroups.filter((group) => group.enabled).length;
      const why = [
        missing.length ? `已不存在 ${missing.join(', ')}` : '',
        disabled ? `${disabled} 个处于停用状态` : '',
      ].filter(Boolean).join('；') || '没有匹配到执行组';
      throw new Error(
        `「${meta.label}」绑定的执行组没有可运行的：${why}；`
        + '请到 设置 → 多模型团队 重新绑定/启用，或用 models 点名',
      );
    }
  } else {
    pickedGroups = enabledGroups;
    if (!pickedGroups.length && allGroups.length) {
      throw new Error('没有启用的执行组：请到 设置 → 多模型团队 启用至少一个，或用 models 点名');
    }
  }

  // **点名 = 覆盖同款**，不是「把绑定清空重来」。
  //
  // 语义（这里踩过两次，写清楚）：
  // - 绑定的执行组**照常参与**——配置说了算什么，就别因为点名把它丢掉；
  // - 点名只覆盖**同一款模型的同一档思考强度**：例如绑定里有
  //   `magpie/group/auto-kimi-k3@@high`，点名 `magpie/devin/kimi-k3@@high`，
  //   那是「同一个 kimi-k3、同 high 档」，两条只跑点名的那条；
  // - 点名里**绑定没有的模型**照样追加进来（相当于临时加一家）。
  //
  // 早先的实现是「点名就把 groupPlans 清空」，于是传 3 家就真的只跑 3 家，
  // 用起来像「配置没生效」。
  const explicitModels = askedModels.length > 0;
  const explicitEntries = explicitModels ? resolveTeam(askedModels, catalog, []) : [];
  /** 点名条目的身份：模型 + 强度（不看 provider 路由，那正是要被覆盖的维度）。 */
  const askKey = (entry) => `${entry.model}@@${entry.reasoningEffort || 'default'}`;
  const askedKeys = new Set(explicitEntries.map(askKey));

  // 点名条目 → 它属于哪个组：**按「候选里出现过这条路由」判**。
  // 一个组 = 同一个逻辑模型的多个厂商路由，所以只要点名命中组内任一候选，
  // 就认为「用户要这一组改走这条路由」。
  const claimOf = new Map(); // askKey -> 点名的 entry
  for (const entry of explicitEntries) claimOf.set(askKey(entry), entry);
  const claimed = new Map(); // groupId -> 接管它的点名条目
  for (const group of pickedGroups) {
    for (const raw of candidatesOf(group)) {
      // 失效候选（路由改名/下线）在这里也要跳过：点名匹配不值得为一条旧路由抛错。
      let entry = null;
      try { entry = resolveTeam([raw], catalog, [])[0]; } catch { continue; }
      if (!entry) continue;
      const hit = claimOf.get(askKey(entry));
      if (hit) { claimed.set(group.groupId, hit); break; }
    }
  }

  const groupPlans = pickedGroups.map((group) => {
    // 被点名接管：**整组换成那一条**（主备链只留它，不再回落）。
    // 早先的实现只是把「同款同档」的候选从链里摘掉——点名备选时会退化成跑主力，
    // 与用户意图正好相反（真机：点名 devin/kimi-k3，账本里跑的却是 group/auto-kimi-k3）。
    const takeover = claimed.get(group.groupId);
    if (takeover) return { group, candidates: [takeover] };
    // 逐候选解析：**失效的候选跳过，不拖垮同组其它候选**。
    // 路由改名（`group/auto-*` → `auto/*`）时，旧候选会解析失败；
    // 以前一条失败就 `resolveTeam` 抛错、整场无法开跑，现在改用同组的备选继续。
    const candidates = [];
    const unknown = [];
    for (const raw of candidatesOf(group)) {
      try {
        const [resolved] = resolveTeam([raw], catalog, []);
        if (resolved) candidates.push(resolved);
      } catch {
        unknown.push(raw);
      }
    }
    if (unknown.length) {
      ctx.logger?.warn?.(
        `model-team: 执行组「${group.name}」的候选不在 DSH 已注册路由里，已跳过：${unknown.join(', ')}`,
      );
    }
    if (!candidates.length) {
      ctx.logger?.warn?.(`model-team: 执行组「${group.name}」没有可用候选，本场跳过`);
    }
    return { group, candidates };
  }).filter((plan) => plan.candidates.length);

  // 没被任何组认领的点名：作为独立列表项追加（相当于临时加一家）。
  const team = explicitModels
    ? explicitEntries.filter((entry) => ![...claimed.values()].some((t) => askKey(t) === askKey(entry)))
    : (pickedGroups.length ? [] : resolveTeam([], catalog, config.models ?? []));
  const skippedGroups = 0;
  if (explicitModels) {
    ctx.logger?.info?.(
      `model-team: 点名 ${explicitEntries.length} 家 → 接管 ${claimed.size} 个执行组`
      + `（整组改走点名的那条路由）、追加 ${team.length} 条新条目；`
      + `其余 ${groupPlans.length - claimed.size} 个执行组照常按配置跑`,
    );
  }

  if (!team.length && !groupPlans.length) {
    throw new Error('没有可执行的模型：既没有名单项，也没有可用的执行组（候选可能已不在 DSH 路由里，请在设置里更新）');
  }

  // 开场提示词按调用面选：CLI / subagent 要鼓励模型读仓库，llm 要禁止它调工具。
  // 没有专门写 `subagentPreamble` 的活动（design / reason）沿用 llm 版。

  // 本次参与的所有条目（列表项 + 每个组的候选）：决定要不要准备 CLI 用的清单。
  const candidateEntries = [...team, ...groupPlans.flatMap((plan) => plan.candidates)];
  const hasCli = candidateEntries.some((entry) => entry.transport === 'cli');
  const workspace = String(args.workspace ?? '').trim();

  // `files` 在三种调用面上都生效，但**给的东西不同**：
  //
  // - `llm`：模型看不到仓库，所以附**正文**（带行号）——这是它唯一的代码来源。
  // - `subagent` / `cli`：自己有 read/grep/glob 或等价工具，能自己打开文件；
  //   附正文只会重复占 token（而且可能与磁盘不一致）。它们需要的是**范围**：
  //   「这次审计涉及这些文件」。所以只给清单，正文让它自己读。
  let attachmentLlm = { appendix: '', files: [], missing: [] };
  let attachmentList = { appendix: '', files: [], missing: [] };
  // 只有真的存在 DSH llm 条目时才需要读正文（纯 CLI 场次不该因为目录文件被误判成「读不到」）。
  const hasDshLlm = !viaSubagent && candidateEntries.some((entry) => entry.transport !== 'cli');
  if (Array.isArray(args.files) && args.files.length) {
    // **有读不到的文件就直接失败**，不要静默跳过。
    // 踩过：Host 进程的 cwd 不是项目目录，相对路径全解析成「不存在」，
    // 附件为空却照常开跑，模型回一句「没看到附件」——调用方完全看不出是路径错了。
    if (viaSubagent || hasCli) attachmentList = listAttachments(args.files, args.workspace);
    if (hasDshLlm) attachmentLlm = readAttachments(args.files, args.workspace);
    const missing = [...new Set([...attachmentLlm.missing, ...attachmentList.missing])];
    if (missing.length) {
      throw new Error(
        `这些文件读不到：${missing.join(', ')}`
        + `（workspace=${args.workspace ?? '(未给)'}）；files 用绝对路径或显式传 workspace`,
      );
    }
  }
  const promptLlm = `${meta.preamble}${packet}\n${attachmentLlm.appendix}`;
  // subagent 与 CLI 都要「先自己读代码」：有 subagentPreamble 就用它，别再套 llm 的「禁止调工具」。
  const promptTools = `${meta.subagentPreamble || meta.preamble}${packet}\n${attachmentList.appendix}`;
  /** CLI 条目与 subagent 一样拿「范围清单」；DSH llm 条目拿正文。 */
  const promptFor = (entry) => (entry.transport === 'cli' || viaSubagent ? promptTools : promptLlm);
  const attachedFiles = [...new Set([...attachmentLlm.files, ...attachmentList.files])];

  // **总开关**：只有打开「保存数据」才落会话日志与账本。
  //
  // 关着时整场是「用完即走」：不建场次目录、不写真快照、不写账本行。
  // 于是周报与报告自然也没有数据可看——这正是开关要实现的效果，
  // 不需要在那边再单独判一次（它们的输入就是账本）。
  // 显式 `save: true/false` 可本场覆盖配置，便于临时试一次。
  const persistWanted = args.save === undefined
    ? (configStore ? Boolean(readPrefs(configStore).persistData) : false)
    : args.save === true;

  // 会话落盘（与技能侧同一规则）：场次目录 + 输入快照，跑完每家再写会话日志。
  const runsRoot = config.runsRoot || join(dshHome(), 'model-team', 'runs');
  let runDir = null;
  if (persistWanted) {
    try {
      runDir = openRunDir(runsRoot, args.runId);
      snapshotInput(runDir, 'packet.txt', packet);
      snapshotInput(runDir, 'prompt.md', prompt);
    } catch (error) {
      ctx.logger?.warn?.(`model-team: 场次目录不可写，本次不落会话日志：${error instanceof Error ? error.message : String(error)}`);
      runDir = null;
    }
  }
  const startedAt = Date.now();

  /** 跑一个候选一次，返回落盘后的行。失败只落本行，不抛。 */
  /**
   * 单家停止的控制器：`id -> AbortController`。
   *
   * 整场只有一个父 `signal`（工具调用 abort、或任务面板取消 job 时 abort 本场开关），
   * 它一 abort 就全停；但用户真正想做的往往是「某一家太慢，先掐掉它」。所以每个
   * 候选再分一个子 controller，父 signal abort 时一并 abort。
   * （`AbortSignal.any` 只能合并信号、不能单掐某一家，所以每家仍要自己的 controller。）
   * Client 的「停止」按钮走 Remote 的 `stopModel`（job id + 进度行 id），在
   * `ACTIVE_RUNS` 里找回本场的 `stops` 表再 `cancel()`；早先这里写的是「输出环里的
   * cancel 意图行」，那条路从未实现过。
   */
  const stops = new Map();
  // 让 Remote 侧的 `stopModel` 能找到本场次的停止句柄。
  const runKey = String(args.runId ?? '');
  if (runKey) ACTIVE_RUNS.set(runKey, stops);

  /**
   * 并发闸门。
   *
   * DSH 的 `maxActiveSubagents` **默认只有 8**（`dsh-subagent` 的
   * `z.number().default(8)`；profile 里已调到 16），一次点 11 家会有 3 家直接被拒：
   * `subagent limit reached (active child limit: 8)`——不是模型的问题，是我们同时开了太多。
   *
   * 这些子代理跑的是**不同厂商的不同模型**，不是同一家的并发限流，所以上限可以放宽。
   * 闸门的默认值取 12：比当前最大的执行组数（11）略大，让它们真的一次全开；
   * 想更保守就用 `concurrency` 参数或配置压回去（它仍然是一道防手滑的闸）。
   *
   * 只对 `subagent` 模式生效；`llm` 模式是纯流式调用，没有子代理名额限制。
   */
  const maxConcurrent = viaSubagent
    ? Math.max(1, Number(args.concurrency ?? config.concurrency ?? 12) || 12)
    : Number.POSITIVE_INFINITY;
  let running = 0;
  const waiters = [];
  const withSlot = async (task) => {
    if (running >= maxConcurrent) {
      await new Promise((resolve) => waiters.push(resolve));
    }
    running += 1;
    try {
      return await task();
    } finally {
      running -= 1;
      const next = waiters.shift();
      if (next) next();
    }
  };

  const runCandidate = async (entry, label, groupId = '') => {
    const row = {
      model: entry.model,
      provider: entry.provider,
      name: entry.name,
      reasoningEffort: entry.reasoningEffort,
      label,
      // 槽位：进度行 id 与账本主键都用它区分「同模型在不同组里各跑一次」。
      groupId,
      status: 'queued',
      text: '',
      reasoning: '',
      usage: null,
      error: '',
      messages: [],
    };
    const began = Date.now();
    const startedStamp = localStamp(new Date(began));
    row.status = 'running';
    row.phase = 'thinking';

    // 每家的独立取消：父 signal 一 abort 就跟着停，也可以被单独掐掉。
    const stop = new AbortController();
    const stoppedByUser = { value: false };
    const onParentAbort = () => stop.abort();
    if (signal?.aborted) stop.abort();
    else signal?.addEventListener?.('abort', onParentAbort, { once: true });
    const callSignal = stop.signal;
    // 进度行 id 与停止句柄共用同一个 key，Client 点「停止」时按 id 找回来。
    const stopKey = row.groupId
      ? `${row.model}@@${row.reasoningEffort || 'default'}@${row.groupId}`
      : `${row.model}@@${row.reasoningEffort || 'default'}@`;
    stops.set(stopKey, {
      cancel: () => { stoppedByUser.value = true; stop.abort(); },
    });
    const shown = `${row.name}${row.reasoningEffort ? `@${row.reasoningEffort}` : ''}`;
    handle.append(teamProgressLine(row), { channel: 'log' });
    handle.append(`[${label ? `${label} · ` : ''}${shown}] 运行 · ${entry.provider}/${entry.model}\n`, { channel: 'log' });

    // 流式阶段播报：节流到最多每 `PHASE_MIN_INTERVAL_MS` 一次，且阶段变化立即发。
    //
    // 为什么必须节流：每个 delta 都 append 一行会把 job 输出环塞满（有保留上限，
    // 超出丢最早字节），进度行本身就会被挤掉；而且 Client 每次 setState 都是整窗重渲染。
    // 实测 1000 个 delta 只产生约 13 行。
    const PHASE_MIN_INTERVAL_MS = 400;
    let lastPhase = '';
    let lastPush = 0;
    // 看门狗：每一次「有输出」都刷新时间戳。超时就从这里算，不是从开始算。
    // 真机踩过：DeepSeek 单个子代理跑了 96 分钟（22.6K 字符的思考一直在自我盘问、
    // 反复推翻结论），期间一直有断断续续的输出，所以「总超时」拦不住它；
    // 真正要防的是「长时间没有实质进展」。
    let lastOutputAt = Date.now();
    let sawOutput = false;
    const onPhase = (name, snippet) => {
      const now = Date.now();
      lastOutputAt = now;
      sawOutput = sawOutput || Boolean(snippet);
      const changed = name !== lastPhase;
      if (!changed && now - lastPush < PHASE_MIN_INTERVAL_MS) {
        // 同阶段且未到间隔：只更新行上保存的最新片段，等下一次真正推送时带上。
        row.tail = snippet || row.tail;
        return;
      }
      lastPhase = name;
      lastPush = now;
      row.phase = name;
      row.tail = snippet || '';
      row.phaseCount = (row.phaseCount ?? 0) + 1;
      handle.append(teamProgressLine(row), { channel: 'log' });
    };

    // 单家软上限 + 无输出看门狗（口径照技能侧 `invoke_exec`：
    // `attempt_timeout_sec` / `silence_sec`，缺省 1500s / 600s）。
    const attemptTimeoutMs = (Number(args.attempt_timeout ?? config.attempt_timeout_sec ?? 1500)) * 1000;
    const silenceMs = (Number(args.silence ?? config.silence_sec ?? 600)) * 1000;
    let stopNote = '';
    const hardTimer = setTimeout(() => {
      stopNote = '超时';
      stop.abort();
    }, Math.max(1000, attemptTimeoutMs));
    // 看门狗每 5 秒看一次：距上次输出超过 `silenceMs` 就掐掉这一家。
    const silenceTimer = setInterval(() => {
      if (Date.now() - lastOutputAt > silenceMs) {
        stopNote = '无输出超时';
        stop.abort();
      }
    }, 5000);

    try {
      const options = {
        prompt: promptFor(entry),
        workspace,
        tmpDir: runDir ?? join(tmpdir(), 'model-team'),
        timeoutMs: attemptTimeoutMs,
        silenceMs,
        maxDepth: args.max_depth,
        onPhase,
      };
      // 范围外 CLI：目录里不会出现，但旧执行组/历史点名可能残留，调用前再拦一次。
      if (entry.transport === 'cli' && scopes && !scopes.has(entry.harness)) {
        throw new Error(`CLI「${entry.harness}」不在可用范围内：请到 设置 → 多模型团队 打开它，或换用其它路由`);
      }
      const result = entry.transport === 'cli'
        ? await callCli(ctx, entry, options, callSignal)
        : viaSubagent
          ? await callSubagent(ctx, ctx.get('subagents'), entry, options, callSignal, parentAgent)
          : await callLlm(ctx, entry, options, callSignal);
      row.text = result.text;
      row.reasoning = result.reasoning;
      row.usage = result.usage;
      row.messages = result.messages ?? [];
      if (result.exitCode !== undefined) row.exitCode = result.exitCode;
      if (result.stopNote) row.stopNote = result.stopNote;
      if (Array.isArray(result.unmapped) && result.unmapped.length) row.unmapped = result.unmapped;
      if (entry.transport === 'cli' && result.exitCode !== 0) {
        row.status = 'failed';
        row.error = result.stopNote || `CLI 退出码 ${result.exitCode}`;
      } else {
        row.status = row.text.trim() ? 'done' : 'no-result';
      }
    } catch (error) {
      // 用户点「停止」导致的取消不是模型失败：单独标成 stopped，别记进失败率。
      // 超时/无输出优先于「被取消」：定时器先置 `stopNote` 再 abort，
      // 若先判 signal.aborted 会把超时误记成「主动取消」。
      const timeoutNote = error?.stopNote === '超时' || error?.stopNote === '无输出超时'
        ? error.stopNote
        : (stopNote || '');
      if (stoppedByUser.value) {
        row.status = 'stopped';
        row.error = '已手动停止';
      } else if (timeoutNote) {
        row.status = 'failed';
        row.error = timeoutNote;
        row.stopNote = timeoutNote;
      } else if (signal?.aborted) {
        // 整场被取消（job 被 kill、工具调用被 abort）：也不是模型不可用。
        row.status = 'stopped';
        row.error = '已取消';
      }
      row.error = row.error || (error instanceof Error ? error.message : String(error));
      row.messages = error?.messages ?? row.messages ?? [];
      // 失败也可能已经烧了 token：adapter 在报错/取消前会先发 usage，
      // `callLlm` 把它挂在 error 上，这里接回来，别让失败行在账本里记成 0。
      if (error?.usage) row.usage = error.usage;
      // 失败时保留已经流出来的正文（截断的 `max-tokens`、CLI 半截输出尤其需要），
      // 否则会话日志里只剩一句错误，看不出模型当时说到哪儿。
      // **只取助手消息**：`messages` 里还有用户 prompt，全量 flatMap 会把 prompt 当成输出。
      const partial = error?.partialText
        || (error?.messages ?? [])
          .filter((message) => message?.role === 'assistant')
          .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
          .filter((block) => block?.type === 'text')
          .map((block) => block.text)
          .join('');
      if (partial) row.text = partial;
      // 已被用户停止的保持 `stopped`，不要被这里覆盖回 `failed`。
      if (row.status !== 'stopped') row.status = 'failed';
    } finally {
      clearTimeout(hardTimer);
      clearInterval(silenceTimer);
      // 收工就把停止句柄摘掉：Client 再点也不会命中已结束的模型。
      stops.delete(stopKey);
      signal?.removeEventListener?.('abort', onParentAbort);
      // 看门狗掐掉的这一家：`stopNote` 只在**确实被掐**时才有值
      // （abort 之后模型若仍然正常返回了结果，说明它赶在定时器之前跑完，不该标超时）。
      // `stopped` 不能被回写成 `failed`：用户主动停的那一下恰好撞上定时器时，
      // 账本会把「主动停止」记成「失败」，与上面 catch 里的口径矛盾。
      if (stopNote && row.status !== 'done' && row.status !== 'stopped') {
        row.status = 'failed';
        row.stopNote = stopNote;
        if (!row.error) row.error = stopNote;
      }
    }
    const ended = Date.now();
    row.seconds = Math.round((ended - began) / 1000);
    // 结算后阶段与状态同义，尾巴保留最后一小段正文（进度窗据此显示「说到哪儿了」）。
    row.phase = row.status;
    row.tail = row.text || row.tail || '';
    row.tool = entry.transport === 'cli'
      ? entry.harness
      : viaSubagent ? 'dsh-subagent' : 'dsh-llm';
    // 会话日志与调度留痕：正文、思考、消息、用量全落，便于备查。
    if (runDir) {
      try {
        row.logPath = writeSessionLog(runDir, {
          model: row.model, provider: row.provider, reasoningEffort: row.reasoningEffort,
          tool: row.tool, status: row.status, error: row.error,
          text: row.text, messages: row.messages ?? [], usage: row.usage,
          started: startedStamp, finished: localStamp(new Date(ended)), durationS: row.seconds,
          hop: `${row.provider}-${row.tool}`,
          groupId: row.groupId ?? '',
          exitCode: row.exitCode,
          stopNote: row.stopNote,
          unmapped: row.unmapped,
        });
        writeBalanceLog(runDir, {
          model: row.model, provider: row.provider,
          reasoningEffort: row.reasoningEffort, tool: row.tool,
          groupId: row.groupId ?? '',
        });
      } catch (error) {
        ctx.logger?.warn?.(`model-team: 会话日志写入失败（${row.model}）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    handle.append(teamProgressLine(row), { channel: 'log' });
    // 把阶段播报次数一并写进 stdout：进度窗只读 job 输出环，外部无法直接观察，
    // 这一行让「阶段到底有没有推送」在对话里可见（0 = 一次都没推，说明订阅没生效）。
    handle.append(
      `[${label ? `${label} · ` : ''}${row.name}] ${statusLine(row)} · 阶段播报 ${row.phaseCount ?? 0} 次\n`,
      { channel: 'stdout' },
    );
    return row;
  };

  const rows = [];
  const total = team.length + groupPlans.length;
  // 进度只报数字：活动名由 Client 从 job label 单独取，避免标题行出现两次。
  handle.updateProgress(`${total} 家`);

  // **开场就固定名册**：把本次要跑的每一家（含所属组）按声明序写一次。
  // Client 用它当唯一的顺序来源——不依赖后面逐行进度是否被截断。
  handle.append(teamControlLine('roster', {
    rows: [
      ...team.map((entry) => ({
        id: `${entry.model}@@${entry.reasoningEffort || 'default'}@`,
        name: entry.name,
        model: entry.model,
        effort: entry.reasoningEffort || '',
        groupId: '',
      })),
      ...groupPlans.map((plan) => {
        const head = plan.candidates[0];
        return {
          id: `${head.model}@@${head.reasoningEffort || 'default'}@${plan.group.groupId}`,
          name: plan.group.name,
          model: head.model,
          effort: head.reasoningEffort || '',
          groupId: plan.group.groupId,
        };
      }),
    ],
  }), { channel: 'log' });

  // 列表项：每项各跑一次，并发。
  const listRuns = team.map(async (entry) => await withSlot(async () => {
    const row = await runCandidate(entry, '');
    rows.push(row);
    handle.updateProgress(`${rows.length}/${total} 已结束`);
  }));

  // 执行组：组内按主备顺序回落——第一个有结果即停，后面的不再调用。
  const groupRuns = groupPlans.map(async (plan) => await withSlot(async () => {
    const tried = [];
    // 备选**不能提前播报成「等待」**。
    //
    // 早先组一开始就把所有候选播成 `queued`，结果主力成功时备选永远不会跑，
    // 那条「排队」却一直挂在监控窗里——真机看到「一个排队的 K3」就是这么来的
    // （`g-kimi-k3` 的备选是 `devin/kimi-k3`）。
    // 正确做法：只有**主力失败、备选真的要被启用时**，才在它启动前一刻播一次等待；
    // 从未被启用的候选不留任何进度行。
    for (const [index, entry] of plan.candidates.entries()) {
      // 只标序号，不区分「主力/备选」：顺序本身就是回落顺序。
      if (index > 0) {
        // 走到这里说明前一个候选失败了，这一个即将被启用——此刻它确实在排队。
        handle.append(teamProgressLine({
          model: entry.model,
          provider: entry.provider,
          name: entry.name,
          reasoningEffort: entry.reasoningEffort,
          label: `${plan.group.name} · ${index + 1}`,
          groupId: plan.group.groupId,
          status: 'queued',
          phase: 'queued',
          tail: '上一跳失败，准备回落',
        }), { channel: 'log' });
      }
      const row = await runCandidate(entry, `${plan.group.name} · ${index + 1}`, plan.group.groupId);
      tried.push(row);
      if (row.status === 'done') break;
      if (signal?.aborted) break;
    }
    const winner = tried.find((row) => row.status === 'done');
    // 落账本时只记真正生效的那一个；没被启用的后面几条不占账本行。
    const recorded = winner ?? tried[tried.length - 1];
    // 进度窗的槽位 id **固定用名册里主力那条**，不跟着胜出的备选变。
    // 否则回落成功时：主力行永远停在 failed，备选又另起一行，一个组显示成两条
    // （真机：监控窗里一条假失败 + 一条名册外多出来的行）。
    const head = plan.candidates[0];
    const slotId = `${head.model}@@${head.reasoningEffort || 'default'}@${plan.group.groupId}`;
    rows.push({
      ...recorded,
      slotId,
      name: winner ? plan.group.name : `${plan.group.name}（全组失败）`,
      // 槽位：账本主键是 (run_id, call_id, slot)，同一个 model@@effort 出现在
      // 列表项与组胜出（或两个组）时靠 groupId 各占一行，不再互相覆盖。
      groupId: plan.group.groupId,
      tried: tried.map((row) => `${callKeyOf(row.model, row.reasoningEffort)}:${row.status}`),
    });
    handle.updateProgress(`${rows.length}/${total} 已结束`);
  }));

  await Promise.all([...listRuns, ...groupRuns]);
  if (runKey) ACTIVE_RUNS.delete(runKey);

  // **收尾写一条完整快照**：每条一个对象，含最终状态、耗时、摘要尾部。
  // 它在输出环的最尾部，永远落在保留窗口内——逐行进度被截掉也不影响它。
  // Client 收到后以它为准整表覆盖，不再靠「有没有见到过某行」来推断。
  try {
    handle.append(teamControlLine('final', {
      rows: rows.map((row) => ({
        // 执行组用名册槽位 id（`slotId`），列表项用自己的 id；Client 以 final 为整表真源。
        id: row.slotId ?? `${row.model}@@${row.reasoningEffort || 'default'}@${row.groupId ?? ''}`,
        name: row.name,
        model: row.model,
        effort: row.reasoningEffort || '',
        status: row.status,
        phase: row.phase ?? row.status,
        seconds: row.seconds ?? null,
        error: row.error ?? '',
        tail: row.text ? row.text.slice(-120) : '',
        groupId: row.groupId ?? '',
        tried: row.tried ?? [],
      })),
    }), { channel: 'log' });
  } catch { /* 快照失败不影响返回值 */ }

  return {
    kind,
    label: meta.label,
    mode: viaSubagent ? 'subagent' : 'llm',
    runId: args.runId,
    logDir: runDir ?? '',
    // 本次是否落盘：关着时账本/会话日志都没有，报告与周报自然为空。
    persisted: persistWanted && Boolean(runDir),
    started_at: startedAt,
    finished_at: Date.now(),
    // 这次 llm 模式实际附上了哪些文件（subagent 模式恒为空）：便于事后对账「模型到底看到了什么」。
    attached: attachedFiles,
    missingFiles: [],
    // 因为点名而被跳过的执行组数量（0 = 本次就是按配置跑的）。
    skippedGroups,
    models: rows,
  };
}

/**
 * 生成一份周报：聚合 + 指定模型总结 + 落库。
 *
 * @param options.prefs - 用户在设置页存的偏好（`storageDomain` 的 `prefs`）。
 *   **总结模型必须优先读它**：设置页「周报总结模型」写的是 `prefs.reportModel`，
 *   而 `config.reportModel` 是 `cordis.patch.yml` 里的静态默认值（通常是空串）。
 *   早先只读 `config`，导致界面上配了模型也永远报「未配置总结模型」。
 * @param options.store - 配置存储句柄；传了就地读最新偏好（页面刚改完也能生效）。
 */
async function buildWeekly(ctx, ledger, config, options, signal) {
  if (!ledger) throw new Error('账本未就绪：SQLite 打不开（看 Host 日志里的真因）');
  // 总开关关着就没数据可聚合——明确报错，别返回一份「0 场次」的空周报误导人。
  if (!options.persist) {
    throw new Error('周报需要账本数据，但「保存数据」开关是关的：'
      + '请在设置 → 多模型团队里打开「保存数据」，之后跑过的场次才会进周报');
  }
  const to = options.to ?? Date.now();
  const from = options.from ?? to - 7 * 24 * 60 * 60 * 1000;
  const facts = ledger.aggregate(from, to);

  // 偏好优先级：调用参数 > 设置页偏好 > 静态配置 > 名单首项。
  let storedPrefs = options.prefs;
  if (!storedPrefs && options.store) {
    try { storedPrefs = readPrefs(options.store); } catch { /* 读不到就退回静态配置 */ }
  }
  const summaryModel = options.model
    || storedPrefs?.reportModel
    || config.reportModel
    || (typeof config.models?.[0] === 'string' ? config.models[0] : '')
    || '';
  let summary = '';
  let summaryError = '';
  if (!facts.calls) {
    summary = '本周期没有调用记录。';
  } else if (!summaryModel) {
    summaryError = '未配置总结模型：请在设置页「多模型团队 → 周报总结模型」选一个，或配 config.reportModel';
  } else {
    // `listCatalog` 与 `resolveTeam` 都在 try 内：模型配错（下线/改名）时应当
    // 落一条 `summaryError`，而不是让整个周报连已算好的聚合一起丢掉。
    try {
      const catalog = await listCatalog(ctx, config, storedPrefs);
      const [entry] = resolveTeam([summaryModel], catalog, []);
      const asked = `${WEEKLY_PREAMBLE}${factsForModel(facts)}\n`;
      const result = await callLlm(ctx, entry, { prompt: asked }, signal);
      summary = result.text.trim() || '（总结模型返回了空正文）';
    } catch (error) {
      summaryError = error instanceof Error ? error.message : String(error);
    }
  }

  const createdAt = Date.now();
  const reportId = `weekly-${to}-${createdAt.toString(36)}`;
  ledger.recordReport({
    reportId,
    from,
    to,
    summaryModel: summaryModel || '(未配置)',
    summary: summaryError ? `总结失败：${summaryError}` : summary,
    facts: JSON.stringify(facts),
    createdAt,
  });
  // 顺手按保留期清理：账本不是核心功能，库不该无限长大。
  try {
    ledger.prune(createdAt);
  } catch (error) {
    ctx.logger?.warn?.(`model-team: 账本清理失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return { reportId, from, to, summaryModel, summary, summaryError, facts };
}

export const inject = ['llm', 'tools'];

export const Config = z.object({
  /** 模型看到的工具名。 */
  toolName: z.string().default('model_team'),
  /** 默认参与的模型名单；支持 `provider/model@@effort` 与 `{model, reasoningEffort}`。 */
  models: z.array(z.union([z.string(), z.object({
    model: z.string(),
    reasoningEffort: z.string().default(''),
  })])).default([]),
  /** 周报总结模型；缺席时取名单首项。 */
  reportModel: z.string().default(''),

  /** 账本库路径；缺席时取 `$DSH_HOME/model-team/ledger.db`。 */
  ledgerPath: z.string().default(''),

  /** 会话日志根；缺席时取 `$DSH_HOME/model-team/runs`（与技能侧 `runs/` 同规则）。 */
  runsRoot: z.string().default(''),

  /**
   * 额外的 CLI harness 定义（协议见 `docs/harness-protocol.md`）。
   *
   * 内置 `pi` / `opencode`，这里可覆盖它们或新增其它 CLI；每份定义是纯数据：
   * `id / command / args / model / thinking / prompt / output / usage / capabilities`。
   */
  harnesses: z.array(z.any()).default([]),

  /**
   * CLI 模型目录：`tool` 必须是已登记的 harness id。
   *
   * 条目会以合成 provider `cli-<tool>` 出现在模型目录里，例如：
   * `{ id: 'k3', tool: 'pi', provider: 'magpie', model: 'group/auto-kimi-k3',
   *    modelKey: 'kimi-k3', name: 'Kimi K3' }` → 可用 `cli-pi/k3@@max` 点名/编组。
   */
  cliModels: z.array(z.object({
    id: z.string(),
    tool: z.string(),
    provider: z.string().default(''),
    model: z.string(),
    name: z.string().default(''),
    modelKey: z.string().default(''),
    efforts: z.array(z.string()).default([]),
    defaultEffort: z.string().default(''),
  })).default([]),

  /**
   * 是否自动发现各 CLI 支持的模型（默认开）。
   *
   * 关掉后只使用 `cliModels` 里显式声明的条目；适合模型太多、只想手选几家的场景。
   */
  discoverCli: z.boolean().default(true),
});

/** Host 服务：Client 通过 `ctx.remote.modelTeam` 读账本与周报（A1）。 */
export class ModelTeamService extends TypertRemoteService {
  static inject = ['typert'];

  constructor(ctx) {
    super(ctx, 'modelTeam', { namespace: 'modelTeam' });
    this.ledger = null;
    this.pluginConfig = {};
  }

  /** 最近的场次与逐模型行，供插件页面展示。 */
  async overview(limit) {
    const ledger = this.ledger;
    if (!ledger) return { ready: false, runs: [], calls: [], reports: [], settings: this.settings() };
    const runs = ledger.recentRuns(limit ?? 20);
    const calls = ledger.callsOf(runs.map((run) => run.runId));
    const reports = ledger.recentReports(5);
    return { ready: true, runs, calls, reports, settings: this.settings() };
  }

  /** 生成周报（页面按钮与 `model_team_weekly` 工具共用）。 */
  async weekly(request, signal) {
    // 每次都现读偏好：用户刚在页面改完总结模型，不该还要等重载。
    let store = null;
    try { store = await this.ensureStore?.(); } catch { /* 读不到就用静态配置 */ }
    const prefs = store ? readPrefs(store) : null;
    return await buildWeekly(this.ctx, this.ledger, this.pluginConfig ?? {}, {
      from: request?.from, to: request?.to, model: request?.model, store,
      persist: Boolean(prefs?.persistData),
    }, signal);
  }

  /** 执行组、偏好与可用范围（页面配置区读）。 */
  async configuration() {
    const store = await this.ensureStore();
    const groups = readGroups(store);
    const prefs = readPrefs(store);
    const bindings = readBindings(store);
    return {
      groups,
      prefs,
      bindings,
      // 范围选择器用：DSH 自己 + 8 家 CLI，附「本机是否装好」。
      harnesses: harnessScopeOptions(),
      ready: Boolean(store),
    };
  }

  /** 可选的模型目录（页面下拉框用）。 */
  async catalog() {
    const prefs = readPrefs(await this.ensureStore());
    const models = await listCatalog(this.ctx, this.pluginConfig ?? {}, prefs);
    return { models };
  }

  /** 把 `provider/model@@effort` 解析成模型显示名；解析不到就退回原始串。 */
  async nameOfModel(spec) {
    const raw = String(spec ?? '').trim();
    let catalog = [];
    try {
      catalog = await listCatalog(this.ctx, this.pluginConfig ?? {}, readPrefs(await this.ensureStore()));
    } catch {
      catalog = [];
    }
    const known = (value) => catalog.some(
      (model) => `${model.provider}/${model.id}` === value || model.id === value,
    );
    const { head } = splitEffort(raw, known);
    const hit = catalog.find((model) => `${model.provider}/${model.id}` === head || model.id === head);
    return hit?.name ?? head;
  }

  /** 写一个执行组（新增或覆盖）。 */
  async saveGroup(request) {
    if (!request?.groupId) throw new Error('执行组需要 groupId');
    const candidates = (request.candidates ?? []).map((candidate) => ({
      model: String(candidate.model ?? ''),
      reasoningEffort: String(candidate.reasoningEffort ?? ''),
    }));
    if (!candidates.length || !candidates[0].model.trim()) {
      throw new Error('执行组至少需要一个候选模型');
    }

    // 校验思考强度：模型不支持该档时不能存进去，否则每次调用都会被 provider 拒绝
    // （真机踩过：Kimi K3 在 magpie 下没有 reasoningEfforts，却存了 @high）。
    const catalog = await listCatalog(this.ctx, this.pluginConfig ?? {}, readPrefs(await this.ensureStore()));
    const problems = [];
    for (const candidate of candidates) {
      if (!candidate.reasoningEffort) continue;
      const [provider, ...rest] = candidate.model.split('/');
      const modelId = rest.join('/');
      const hit = catalog.find((model) => model.provider === provider && model.id === modelId)
        ?? catalog.find((model) => model.id === candidate.model);
      if (!hit) continue; // 目录里没有的名字交给运行期报错，这里不拦
      if (!hit.efforts || !hit.efforts.length) {
        problems.push(`${hit.name} 不支持思考强度，已改为默认档（原值 ${candidate.reasoningEffort}）`);
        candidate.reasoningEffort = '';
      } else if (!hit.efforts.includes(candidate.reasoningEffort)) {
        problems.push(`${hit.name} 不支持「${candidate.reasoningEffort}」，可选：${hit.efforts.join('/')}`);
      }
    }
    const unsupported = problems.filter((note) => note.includes('不支持「'));
    if (unsupported.length) throw new Error(unsupported.join('；'));
    // 一个执行组 = 同一个模型的多个厂商路由（主备即为「换厂商」）。
    // 组名不再手填：用模型名，页面与账本都按这个口径。
    const displayName = await this.nameOfModel(candidates[0].model);
    await storeGroup(await this.ensureStore(), {
      groupId: String(request.groupId),
      name: String(request.name ?? '').trim() || displayName,
      candidates,
      enabled: request.enabled !== false,
      order: Number(request.order) || 0,
    });
    return await this.configuration();
  }

  /** 删除一个执行组。 */
  async removeGroup(request) {
    await dropGroup(await this.ensureStore(), String(request?.groupId ?? ''));
    return await this.configuration();
  }

  /**
   * 生成一份静态报告并把路径返回给页面（页面用浏览器打开）。
   *
   * @param request - 窗口天数与标题；缺省 7 天。
   * @returns 报告文件路径（含一个 `-latest.html` 固定名）。
   */
  async openReport(request) {
    const ledger = this.ledger;
    if (!ledger) throw new Error('账本未就绪：SQLite 打不开（看 Host 日志里的真因）');
    const days = Math.max(1, Number(request?.days) || 7);
    const to = Date.now();
    const from = to - days * 24 * 60 * 60 * 1000;
    const kind = request?.kind === 'weekly' ? 'weekly' : 'report';
    const prefs = readPrefs(await this.ensureStore());
    // 总开关关着就没数据可渲染——直接说清楚，别生成一份空报告让人以为「跑过但没记录」。
    if (!prefs.persistData) {
      throw new Error('报告需要账本数据，但「保存数据」开关是关的：'
        + '请在设置 → 多模型团队里打开它');
    }
    const dir = String(prefs.reportDir ?? '').trim() || defaultReportDir();

    // `reuse: true` = 只打开已有报告，不重新生成（页面上的「打开最新」）。
    // 没有现成文件就报错，不静默生成一份新的。
    if (request?.reuse === true) {
      const latest = join(reportsDir(dir), `${kind}-latest.html`);
      if (!existsSync(latest)) {
        throw new Error('还没有生成过报告：请先点「生成并打开」');
      }
      const stamp = statSync(latest).mtimeMs;
      return {
        path: latest,
        latest,
        from: stamp,
        to: stamp,
        title: `近 ${days} 天`,
        repo: '',
        publish: 'reused',
        publishNote: '打开已有报告，未重新生成',
        commit: '',
        github: '',
      };
    }

    const result = writeReport(ledger, dir, { from, to, title: `近 ${days} 天`, kind });

    // 上传：**自动识别报告目录所在的 git 仓库**，有远端就推，没有就跳过。
    // 不做任何配置——目录本身是不是仓、有没有远端，git 自己知道。
    // 上传需同时满足：设置里开启 + 目录在 git 仓里 + 仓库有远端。
    // 任一不满足都只落本地，并在 publishNote 里说清是哪一条。
    const publish = await publishReports(
      result.path,
      `报告 ${new Date(to).toISOString().slice(0, 10)}（近 ${days} 天）`,
      { enabled: prefs.autoUpload === true },
    );

    return {
      path: result.path,
      latest: result.latest,
      from: result.from,
      to: result.to,
      title: result.title,
      repo: publish.remote ?? '',
      publish: publish.status,
      publishNote: publish.note,
      commit: publish.commit ?? '',
      github: publish.pages ?? '',
    };
  }

  /** 绑定：某类活动参与哪些执行组。 */
  async setBinding(request) {
    const kind = String(request?.kind ?? '');
    if (!['audit', 'design', 'reason'].includes(kind)) throw new Error('kind 只接受 audit、design 或 reason');
    const groups = Array.isArray(request?.groupIds) ? request.groupIds.map(String) : [];
    await saveBinding(await this.ensureStore(), kind, groups);
    return await this.configuration();
  }

  /** 写偏好（总结模型等）。 */
  async savePrefs(request) {
    const store = await this.ensureStore();
    const current = readPrefs(store);
    await storePrefs(store, {
      // 逐字段合并：页面可能只改其中一项，缺省保留原值。
      reportModel: request?.reportModel === undefined ? current.reportModel : String(request.reportModel),
      concurrency: request?.concurrency === undefined ? current.concurrency : (Number(request.concurrency) || 0),
      reportDir: request?.reportDir === undefined ? (current.reportDir ?? '') : String(request.reportDir).trim(),
      autoUpload: request?.autoUpload === undefined ? (current.autoUpload === true) : request.autoUpload === true,
      // 总开关：只有显式传 true 才算打开（任何其它值都落 false）。
      persistData: request?.persistData === undefined ? current.persistData === true : request.persistData === true,
      // null = 全开；数组 = 显式范围（去重、去空）。
      enabledHarnesses: request?.enabledHarnesses === undefined
        ? (current.enabledHarnesses ?? null)
        : (Array.isArray(request.enabledHarnesses)
          ? [...new Set(request.enabledHarnesses.map((item) => String(item).trim()).filter(Boolean))]
          : null),
    });
    return await this.configuration();
  }

  /**
   * 停止某个模型（某一场次里的某一条）。
   *
   * 为什么不走 job 的公开 API：job 的 `cancel` 是**整场**取消，
   * 而用户要的是「掐掉这一家太慢的」。所以这里按 `runId + 进度行 id` 找到
   * 那一家的 AbortController，只 abort 它。
   *
   * @param request - `{ runId, id }`：场次 ID 与进度行 id（也是停止表的 key）。
   * @returns `{ stopped: boolean, reason?: string }`。
   */
  async stopModel(request) {
    const asked = String(request?.runId ?? '');
    // Client 手里只有 **job id**（进度窗的 `current.id`），而 `ACTIVE_RUNS` 按场次
    // `runId` 建表。先过一遍别名表，两种 id 都能命中（见 `JOB_RUN_IDS`）。
    const runId = JOB_RUN_IDS.get(asked) ?? asked;
    const id = String(request?.id ?? '');
    /**
     * 进度行 id 由 `teamProgressLine` 生成：`model@@effort@groupId`。
     * Client 的 `id` 可能只带模型（列表项），这里做一次前缀匹配兜底。
     */
    const table = ACTIVE_RUNS.get(runId);
    if (!table) return { stopped: false, reason: `场次 ${asked || '(空)'} 不在运行中` };
    const exact = table.get(id);
    const hit = exact ?? [...table.entries()].find(([key]) => key === id || key.startsWith(`${id}@`))?.[1];
    if (!hit) return { stopped: false, reason: `找不到这条进度：${id}` };
    hit.cancel();
    return { stopped: true };
  }

  /** 当前生效的名单与总结模型，页面据此渲染配置区。 */
  settings() {
    const config = this.pluginConfig ?? {};
    return {
      models: config.models ?? [],
      reportModel: config.reportModel ?? '',
      toolName: config.toolName ?? 'model_team',
      // 页面据此提示「Host 半落后于磁盘源码，需要重载插件」。
      build: buildInfo(ENTRY_LOADED_AT),
    };
  }
}


/**
 * 声明 Remote 方法（等价于 `@Remote` 装饰器）。
 *
 * typert-protocol 把标记存成一个公开字符串属性，装饰器只是往这个属性追加条目；
 * 纯 JS 没有装饰器语法，所以这里按它自己的格式写同一份标记，`remoteMethods()` 读得到。
 */
function markRemote(prototype, methods) {
  Object.defineProperty(prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(methods.map((name) => Object.freeze({
        method: name,
        invocation: Object.freeze({ kind: 'direct' }),
      }))),
    }),
  });
}

/**
 * Service 上必须标成 Remote 的方法。
 *
 * **必须与 `typert.js` 的端点清单、`client.js` 的调用清单三者一致**：
 * DSH 网关解析端点时先找原型上的 `remoteMethods` 标记，**找不到就直接抛
 * `gateway/invocation-unavailable`，不会回退到包的 `typert` 描述符**
 * （`dsh-api-gateway/lib/index.js` 的 `resolveSrcDescriptor`）。
 * 早先这里只标了 3 个，而页面实际调用 8 个 —— 设置页的执行组/绑定/偏好/报告
 * 全都点了没反应，且只表现为一个 RPC 错误，极难定位。
 */
export const REMOTE_METHODS = Object.freeze([
  'overview',
  'weekly',
  'settings',
  'configuration',
  'catalog',
  'saveGroup',
  'removeGroup',
  'setBinding',
  'savePrefs',
  'openReport',
  'stopModel',
]);

/**
 * 三方清单必须一致：**Host 标记 / `typert.js` 描述符 / `client.js` 内联 spec**。
 *
 * 只改一处就是静默失效：Host 加了标记但 Client 没声明 → `ctx.remote.modelTeam.x`
 * 是 `undefined`，按钮点下去毫无反应（真机踩过：`stopModel` 漏在 client 里）。
 * 反过来 Client 声明了但 Host 没标记 → 网关抛 `gateway/invocation-unavailable`。
 *
 * 返回不一致项；空数组表示自洽。
 *
 * @param sources - `{ typеrt, client }` 两个文件全文（由调用方读盘，便于测试注入）。
 * @returns `{ ok, missingInTypert, missingInClient, extra }`。
 */
export function checkRemoteConsistency(sources) {
  const scrape = (text) => [...new Set([...String(text).matchAll(/'modelTeam\/([a-zA-Z]+)'/g)].map((m) => m[1]))].sort();
  const want = [...REMOTE_METHODS].sort();
  const typert = scrape(sources?.typert ?? '');
  const client = scrape(sources?.client ?? '');
  const missingInTypert = want.filter((name) => !typert.includes(name));
  const missingInClient = want.filter((name) => !client.includes(name));
  const extra = [...new Set([...typert, ...client])].filter((name) => !want.includes(name)).sort();
  return {
    ok: !missingInTypert.length && !missingInClient.length && !extra.length,
    missingInTypert,
    missingInClient,
    extra,
  };
}

markRemote(ModelTeamService.prototype, REMOTE_METHODS);

export function apply(ctx, config = {}) {
  // 账本句柄由本插件持有；服务实例读同一份。
  let ledger = null;
  let configStore = null;

  // 启动自检：DSH 的 HMR 只热更 Client 半，Host 半改了必须重载插件。
  // 把「磁盘源码 vs 当前进程」的结论写进日志，免得对着旧行为排查。
  ctx.logger?.info?.(buildInfoLine(ENTRY_LOADED_AT));

  // Remote 三方清单自检：Host 标记 / typert.js / client.js 必须一致。
  // 只改一处是**静默失效**（`stopModel` 漏在 Client 里时按钮恒 undefined，
  // 点了毫无反应；反过来 Client 声明了但 Host 没标记则网关直接 invocation-unavailable）。
  // 这个检查早就写好了却没人调用，等于没有——放在这里，每次加载都跑一次。
  try {
    const root = dirname(fileURLToPath(import.meta.url));
    const consistency = checkRemoteConsistency({
      typert: readFileSync(join(root, 'typert.js'), 'utf8'),
      client: readFileSync(join(root, 'client.js'), 'utf8'),
    });
    if (!consistency.ok) {
      ctx.logger?.warn?.(
        'model-team: Remote 清单不一致'
        + `（typert 缺 ${consistency.missingInTypert.join(', ') || '无'}；`
        + `client 缺 ${consistency.missingInClient.join(', ') || '无'}；`
        + `多出 ${consistency.extra.join(', ') || '无'}）`,
      );
    }
  } catch { /* 打包后可能读不到源码：自检失败不影响功能 */ }

  // 内置技能：把 `assets/model-team.md` 注册成 DSH 的 `model-team` 技能。
  // 装进 node_modules 的插件包里的 `.dsh/skills` **不会被 DSH 发现**（技能根不含 node_modules），
  // 所以必须像官方 `@deepseek-ai/dsh-skill-badge` 那样走 provider 注册。
  // 用 bundled rank（最低优先级）：项目/用户目录里的同名技能会压过它。
  registerBundledSkill(ctx);

  // CLI harness：内置 pi / opencode + 配置里的定义（后者可覆盖前者）。
  // 注册只做校验与登记，不起进程；真正调用在 runCandidate 的 `transport === 'cli'` 分支。
  registerBuiltinHarnesses();
  registerConfiguredHarnesses(ctx, config);

  ctx.tools.register({
    name: config.toolName ?? 'model_team',
    description:
      'Multi-model team: run a post-audit, a design fork (2–4 options, no decision), or focused reasoning across the '
      + 'models configured for this plugin (or every model DSH has registered), plus CLI harness models declared in '
      + '`cliModels` (e.g. `cli-pi/k3`). Each model gets one independent call and '
      + 'one progress row; the same model may appear twice at different reasoning efforts. Runs are recorded in a ledger. '
      + 'Default mode="llm" is a pure inference call; mode="subagent" runs each model as a subagent that can read the '
      + 'workspace; CLI entries ignore mode and run their harness headlessly. It never edits the repository itself.',
    parameters: {
      type: 'object',
      properties: {
        packet: {
          type: 'string',
          description: 'The self-contained Task Packet (goal, entry points, hard constraints, what was tried, open questions; 1–3K tokens).',
        },
        kind: {
          type: 'string',
          enum: ['audit', 'design', 'reason'],
          description: 'audit = find defects; design = 2–4 options without a decision; reason = structured plan.',
          default: 'audit',
        },
        models: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional picks as `provider/model` or `provider/model@@effort` (double `@` separates the effort); '
            + 'CLI harness models are `cli-<harness>/<id>` (e.g. `cli-pi/k3@@max`). '
            + 'A pick REPLACES the configured entry for the SAME model at the SAME effort (so you can swap which provider '
            + 'route runs it); it does NOT drop the activity bindings, and models absent from the bindings are added as '
            + 'extra entries. Omit to run exactly what the bindings select.',
        },
        mode: {
          type: 'string',
          enum: ['llm', 'subagent'],
          description: 'llm = one pure inference call per model (default). subagent = each model runs as a subagent that can read the workspace. CLI entries ignore this and run their harness headlessly.',
          default: 'llm',
        },
        max_depth: {
          type: 'integer',
          description: 'Only for mode=subagent: delegation depth budget for the children (0 forbids further delegation).',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'The files this run is about. In mode=llm their full contents are appended to the prompt '
            + '(with line numbers), because that mode cannot read the workspace. In mode=subagent only the list is '
            + 'added as the audit scope — the subagent opens them itself. '
            + 'Relative paths need `workspace`.',
        },
        workspace: {
          type: 'string',
          description: 'Base directory for relative `files` paths; also the cwd for CLI entries (required for them). Defaults to the process working directory only for DSH entries.',
        },
      },
      required: ['packet'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          label: { type: 'string' },
          mode: { type: 'string' },
          runId: { type: 'string' },
          models: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                model: { type: 'string' },
                provider: { type: 'string' },
                name: { type: 'string' },
                reasoningEffort: { type: 'string' },
                status: { type: 'string' },
                text: { type: 'string' },
                error: { type: 'string' },
                seconds: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderTeamMarkdown(value) }],
    },
    async execute(args, exec) {
      const request = args ?? {};
      const runId = request.runId ?? newRunId();
      const jobs = ctx.get('jobs');
      let outcome;

      // **本场专用的取消开关。**
      //
      // 宿主的 job 契约只要求 producer 自己中止工作：`kill` 把状态改成 stopping、
      // 调 producer 的 `cancel`，然后等 `done`（`dsh-jobs` 的实现不会替我们 abort
      // 任何东西）。早先这里只置 `cancelled = true`，模型调用照跑、跑完还按
      // `completed` 结算——用户在任务面板点「停止」，实际一点没停。
      // 现在把 `exec.signal`（工具调用被 abort）与本场开关合并成同一个 signal，
      // 取消时真正 abort 掉 `ctx.llm.stream` / 子代理。
      const kill = new AbortController();
      const signal = exec.signal
        ? AbortSignal.any([exec.signal, kill.signal])
        : kill.signal;
      let jobId = '';

      if (!jobs || !exec.agent) {
        const sink = { append() {}, updateProgress() {} };
        try {
          outcome = await runTeam(ctx, sink, { ...request, runId }, config, await ensureConfig(), signal, exec.agent);
        } finally {
          ACTIVE_RUNS.delete(runId);
        }
      } else {
        // job 的 owner 是 Session 身份；producer 必须交出 `done`，注册表据此结算。
        // `jobs.start()` 返回前就可能有输出，所以先挂一个缓冲，拿到 handle 再补写。
        let handle;
        let cancelled = false;
        const pendingOutput = [];
        const sink = {
          // 进度是**尽力而为**：job 已结算/被杀后 append 可能抛错，
          // 一次写进度失败不该把整场执行打崩（那会连带 ACTIVE_RUNS 泄漏）。
          append(text, options) {
            try {
              if (handle) handle.append(text, options);
              else pendingOutput.push([text, options]);
            } catch { /* 忽略：进度写不进去不影响模型结果 */ }
          },
          updateProgress(line) {
            try { handle?.updateProgress(line); } catch { /* 同上 */ }
          },
        };
        const done = runTeam(ctx, sink, { ...request, runId }, config, await ensureConfig(), signal, exec.agent).then(
          (value) => ({
            // 取消优先：被 kill 的场次即使各家都「正常返回」了，也不该报成功。
            status: cancelled ? 'killed' : 'completed',
            detail: cancelled
              ? '已取消'
              : `${value.models.filter((m) => m.status === 'done').length}/${value.models.length} 有结果`,
            result: value,
          }),
          (error) => ({ status: cancelled ? 'killed' : 'failed', detail: error instanceof Error ? error.message : String(error) }),
        ).finally(() => {
          // 无论成功、失败还是被取消，都要把两张表里的这一场摘掉：
          // 早先 `ACTIVE_RUNS.delete` 在 `Promise.all` 之后裸奔，中途抛错就永久残留。
          ACTIVE_RUNS.delete(runId);
          if (jobId) JOB_RUN_IDS.delete(jobId);
        });
        // `jobs.start()` 返回的是 job **id**，不是句柄：
        // 带 `append` / `updateProgress` 的句柄由 `run(handle)` 传进来。
        jobId = String(jobs.start({
          kind: 'team',
          label: `${KINDS[request.kind ?? 'audit']?.label ?? request.kind} · ${request.mode ?? 'llm'}`,
          owner: exec.agent.id,
          toolCall: { callId: exec.callId, ...(exec.rootCallId === undefined ? {} : { rootCallId: exec.rootCallId }) },
          run: (jobHandle) => {
            handle = jobHandle;
            // start() 之前产生的事件先补写进 job 输出环。
            for (const [text, options] of pendingOutput.splice(0)) {
              try { jobHandle.append(text, options); } catch { /* 忽略 */ }
            }
            return { cancel: () => { cancelled = true; kill.abort(); }, done };
          },
        }) ?? '');
        // Client 只拿得到 job id；记下别名，让 `stopModel` 能找回本场的停止表。
        if (jobId) JOB_RUN_IDS.set(jobId, runId);
        const settled = await done;
        if (settled.status !== 'completed') throw new Error(settled.detail ?? '多模型团队执行失败');
        outcome = settled.result;
      }

      // 记账是尽力而为：写失败不推翻本次结果，但要留下真因。
      //
      // **总开关关着就不记账**：`runTeam` 会把 `persisted` 带回来（它已经按
      // `persistData` 决定要不要写会话日志）。账本是周报与报告的唯一数据源，
      // 不写账本等于这两个功能自动失效，不用在那边再判一次。
      if (!outcome.persisted) {
        ctx.logger?.info?.('model-team: 未开启「保存数据」，本次不写账本（周报与报告将无数据）');
      } else {
        try {
          ledger.recordRun({
            runId,
            kind: outcome.kind,
            mode: outcome.mode,
            packetHash: packetHash(String(request.packet ?? '')),
            startedAt: outcome.started_at,
            finishedAt: outcome.finished_at,
          }, outcome.models);
        } catch (error) {
          ctx.logger?.warn?.(`model-team: 账本写入失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // 附上构建自检：宿主半没重载时，一眼能看出来（结果会被当成"修复没生效"）。
      return { ...outcome, build: buildInfo(ENTRY_LOADED_AT) };
    },
  });

  ctx.tools.register({
    name: 'model_team_weekly',
    description:
      'Generate the multi-model weekly report: aggregate the call ledger for a window and have one configured model '
      + 'summarize it. The summary model comes from this plugin\'s `reportModel` config. The report is stored in the ledger '
      + 'and also returned.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Window length in days, ending now. Defaults to 7.', default: 7 },
        model: { type: 'string', description: 'Optional summary model override (`provider/model` or `provider/model@@effort`).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          reportId: { type: 'string' },
          summaryModel: { type: 'string' },
          summary: { type: 'string' },
          summaryError: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary || value.summaryError || '' }],
    },
    async execute(args) {
      const days = Math.max(1, Number(args?.days) || 7);
      const to = Date.now();
      // 工具路径同样读设置页的偏好（`ensureConfig()` 在 `apply()` 里已定义）。
      const store = await ensureConfig();
      const result = await buildWeekly(ctx, ledger, config, {
        from: to - days * 24 * 60 * 60 * 1000, to, model: args?.model,
        store, persist: Boolean(store && readPrefs(store).persistData),
      }, undefined);
      return {
        reportId: result.reportId,
        summaryModel: result.summaryModel,
        summary: result.summary,
        summaryError: result.summaryError,
      };
    },
  });

  // 账本按需打开；打不开时工具照常可用，只是不记账。
  //
  // 打开只做一次，句柄的 promise 留给 Remote 服务 attach：早先服务侧靠
  // `setTimeout(attach, 100)` 轮询 `ledger`，账本打不开时（`openLedger` 返回 null）
  // 会变成每 100ms 一次的永久定时器。
  const ledgerReady = openLedger(config.ledgerPath || defaultLedgerPath(dshHome()), ctx.logger);
  ctx.effect(() => {
    let disposed = false;
    void ledgerReady.then((handle) => {
      if (disposed) {
        void handle?.close?.();
        return;
      }
      ledger = handle;
    });
    return () => {
      disposed = true;
      void ledger?.close?.();
      ledger = null;
    };
  }, 'model-team: ledger');

  // 配置存储：执行组与偏好放 DSH 系统存储（StorageDomain，json 后端）。
  //
  // **惰性打开**：启动时异步 open 与第一次读写存在竞态，服务可能先拿到 null
  // （踩过：界面报「配置存储不可用」）。这里让每次读写都先 await 一次同一个 promise。
  let configOpening = null;
  let configClosed = false;
  const ensureConfig = () => {
    if (configClosed) return Promise.resolve(null);
    if (configStore) return Promise.resolve(configStore);
    if (!configOpening) {
      configOpening = openConfig(ctx).then((handle) => {
        if (handle && !configClosed) configStore = handle;
        return handle;
      }).catch((error) => {
        ctx.logger?.warn?.(`model-team: 配置域打开失败：${error instanceof Error ? error.message : String(error)}`);
        return null;
      }).finally(() => {
        // 没拿到句柄就清掉 in-flight 标记，下一次读写再试。
        // 早先把 `null` 也缓存到进程结束：插件比存储服务先激活、或第一次 open
        // 撞锁时，配置面（执行组/绑定/总开关）整场失效，只能重载插件。
        if (!configStore) configOpening = null;
      });
    }
    return configOpening;
  };
  ctx.effect(() => () => {
    configClosed = true;
    configStore = null;
    configOpening = null;
  }, 'model-team: config');

  // Remote 服务：`ctx.remote.modelTeam` 的 Host 半边（Client 页面读账本与周报）。
  // Cordis 的 Service 构造即注册；typert 按 `modelTeam/*` 端点分发到这里。
  try {
    const service = new ModelTeamService(ctx);
    service.pluginConfig = config;
    // 每次读写前确保配置域已打开（惰性、同一 promise，不抢跑）。
    service.ensureStore = async () => await ensureConfig();
    ctx.effect(() => () => { service.dispose?.(); }, 'model-team: remote service');
    ctx.effect(() => {
      let disposed = false;
      void ledgerReady.then((handle) => {
        if (!disposed) service.ledger = handle;
      });
      return () => { disposed = true; };
    }, 'model-team: service ledger');
  } catch (error) {
    ctx.logger?.warn?.(`model-team: Remote 服务挂载失败（页面不可用，工具不受影响）：${error instanceof Error ? error.message : String(error)}`);
  }
}
