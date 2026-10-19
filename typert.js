/**
 * Host 侧 Typert 描述符（A1）。
 *
 * 这个文件是 `@deepseek-ai/dsh-typert-generator` 生成物的等价手写版：
 * `TYPERT.invocations` 是 `createTypertRemoteInfo(spec, z).descriptors`，
 * Client 端通过 `ctx.remote.modelTeam` 调到这里声明的三个方法。
 *
 * 校验规则（typert-loader）：manifest.package 必须等于本包名、face 必须是 host、
 * schemas 必须是数组、每个 invocation 要有 id/service/namespace/method 与 strict codec。
 * `input`/`invoke` 可省略——那是 strict 调用助手，Client 侧走 `ctx.remote` 不需要。
 */
import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';

const PACKAGE = '@vastplan/model-team';

const callRow = z.object({
  runId: z.string(),
  callId: z.string(),
  model: z.string(),
  provider: z.string(),
  name: z.string(),
  reasoningEffort: z.string(),
  status: z.string(),
  text: z.string(),
  error: z.string(),
  seconds: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  reasoningTokens: z.number(),
  finishedAt: z.number(),
});

const runRow = z.object({
  runId: z.string(),
  kind: z.string(),
  mode: z.string(),
  packetHash: z.string(),
  startedAt: z.number(),
  finishedAt: z.number(),
  total: z.number(),
  answered: z.number(),
});

const reportRow = z.object({
  reportId: z.string(),
  from: z.number(),
  to: z.number(),
  summaryModel: z.string(),
  summary: z.string(),
  facts: z.string(),
  createdAt: z.number(),
});

const overviewResult = z.object({
  ready: z.boolean(),
  runs: z.array(runRow),
  calls: z.array(callRow),
  reports: z.array(reportRow),
});

const overviewParam = z.number();  // 参数 codec 校验的是参数值本身（limit 是数字）

const weeklyParam = z.object({
  from: z.number().optional(),
  to: z.number().optional(),
  model: z.string().optional(),
});

const weeklyResult = z.object({
  reportId: z.string(),
  from: z.number(),
  to: z.number(),
  summaryModel: z.string(),
  summary: z.string(),
  summaryError: z.string(),
  facts: z.any(),
});

const groupSchema = z.object({
  groupId: z.string(),
  name: z.string(),
  candidates: z.array(z.object({ model: z.string(), reasoningEffort: z.string() })),
  enabled: z.boolean(),
  order: z.number(),
});

const prefsSchema = z.object({
  reportModel: z.string(), concurrency: z.number(), reportDir: z.string(), autoUpload: z.boolean(),
  /** 总开关：保存数据 / 启用周报与报告。老配置缺这个键时按 false 处理。 */
  persistData: z.boolean().optional(),
});

const bindingsSchema = z.object({
  audit: z.array(z.string()),
  design: z.array(z.string()),
  reason: z.array(z.string()),
});

const configResult = z.object({
  groups: z.array(groupSchema),
  prefs: prefsSchema,
  bindings: bindingsSchema,
  ready: z.boolean(),
});

const catalogResult = z.object({
  models: z.array(z.object({
    provider: z.string(),
    id: z.string(),
    name: z.string(),
    efforts: z.array(z.string()),
    defaultEffort: z.string(),
  })),
});

const settingsResult = z.object({
  models: z.array(z.any()),
  reportModel: z.string(),
  toolName: z.string(),
});

const $remote = createTypertRemoteInfo({
  package: PACKAGE,
  methods: {
    'modelTeam/overview': {
      service: 'modelTeam',
      description: 'Read the recent ledger runs, their per-model call rows, and the latest weekly reports.',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'limit',
          wire: 'limit',
          description: 'How many runs to return, most recent first (1–200, default 20).',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#OverviewRequest`, create: () => overviewParam, jsonSchema: { type: 'number' } },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: `${PACKAGE}/types#Overview`,
        create: () => overviewResult,
        description: 'Ledger rows for the plugin page.',
        jsonSchema: { type: 'object' },
      },
    },
    'modelTeam/weekly': {
      service: 'modelTeam',
      description: 'Aggregate a window of the ledger and have the configured model summarize it.',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          description: 'Optional window (epoch ms) and summary model override.',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#WeeklyRequest`, create: () => weeklyParam, jsonSchema: { type: 'object', properties: { from: { type: 'number' }, to: { type: 'number' }, model: { type: 'string' } }, additionalProperties: false } },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: `${PACKAGE}/types#WeeklyReport`,
        create: () => weeklyResult,
        description: 'The stored weekly report.',
        jsonSchema: { type: 'object' },
      },
    },
    'modelTeam/configuration': {
      service: 'modelTeam',
      description: 'Read the configured execution groups and preferences.',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: `${PACKAGE}/types#Config`,
        create: () => configResult,
        description: 'Execution groups and preferences.',
        jsonSchema: { type: 'object' },
      },
    },
    'modelTeam/catalog': {
      service: 'modelTeam',
      description: 'List every model registered in DSH, for the configuration pickers.',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: `${PACKAGE}/types#Catalog`,
        create: () => catalogResult,
        description: 'Registered provider/model pairs.',
        jsonSchema: { type: 'object' },
      },
    },
    'modelTeam/saveGroup': {
      service: 'modelTeam',
      description: 'Create or replace one execution group (candidates[0] is the primary; the rest are fallbacks in order).',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          description: 'The group to store.',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}/types#SaveGroupRequest`,
            create: () => groupSchema,
            jsonSchema: { type: 'object' },
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: `${PACKAGE}/types#Config`,
        create: () => configResult,
        description: 'Configuration after the write.',
        jsonSchema: { type: 'object' },
      },
    },
    'modelTeam/removeGroup': {
      service: 'modelTeam',
      description: 'Delete one execution group by id.',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          description: 'The group id to delete.',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#RemoveGroupRequest`, create: () => z.object({ groupId: z.string() }), jsonSchema: { type: 'object' } },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: `${PACKAGE}/types#Config`,
        create: () => configResult,
        description: 'Configuration after the delete.',
        jsonSchema: { type: 'object' },
      },
    },
    'modelTeam/openReport': {
      service: 'modelTeam',
      description: 'Render the ledger into a self-contained HTML report file and return its path.',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          description: 'Window length, report kind, open-after-generate, and reuse-last-file flags.',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}/types#OpenReportRequest`,
            create: () => z.object({
                days: z.number().optional(),
                kind: z.string().optional(),
                open: z.boolean().optional(),
                reuse: z.boolean().optional(),
              }),
            jsonSchema: { type: 'object' },
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: `${PACKAGE}/types#OpenedReport`,
        create: () => z.object({
          path: z.string(),
          latest: z.string(),
          from: z.number(),
          to: z.number(),
          title: z.string(),
          repo: z.string(),
          publish: z.string(),
          publishNote: z.string(),
          commit: z.string(),
          github: z.string(),
        }),
        description: 'The generated report path and the archive URL.',
        jsonSchema: { type: 'object' },
      },
    },
    'modelTeam/setBinding': {
      service: 'modelTeam',
      description: 'Bind which execution groups take part in one activity kind (audit, design or reason).',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          description: 'The kind and its participating group ids.',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}/types#Binding`,
            create: () => z.object({ kind: z.string(), groupIds: z.array(z.string()) }),
            jsonSchema: { type: 'object' },
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: `${PACKAGE}/types#Config`,
        create: () => configResult,
        description: 'Configuration after the write.',
        jsonSchema: { type: 'object' },
      },
    },
    'modelTeam/savePrefs': {
      service: 'modelTeam',
      description: 'Store the summary model and concurrency preference.',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          description: 'Preferences to store.',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#Prefs`, create: () => prefsSchema, jsonSchema: { type: 'object' } },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: `${PACKAGE}/types#Config`,
        create: () => configResult,
        description: 'Configuration after the write.',
        jsonSchema: { type: 'object' },
      },
    },
    'modelTeam/settings': {
      service: 'modelTeam',
      description: 'Read the effective model list, summary model, and tool name.',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: `${PACKAGE}/types#Settings`,
        create: () => settingsResult,
        description: 'Effective plugin configuration.',
        jsonSchema: { type: 'object' },
      },
    },
    'modelTeam/stopModel': {
      service: 'modelTeam',
      description: 'Stop one model inside a running team run (single-target cancel, not the whole job).',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          description: 'The run id and the progress row id to stop.',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}/types#StopModelRequest`,
            create: () => z.object({ runId: z.string(), id: z.string() }),
            jsonSchema: {
              type: 'object',
              properties: { runId: { type: 'string' }, id: { type: 'string' } },
              required: ['runId', 'id'],
              additionalProperties: false,
            },
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: `${PACKAGE}/types#StoppedModel`,
        create: () => z.object({ stopped: z.boolean(), reason: z.string().optional() }),
        description: 'Whether that model was actually cancelled.',
        jsonSchema: { type: 'object' },
      },
    },
  },
}, z);

export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  get invocations() { return $remote.descriptors },
  model: {
    services: [
      {
        description: 'Multi-model team ledger and weekly report.',
        summary: 'Read the ledger and build weekly reports.',
        tags: [],
        jsDoc: '/** Multi-model team ledger and weekly report. */',
        key: 'modelTeam',
        exportName: 'default',
        members: [
          {
            kind: 'method',
            name: 'overview',
            signature: '@Remote async overview(limit?: number): Promise<Overview>',
            summary: 'Read recent ledger rows.',
            jsDoc: '/** Read recent ledger rows. */',
          },
          {
            kind: 'method',
            name: 'weekly',
            signature: '@Remote async weekly(request, signal): Promise<WeeklyReport>',
            summary: 'Build a weekly report.',
            jsDoc: '/** Build a weekly report. */',
          },
          {
            kind: 'method',
            name: 'settings',
            signature: '@Remote settings(): Settings',
            summary: 'Read effective configuration.',
            jsDoc: '/** Read effective configuration. */',
          },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
};

export default TYPERT;
