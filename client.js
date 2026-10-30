/**
 * 多模型团队 · 插件页面（Client 半）。
 *
 * 挂在 `plugins.bundle.config`（key = 本 bundle 名），在插件页里给出：
 * - 最近场次与逐模型执行情况（账本读自 Host 的 `ctx.remote.modelTeam`）
 * - 当前名单与总结模型
 * - 一键生成周报
 *
 * 纯 JS + React，不 import 任何 DSH Client 包；样式只用 `--dsw-alias-*` token。
 */
window.__ModuleLoader__.load({
  id: '@vastplan/model-team',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'model-team';
    // 构建标记：浏览器控制台会打印，用来确认拿到的是哪一版（排查缓存用）。
    const BUILD = 'v57-stop-button';
    const BUNDLE = '@vastplan/model-team';

    const zh = {
      title: '多模型团队',
      subtitle: '并发调用各模型做审计、分叉与推理。',
      loading: '读取账本…',
      failed: '读取失败',
      retry: '重试',
      empty: '还没有执行记录。用 model_team 工具跑一场就会出现在这里。',
      notReady: '账本未就绪：SQLite 打不开（看 Host 日志里的真因）。配置区不受影响，可以继续改执行组与开关。',
      model: '模型',
      calls: '调用',
      ok: '有结果',
      fail: '失败',
      avg: '平均耗时',
      tokens: '输出 token',
      summaryModel: '总结模型',
      none: '未配置',
      days: '统计天数',
    };
    const en = {
      title: 'Multi-Model Team',
      subtitle: 'Cross-model audit, design forks and reasoning.',
      loading: 'Reading ledger…',
      failed: 'Read failed',
      retry: 'Retry',
      empty: 'No runs yet. Call the model_team tool once and it shows up here.',
      notReady: 'Ledger not ready: SQLite failed to open (see Host logs). Configuration still works.',
      model: 'Model',
      calls: 'Calls',
      ok: 'Answered',
      fail: 'Failed',
      avg: 'Avg time',
      tokens: 'Output tokens',
      summaryModel: 'Summary model',
      none: 'Not configured',
      days: 'Window (days)',
    };

    // 本包的 Remote 描述符（与 typert.js 同源；Client 侧 $mount 需要它）。
    // Client 只做 wire 组装，schema 校验在 Host 端，因此 create 给空工厂即可。
    const PACKAGE = '@vastplan/model-team';
    const schemaStub = () => ({ parse: (value) => value });
    /**
     * 最小 `createTypertRemoteInfo`（内联版）。
     *
     * 官方的 `@deepseek-ai/dsh-typert-protocol/remote-info` 不是浏览器 baseline 模块，
     * `dsh.client.external` 也补不出它（只认动态包行或静态表键），所以这里只重建
     * `$mount` 真正读取的那一面：`descriptors`。官方 api-remotes 的浏览器 bundle
     * 同样是内联这份实现，只 require("zod")——而我们要的 descriptors 连 zod 都不用。
     */
    function buildRemoteInfo(spec) {
      const descriptors = [];
      for (const [endpoint, definition] of Object.entries(spec.methods)) {
        const separator = endpoint.indexOf('/');
        const namespace = endpoint.slice(0, separator);
        const method = endpoint.slice(separator + 1);
        const parameters = definition.parameters.map((parameter) => ({
          ...parameter,
          wire: parameter.wire ?? parameter.name,
        }));
        descriptors.push({
          ...definition,
          id: `${spec.package}#${endpoint}`,
          namespace,
          method,
          parameters,
          result: definition.result.description === undefined
            ? definition.result
            : { ...definition.result },
        });
      }
      return { package: spec.package, descriptors };
    }

    const REMOTE_INFO = buildRemoteInfo({
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
              codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#OverviewRequest`, create: schemaStub, jsonSchema: { type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: false } },
            },
          ],
          result: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}/types#Overview`,
            create: schemaStub,
            description: 'Ledger rows for the plugin page.',
            jsonSchema: { type: 'object' },
          },
        },
        'modelTeam/configuration': {
          service: 'modelTeam',
          description: 'Read execution groups and preferences.',
          invocation: { kind: 'direct' },
          parameters: [],
          result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#Config`, create: schemaStub, description: 'config', jsonSchema: { type: 'object' } },
        },
        'modelTeam/catalog': {
          service: 'modelTeam',
          description: 'List registered models.',
          invocation: { kind: 'direct' },
          parameters: [],
          result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#Catalog`, create: schemaStub, description: 'catalog', jsonSchema: { type: 'object' } },
        },
        'modelTeam/saveGroup': {
          service: 'modelTeam',
          description: 'Create or replace an execution group.',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', description: 'group', source: 'json',
            codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#Group`, create: schemaStub, jsonSchema: { type: 'object' } } }],
          result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#Config`, create: schemaStub, description: 'config', jsonSchema: { type: 'object' } },
        },
        'modelTeam/removeGroup': {
          service: 'modelTeam',
          description: 'Delete an execution group.',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', description: 'id', source: 'json',
            codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#RemoveGroup`, create: schemaStub, jsonSchema: { type: 'object' } } }],
          result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#Config`, create: schemaStub, description: 'config', jsonSchema: { type: 'object' } },
        },
        'modelTeam/openReport': {
          service: 'modelTeam',
          description: 'Render a static report and return its path.',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', description: 'days + kind', source: 'json',
            codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#OpenReportRequest`, create: schemaStub, jsonSchema: { type: 'object' } } }],
          result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#OpenedReport`, create: schemaStub, description: 'report path', jsonSchema: { type: 'object' } },
        },
        'modelTeam/setBinding': {
          service: 'modelTeam',
          description: 'Bind groups to an activity kind.',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', description: 'kind + groupIds', source: 'json',
            codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#Binding`, create: schemaStub, jsonSchema: { type: 'object' } } }],
          result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#Config`, create: schemaStub, description: 'config', jsonSchema: { type: 'object' } },
        },
        'modelTeam/savePrefs': {
          service: 'modelTeam',
          description: 'Store preferences.',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', description: 'prefs', source: 'json',
            codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#Prefs`, create: schemaStub, jsonSchema: { type: 'object' } } }],
          result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#Config`, create: schemaStub, description: 'config', jsonSchema: { type: 'object' } },
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
              codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#WeeklyRequest`, create: schemaStub, jsonSchema: { type: 'object', properties: { from: { type: 'number' }, to: { type: 'number' }, model: { type: 'string' } }, additionalProperties: false } },
            },
          ],
          cancellation: { parameter: 'signal' },
          result: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}/types#WeeklyReport`,
            create: schemaStub,
            description: 'The stored weekly report.',
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
            create: schemaStub,
            description: 'Effective plugin configuration.',
            jsonSchema: { type: 'object' },
          },
        },
        // **端点必须在这里声明，否则 `ctx.remote.modelTeam` 上根本没有这个方法**。
        // 踩过：Host 侧 `markRemote` 加了 `stopModel`、`typert.js` 也补了描述符，
        // 但漏了这份 Client 内联 spec —— `api.stopModel` 恒为 undefined，
        // 「停止」按钮点下去静默返回，表现为「按钮没反应」。
        'modelTeam/stopModel': {
          service: 'modelTeam',
          description: 'Stop one model inside a running team run.',
          invocation: { kind: 'direct' },
          parameters: [{
            name: 'request', wire: 'request', description: 'runId + progress row id', source: 'json',
            codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#StopModelRequest`, create: schemaStub, jsonSchema: { type: 'object' } },
          }],
          result: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}/types#StoppedModel`,
            create: schemaStub,
            description: 'Whether that model was cancelled.',
            jsonSchema: { type: 'object' },
          },
        },
      },
    });
    // `$mount` 收的是 TypertRemoteInfo（自己生成 descriptors），不是裸 spec。
    const REMOTE_SPEC = REMOTE_INFO;

    // 样式全部照搬官方设置/管理页的真实排版口径（字号 13/14/20、间距 8/16/32），
    // 只换成自己的 `mt-` 前缀，并只用 `--dsw-alias-*` / `--dsw-radius-*` token。
    // 样式取自预览页（preview.html），口径对齐官方设置页的行式布局。
    // 样式取自预览页（preview.html），口径对齐官方设置页的行式布局。
    // 样式取自预览页（preview.html）；下拉是自定义组件，不用原生 select。
    // 样式取自预览页（preview.html）；下拉与芯片都是自定义组件。
    // 样式取自预览页（preview.html）；下拉、芯片、整行新建按钮都是自定义组件。
    const css = `
/* ── 以下是被调样式：官方设置页的「行」布局 ───────────────────────────── */
.mt-root { display: flex; flex-direction: column; max-width: 720px; }
.mt-pageTitle { margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; }
.mt-intro { color: var(--dsw-alias-label-secondary); margin: 4px 0 0; font-size: 13px; line-height: 20px; }

/* 官方设置页：每行 padding 16px 0 + .5px 底边框 */
.mt-root > header { padding-bottom: 8px; }
.mt-row { display: flex; flex-direction: column; gap: 8px; padding: 16px 0;
  border-bottom: .5px solid var(--dsw-alias-border-l1); }
.mt-row:last-child { border-bottom: 0; }
.mt-rowTitle { margin: 0; font-size: 14px; font-weight: 400; line-height: 22px; }
.mt-rowHint { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }

/* 行内两栏：左文字右控件（官方设置的常规形态） */
.mt-rowSplit { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
.mt-rowMain { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mt-rowControl { flex: none; display: flex; align-items: center; gap: 8px; }

/* 控件：官方按钮 ≈ 28px 高、.5px 边框、radius-md */
.mt-button { height: 28px; padding: 0 12px; display: inline-flex; align-items: center; justify-content: center;
  gap: 4px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  font-family: inherit; font-size: 13px; line-height: 20px; cursor: pointer;
  transition: background var(--ds-transition-duration) var(--ds-ease-in-out); }
.mt-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.mt-button:disabled { opacity: .5; cursor: default; }
.mt-buttonGhost { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
.mt-buttonGhost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.mt-buttonDanger { color: var(--dsw-alias-state-error-primary); }
.mt-buttonDanger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }

.mt-select, .mt-input { height: 28px; padding: 0 8px; border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px; line-height: 20px;
  outline: none; }
.mt-select:focus, .mt-input:focus { border-color: var(--dsw-alias-border-l4); }
.mt-select { min-width: 180px; max-width: 100%; flex: 1; text-overflow: ellipsis; }

/* 自定义下拉：渲染成按钮 + 浮层，不用原生 select（macOS 原生外观与深色主题冲突） */
.mt-dd { position: relative; display: inline-flex; min-width: 0; }
.mt-cand .mt-dd { flex: 1; min-width: 0; }
.mt-ddButton { display: flex; align-items: center; gap: 6px; width: 100%; height: 28px;
  padding: 0 8px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  font-family: inherit; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer;
  transition: background var(--ds-transition-duration) var(--ds-ease-in-out); }
.mt-ddButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.mt-ddButton:disabled { opacity: .5; cursor: default; }
.mt-ddButton[aria-expanded="true"] { border-color: var(--dsw-alias-border-l4); }
.mt-ddValue { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mt-ddPlaceholder { color: var(--dsw-alias-label-tertiary); }
.mt-ddChevron { flex: none; width: 12px; height: 12px; color: var(--dsw-alias-label-tertiary);
  transition: transform var(--ds-transition-duration) var(--ds-ease-in-out); }
.mt-ddButton[aria-expanded="true"] .mt-ddChevron { transform: rotate(180deg); }
.mt-ddPanel { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0;
  /* 宽度：严格跟随按钮（按钮已有 width 340），选项在面板内省略。
     早先只写 min-width，面板会被最长选项撑到几百像素，挡住整块设置区。 */
  width: 100%; max-width: min(420px, calc(100vw - 32px)); box-sizing: border-box;
  display: flex; flex-direction: column; gap: 4px; padding: 4px;
  border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2); box-shadow: 0 8px 24px rgba(0,0,0,.28); }
.mt-ddSearchRow { padding: 2px; }
.mt-ddSearch { width: 100%; height: 26px; padding: 0 8px; box-sizing: border-box;
  border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-family: inherit; font-size: 12px; line-height: 20px; outline: none; }
.mt-ddSearch:focus { border-color: var(--dsw-alias-border-l4); }
.mt-ddEmptyItem { color: var(--dsw-alias-label-tertiary); cursor: default; }
.mt-ddEmptyItem:hover { background: transparent; }
.mt-ddPanel .mt-ddMenu { position: static; max-height: 240px; box-shadow: none;
  border: 0; padding: 0; background: transparent; }
.mt-ddMenu { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0;
  width: 100%; max-width: min(420px, calc(100vw - 32px)); box-sizing: border-box; max-height: 260px; overflow: auto;
  margin: 0; padding: 4px; list-style: none;
  border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2); box-shadow: 0 8px 24px rgba(0,0,0,.28); }
.mt-ddItem { display: flex; align-items: center; gap: 6px; padding: 5px 8px;
  border-radius: var(--dsw-radius-sm); color: var(--dsw-alias-label-primary);
  font-size: 13px; line-height: 20px; cursor: pointer; white-space: nowrap;
  /* 长标签省略而不是撑宽面板；全文靠 title 悬停看。 */
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.mt-ddLabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mt-ddItem:hover, .mt-ddItem[data-active] { background: var(--dsw-alias-interactive-bg-hover); }
.mt-ddItem[aria-selected="true"] { color: var(--dsw-alias-brand-primary-new-color); }
.mt-ddCheck { flex: none; width: 12px; }
.mt-input { width: 100%; }
.mt-inputNarrow { width: 88px; flex: none; }
.mt-effortSelect { width: 96px; min-width: 96px; max-width: 96px; flex: none; }
.mt-chip { display: inline-flex; align-items: center; flex: none; white-space: nowrap;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; height: 24px; padding: 0 10px;
  border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-family: inherit; font-size: 12px; line-height: 20px; cursor: pointer; }
.mt-chip:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.mt-dock { margin: 0 auto 8px; width: 100%; max-width: 720px;
  /* 外壳只负责高度与透明度动画：内层卡片承担边框/背景/内边距。
     高度用 grid-template-rows 的 1fr → 0fr 收到 0——它由内容决定，
     不用猜一个 max-height 常量（行数在 1～20 之间浮动，写死会失真）。 */
  display: grid; grid-template-rows: 1fr;
  transition: grid-template-rows 220ms ease-in, opacity 220ms ease-in,
    margin-bottom 220ms ease-in;
  opacity: 1; }
/* 关闭：行高收到 0，同时淡出；播完由 JS 卸载（时长见 DOCK_CLOSE_MS） */
.mt-dockClosing { grid-template-rows: 0fr; opacity: 0; margin-bottom: 0;
  pointer-events: none; }
/* 内层：真正的卡片外观，且必须 min-height:0 才能被 grid 行高压下去 */
.mt-dockInner { display: flex; flex-direction: column; gap: 6px; min-height: 0;
  overflow: hidden; padding: 10px 12px;
  border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2); font-size: 12px; line-height: 18px; }
/* 尊重系统的减少动效偏好 */
@media (prefers-reduced-motion: reduce) {
  .mt-dock { transition: none; }
}
.mt-dockHead { display: flex; align-items: center; gap: 8px; }
.mt-dockDot { flex: none; width: 6px; height: 6px; border-radius: 50%;
  background: var(--dsw-alias-label-tertiary); }
.mt-dockDotLive { background: var(--dsw-alias-brand-primary); }
/* 标题行：活动名 → 耗时 → 模式 → 进度 */
.mt-dockTitle { color: var(--dsw-alias-label-primary); font-size: 12px;
  flex: none; white-space: nowrap; }
/* 模式（llm / subagent）是补充说明，退为最次级 */
.mt-dockMode { color: var(--dsw-alias-label-tertiary); font-size: 11px;
  flex: none; white-space: nowrap; }
.mt-dockMode::before { content: '·'; margin-right: 4px; color: var(--dsw-alias-border-l4); }
/* 进度排最右：次要信息，等宽数字 */
.mt-dockProgress { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums;
  flex: none; white-space: nowrap; }
/* 总耗时：运行中与进度并列，等宽数字避免跳动 */
.mt-dockElapsed { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums;
  font-size: 12px; }
.mt-dockClose { flex: none; width: 20px; height: 20px; display: inline-flex;
  align-items: center; justify-content: center; border: 0; border-radius: var(--dsw-radius-xs);
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font-family: inherit; font-size: 15px; line-height: 1; cursor: pointer; padding: 0; }
.mt-dockClose:hover { background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary); }
/* 执行中锁定：不可点，光标与配色都要说出来 */
.mt-dockCloseLocked, .mt-dockClose:disabled { cursor: not-allowed;
  color: var(--dsw-alias-border-l3); background: transparent; }
.mt-dockCloseLocked:hover, .mt-dockClose:disabled:hover { background: transparent;
  color: var(--dsw-alias-border-l3); }
.mt-dockRows { display: flex; flex-direction: column; gap: 3px; margin: 0; padding: 0; list-style: none; }
.mt-dockRow { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* 名称固定宽度（不再 flex:1）：右侧要留给「最新一段输出」，两者抢空间会互相挤没 */
.mt-dockName { flex: none; width: 128px; min-width: 0; color: var(--dsw-alias-label-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mt-dockEffort { flex: none; min-width: 44px; font-size: 11px; }
.mt-dockTime { flex: none; min-width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
.mt-dockDetail { flex: none; max-width: 180px; color: var(--dsw-alias-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 阶段徽标：紧贴输出文字，说明「这一段是什么」。左侧留出与进度条的间隔，
   右侧不留（让它像是输出文字的前缀，而不是独立一列）。 */
.mt-phase { flex: none; margin-left: 2px; padding: 0 6px; border-radius: var(--dsw-radius-xs);
  border: .5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary);
  font-size: 11px; line-height: 16px; white-space: nowrap; }
.mt-phase-thinking { color: var(--dsw-alias-label-tertiary);
  border-color: var(--dsw-alias-border-l2); }
.mt-phase-tool { color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary); }
.mt-phase-answering { color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-border-l4); }
.mt-phase-done { color: var(--dsw-alias-state-success-primary);
  border-color: var(--dsw-alias-state-success-primary); }
.mt-phase-failed { color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary); }
/* 单家停止：只在运行中出现，尺寸比关闭按钮小一档 */
.mt-dockStop { flex: none; margin-left: auto; width: 22px; height: 22px; display: inline-flex;
  align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 50%;
  background: var(--dsw-alias-state-error-primary, #e5484d); color: #fff; cursor: pointer;
  transition: filter .15s ease, opacity .15s ease; }
.mt-dockStop:hover:not(:disabled) { filter: brightness(1.12); }
.mt-dockStop:disabled { cursor: default; opacity: .45; }
/* 红色图标按钮里的「停止」方块：不靠文字，省宽度 */
.mt-dockStopIcon { width: 8px; height: 8px; border-radius: 1px; background: currentColor; }
/* 已停止：不再是失败红，用中性灰，表示「是我们自己停的」 */
.mt-phase-stopped { color: var(--dsw-alias-label-tertiary); border-color: var(--dsw-alias-border-l3); }
/* 最新一段输出：跟在状态后方，占剩余空间，超长省略 */
.mt-dockTail { flex: 1 1 0; min-width: 0; color: var(--dsw-alias-label-tertiary);
  font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--ds-font-family-code, ui-monospace, monospace); }
/* 行首状态图标：等待 / 运行 / 完成 / 失败。
   为什么不用进度条：分母是执行组数，组内回落会让实际调用次数随时变化，
   永远算不出真实百分比——画一条固定半格/满格的条只会误导。 */
.mt-rowIcon { flex: none; width: 12px; height: 12px; display: inline-flex;
  align-items: center; justify-content: center; border-radius: 50%;
  border: 1.5px solid var(--dsw-alias-border-l3); box-sizing: border-box; }
/* 等待：虚线空心圈，静止 */
.mt-rowIconQueued { border-style: dashed; border-color: var(--dsw-alias-border-l4); }
/* 运行：实心弧 + 旋转。用 2px 的品牌色弧段，与静止的虚线圈一眼可分 */
.mt-rowIconLive { border-width: 1.5px; border-color: var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-brand-primary);
  border-right-color: var(--dsw-alias-brand-primary);
  animation: mt-row-spin .9s linear infinite; }
/* 完成：实心 + 对勾 */
.mt-rowIconDone { border-color: var(--dsw-alias-state-success-primary);
  background: var(--dsw-alias-state-success-primary); }
.mt-rowIconDone::after { content: ''; width: 6px; height: 3px;
  border-left: 1.5px solid var(--dsw-alias-bg-base);
  border-bottom: 1.5px solid var(--dsw-alias-bg-base);
  transform: rotate(-45deg) translate(0.5px, -0.5px); }
/* 失败：实心 + 叉 */
.mt-rowIconBad { border-color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-state-error-primary); position: relative; }
.mt-rowIconBad::before, .mt-rowIconBad::after {
  content: ''; position: absolute; left: 50%; top: 50%; width: 6px; height: 1.5px;
  background: var(--dsw-alias-bg-base); border-radius: 1px; }
.mt-rowIconBad::before { transform: translate(-50%, -50%) rotate(45deg); }
.mt-rowIconBad::after { transform: translate(-50%, -50%) rotate(-45deg); }
@keyframes mt-row-spin { to { transform: rotate(360deg) } }
.mt-dockWaiting { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.mt-bad { color: var(--dsw-alias-state-error-primary); }

.mt-chipOn { border-color: transparent; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
/* 已绑定的对号：绿色，并与名字留一点间距 */
.mt-chipCheck { color: var(--dsw-alias-state-success-primary); margin-right: 4px;
  font-variant-numeric: tabular-nums; }
/* 整行「新建」按钮：虚线描边、占满宽度 */
.mt-addRow { display: flex; align-items: center; justify-content: center; gap: 6px;
  width: 100%; height: 36px; margin-top: 8px; padding: 0 12px;
  border: 1px dashed var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md);
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-family: inherit; font-size: 13px; line-height: 20px; cursor: pointer;
  transition: background var(--ds-transition-duration) var(--ds-ease-in-out),
              border-color var(--ds-transition-duration) var(--ds-ease-in-out),
              color var(--ds-transition-duration) var(--ds-ease-in-out); }
.mt-addRow:hover:not(:disabled) { border-color: var(--dsw-alias-border-l4);
  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.mt-addRow:disabled { opacity: .5; cursor: default; }
.mt-addRowInner { height: 30px; margin-top: 2px; font-size: 12px; }

/* 厂商路由串：等宽显示、过长省略 */
.mt-candRemove { flex: none; height: 24px; padding: 0 8px; font-size: 12px;
  color: var(--dsw-alias-state-error-primary); }
.mt-candRemove:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.mt-candRoute { flex: 1; min-width: 0; font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 未展开条目里的标题行只做透传，不改变原有横向排布 */
.mt-itemHeadPlain { display: contents; }
.mt-ok { color: var(--dsw-alias-state-primary, var(--dsw-alias-state-success-primary)); }

/* 芯片组：横向排列、自动换行、彼此留白，绝不逐字折行 */
.mt-chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 4px; }
/* 活动绑定的单行：标题/说明左，计数右，芯片组单独占下一行 */
.mt-bindRow { display: flex; flex-direction: column; gap: 6px; padding: 12px 0;
  border-top: .5px solid var(--dsw-alias-border-l1); }
.mt-bindRow:first-of-type { border-top: 0; }
.mt-bindHead { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.mt-bindTitle { font-size: 13px; line-height: 20px; }
.mt-bindHint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }

/* 执行组：官方「组」形态（标题 + 说明 + 条目），不用卡片堆叠 */
.mt-groupHead { display: flex; align-items: center; gap: 8px; }
.mt-groupHead .mt-rowTitle { flex: 1; }

.mt-groups { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
/* 列表里的条目统一左右 12px 内边距；展开/收起不改变内容宽度 */
.mt-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px;
  border-top: .5px solid var(--dsw-alias-border-l1); }
.mt-itemMain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mt-itemTitle { font-size: 13px; line-height: 20px; }
.mt-itemDesc { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px;
  overflow-wrap: anywhere; }
.mt-itemActions { flex: none; display: flex; align-items: center; gap: 4px; }

.mt-tag { display: inline-flex; align-items: center; height: 18px; padding: 0 7px;
  border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 18px; }
.mt-tagOk { color: var(--dsw-alias-state-success-primary); }

/* 候选行：序号 + 下拉 + 强度 + 操作 */
.mt-cand { display: flex; align-items: center; gap: 8px; }
/* 偏好行：左说明、右控件（官方设置页的形态） */
.mt-prefRow { display: flex; align-items: center; justify-content: space-between;
  gap: 24px; padding: 10px 0; border-top: .5px solid var(--dsw-alias-border-l1); }
.mt-prefRow:first-of-type { border-top: 0; }
.mt-prefMain { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mt-prefTitle { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); }
.mt-prefHint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.mt-prefControl { flex: none; display: flex; align-items: center; gap: 8px; }
/* 范围列表：一行一个 harness，行间细分割线 */
.mt-prefList { display: flex; flex-direction: column; }
.mt-prefList .mt-prefRow:first-of-type { border-top: .5px solid var(--dsw-alias-border-l1); }

/* 开关：关 = 中性轨道；开 = 品牌色轨道 + 同色描边 + 轻微外发光。
   三重强化是刻意的：单靠 --dsw-alias-brand-primary 在部分主题下与轨道对比不足，
   打开与关闭看起来差不多（真机反馈「打开后看不出颜色」）。 */
.mt-switch { position: relative; flex: none; width: 32px; height: 18px; padding: 0;
  border: 0; border-radius: 9px; background: var(--dsw-alias-border-l3);
  cursor: pointer; transition: background .16s ease, box-shadow .16s ease; }
.mt-switch:hover:not(:disabled) { background: var(--dsw-alias-border-l4); }
.mt-switchOn,
.mt-switchOn:hover:not(:disabled) {
  /* 品牌色缺失时依次回退到「交互蓝 → 成功绿」，绝不退回灰色轨道。 */
  background: var(--dsw-alias-brand-primary,
    var(--dsw-alias-state-primary, var(--dsw-alias-state-success-primary)));
  box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary, var(--dsw-alias-state-primary)),
    0 0 6px -1px var(--dsw-alias-brand-primary, var(--dsw-alias-state-primary));
}
.mt-switch:disabled { cursor: default; opacity: .5; }
.mt-switchThumb { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
  border-radius: 50%; background: var(--dsw-alias-switch-thumb);
  box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .16s ease; }
.mt-switchOn .mt-switchThumb { transform: translateX(14px);
  box-shadow: 0 1px 3px rgba(0,0,0,.35); }
.mt-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
/* 开关行：与其它控件同字号 13/20 */
.mt-switchRow { display: inline-flex; align-items: center; gap: 10px; }
.mt-switchLabel { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); }
.mt-cand .mt-select { max-width: 380px; }
.mt-candIndex { flex: none; width: 44px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 20px; }
/* 厂商 tag：描边样式，等宽字体，过长省略 */
.mt-vendors { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.mt-vendorTag { display: inline-flex; align-items: center; max-width: 100%;
  height: 20px; padding: 0 8px; border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm); background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 11px; line-height: 20px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.mt-candActions { display: flex; gap: 2px; }
/* 拖拽：把手 + 落点提示 */
.mt-dragHandle { flex: none; width: 20px; height: 20px; display: inline-flex; align-items: center;
  justify-content: center; border: 0; background: transparent; color: var(--dsw-alias-label-tertiary);
  cursor: grab; border-radius: var(--dsw-radius-xs); font-size: 12px; line-height: 1; }
.mt-dragHandle:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.mt-cand[data-dragging] { opacity: .45; }
.mt-cand[data-dropBefore] { box-shadow: inset 0 2px 0 0 var(--dsw-alias-brand-primary-new-color); }
.mt-cand[data-dropAfter] { box-shadow: inset 0 -2px 0 0 var(--dsw-alias-brand-primary-new-color); }

.mt-editor { display: flex; flex-direction: column; gap: 12px; padding: 12px 0 4px; }
.mt-itemOpen { display: block;
  /* 展开态：底色用半透明中性叠加（layer token 在本主题下不提供深色层次），
     左侧用 brand-primary 竖线；两者都不依赖 color-mix。 */
  background: rgba(127, 127, 127, 0.12);
  border-left: 2px solid var(--dsw-alias-brand-primary);
  border-radius: var(--dsw-radius-md); padding-left: 10px; }
/* 展开时把「标题行」恢复成横向，编辑器独占下一行 */
.mt-itemOpen > .mt-itemHead { display: flex; align-items: center; gap: 12px; }
.mt-itemEditor { display: flex; flex-direction: column; gap: 4px;
  border-top: .5px solid var(--dsw-alias-border-l1); margin-top: 2px; }
.mt-field { display: flex; flex-direction: column; gap: 6px; }
.mt-fieldLabel { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.mt-actions { display: flex; align-items: center; gap: 8px; padding-top: 4px; }
/* 区块底部的操作行：右对齐，与上方内容留一点距离 */
.mt-actionsEnd { justify-content: flex-end; padding-top: 12px; margin-top: 4px;
  border-top: .5px solid var(--dsw-alias-border-l1); }

.mt-empty { color: var(--dsw-alias-label-tertiary); margin: 0; font-size: 13px; line-height: 20px; padding: 12px 0; }
.mt-error { color: var(--dsw-alias-state-error-primary); margin: 0; font-size: 13px; line-height: 20px; }
.mt-dim { color: var(--dsw-alias-label-tertiary); }
.mt-pre { margin: 0; padding: 12px 0 0; font-family: var(--ds-font-family-code, monospace);
  font-size: 13px; line-height: 20px; white-space: pre-wrap; word-break: break-word; }

.mt-table { width: 100%; border-collapse: collapse; font-size: 13px; line-height: 20px; }
.mt-table th { text-align: left; font-weight: 400; color: var(--dsw-alias-label-tertiary);
  padding: 6px 16px 6px 0; white-space: nowrap; }
.mt-table td { padding: 8px 16px 8px 0; vertical-align: middle; }
.mt-table tr + tr td { border-top: .5px solid var(--dsw-alias-border-l1); }
.mt-mono { font-variant-numeric: tabular-nums; }
`;

    const t = (dict, key) => dict[key] ?? key;

    /** 缩到两档：毫秒级的秒数、分钟级。 */
    function duration(seconds) {
      const value = Number(seconds) || 0;
      if (value < 60) return `${Math.round(value)}s`;
      return `${Math.round(value / 60)}m`;
    }

    function useOverview(read) {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: '' });
      const load = React.useCallback(() => {
        let alive = true;
        setState((prev) => ({ ...prev, phase: 'loading', error: '' }));
        read().then((result) => {
          if (!alive) return;
          if (result.ok) setState({ phase: 'ready', data: result.value, error: '' });
          else setState({ phase: 'failed', data: null, error: String(result.error?.message ?? result.error) });
        }).catch((error) => {
          // 远端**抛错**（而不是返回 `{ok:false}`）时也必须落到 failed：
          // 早先只接了 `.then`，reject 会让页面永远停在「读取账本…」，连重试按钮都不出现。
          if (!alive) return;
          setState({ phase: 'failed', data: null, error: error instanceof Error ? error.message : String(error) });
        });
        return () => { alive = false; };
      }, [read]);
      React.useEffect(load, [load]);
      return [state, load];
    }

    /**
     * 把毫秒格式化成紧凑时长：`12s` / `1m04s` / `1h02m`。
     *
     * 运行中每秒都会被调用一次，所以只保留有意义的两位，不显示毫秒。
     */
    function formatDuration(ms) {
      const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
      return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
    }

    /**
     * 开关（boolean 控件）。
     *
     * 官方的 `Switch` 在 `ui-primitives` 里，那不在本包的 baseline 允许清单内，
     * 所以按主题 token 自绘一个：滑块用 `--dsw-alias-switch-thumb`，
     * 打开态底色用品牌色。行为与原生 checkbox 一致（可聚焦、空格/回车切换）。
     */
    function Switch({ checked, disabled = false, label, onChange }) {
      const toggle = () => { if (!disabled) onChange(!checked); };
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        disabled,
        className: checked ? 'mt-switch mt-switchOn' : 'mt-switch',
        onClick: toggle,
      }, h('span', { className: 'mt-switchThumb' }));
    }

    /**
     * 对话内的实时进度窗：挂在 `conversation.input.dock`（输入框上方的整行区域）。
     *
     * job 名册只给**任务级**进度（「专责推理 · 4/7 已结束」）。要「每模型一行」，
     * 必须订阅该 job 的输出流（`observe`），解析 Host 写入的结构化进度行。
     * 只有本插件的 `kind === 'team'` 任务才显示，普通会话里不占地方。
     */
    const TEAM_PREFIX = '\u0000team-progress\u0000';

    /**
     * 控制行前缀：`roster`（开场定序）与 `final`（收尾整表）。
     *
     * 逐行进度靠输出环传递，而输出环有保留上限、会被截断——顺序乱跳与
     * 「已完成的行消失」都是它导致的。这两条消息各只写一次，且在流的两端，
     * 所以 Client 用它们当**权威顺序**与**权威结果**。
     */
    const TEAM_CONTROL = '\u0000team-control\u0000';

    /**
     * 进度窗里的阶段文案。
     *
     * Host 在执行过程中播报 `thinking` / `tool` / `answering`，结算后阶段与状态同义。
     * 这里只做展示映射，认不出的阶段不显示徽标（不猜）。
     */
    const PHASE_LABEL = {
      queued: '排队',
      thinking: '思考',
      tool: '工具',
      answering: '回答',
      done: '完成',
      'no-result': '无结果',
      failed: '失败',
      stopped: '已停止',
    };

    /**
     * 关闭动画时长（毫秒）。与 CSS 的 `mt-dock-out` 必须一致：
     * JS 定时器到点后才写 `dismissed`，两者错开就会出现「动画没播完就消失」。
     */
    const DOCK_CLOSE_MS = 220;

    function LiveTeamDock({ sessionId, jobs, remoteApi }) {
      const [teamJobs, setTeamJobs] = React.useState([]);
      const [models, setModels] = React.useState([]);
      // 走秒用：运行中每秒 +1，驱动总耗时动态更新（不依赖 job 事件频率）。
      const [tick, setTick] = React.useState(0);
      // 正在播关闭动画的 jobId；动画结束后才落到 `dismissed`（后者持久化）。
      const [closing, setClosing] = React.useState(null);
      // 已点过「停止」但还没收到结算的模型：按钮置灰，防连点。
      const [stopping, setStopping] = React.useState({});
      // 停止失败的原因：按钮复原之外还要说一句，别让用户以为「点了没反应」。
      const [stopNote, setStopNote] = React.useState('');

      /**
       * 模型行的稳定位次：`id -> 序号`，**跨渲染持久**。
       *
       * 不能用「本次解析到的第几个」当序号：job 输出环只保留尾部
       * （Host 256KB / Client 128KB），跑久了最早几行会被截掉，
       * 剩下的重新编号 → 行序乱跳。
       * 换 job 时整体清空（新任务重新排位）。
       */
      const orderRefRef = React.useRef(new Map());

      /**
       * 已结算行的存档：`id -> 最后一次看到的完整行`。
       *
       * job 结算后输出环从 256KB 收到 **16KB**（`DEFAULT_SETTLED_RETAIN_BYTES`），
       * 长场次里靠前的模型行会被整段截掉——监控窗就「少了几家」。
       * 每见到一条已结算的行就记下来，被截掉时用存档补回去。
       */
      const lastSeenRef = React.useRef(new Map());
      // 关闭：记住被手动关掉的那次 job；换新任务（新 id）时重新出现。
      // 关闭状态要跨重载保留：按「会话 + 任务 id」记到 localStorage，
      // 否则组件一重建（HMR、刷新、切页回来）那个框又冒出来（踩过）。
      //
      // **只允许在结束后关闭**：执行中把 × 禁用（`canClose`），不然用户关掉就再也
      // 看不到进度，而进度窗恰恰是执行期间唯一能看到「谁在跑、谁失败了」的地方。
      const storageKey = `model-team.dismissed.${sessionId ?? 'none'}`;
      const [dismissed, setDismissedState] = React.useState(() => {
        try { return localStorage.getItem(storageKey) ?? null; } catch { return null; }
      });
      const setDismissed = React.useCallback((jobId) => {
        setDismissedState(jobId);
        try {
          if (jobId) localStorage.setItem(storageKey, jobId);
          else localStorage.removeItem(storageKey);
        } catch { /* 隐私模式禁用存储时忽略 */ }
      }, [storageKey]);

      // ① 订阅名册，挑出本插件的 team 任务。
      React.useEffect(() => {
        if (!jobs || !sessionId) return undefined;
        const release = jobs.watchRows(sessionId);
        const read = () => {
          const snapshot = jobs.state?.getSnapshot?.();
          const list = snapshot?.rows?.[String(sessionId)] ?? [];
          setTeamJobs(list.filter((row) => row.kind === 'team'));
        };
        read();
        const off = jobs.state?.subscribe?.(read);
        return () => {
          off?.();
          release?.();
        };
      }, [jobs, sessionId]);

      // ② 优先显示**运行中**的 team 任务；都结束了才回落到最近一个。
      //    名册按注册序排列，旧任务会一直留着（踩过：dock 一直显示上次失败的那条）。
      const liveJob = teamJobs.find((row) => row.status === 'running' || row.status === 'stopping');
      const current = liveJob ?? teamJobs[teamJobs.length - 1] ?? null;
      const currentId = current?.id ?? null;

      React.useEffect(() => {
        // 换任务先清空，避免上一次的模型行残留（踩过：关掉旧框后新任务仍显示旧行）。
        setModels([]);
        // 换任务时把位次与存档重置，但**先按 id 试图恢复上一份快照**：
        // 同一场次刷新页面时，输出环可能已被截断，快照能把行补回来。
        orderRefRef.current = new Map();
        lastSeenRef.current = new Map();
        try {
          const raw = localStorage.getItem(`${storageKey}.snapshot`);
          if (raw) {
            const saved = JSON.parse(raw);
            // 只有「同一条 job」才恢复：换新任务不该继承上一场的行。
            if (saved?.jobId === currentId && Array.isArray(saved.rows)) {
              const liveNow = current?.status === 'running' || current?.status === 'stopping';
              const order = new Map();
              for (const row of saved.rows) {
                // 已结算的场次不要把「运行中」快照恢复回来（否则停止按钮会一直挂着）。
                if (row.status === 'running' && !liveNow) continue;
                order.set(row.id, row.order ?? order.size);
                lastSeenRef.current.set(row.id, row);
              }
              orderRefRef.current = order;
            }
          }
        } catch { /* 快照坏了就当没有 */ }
        if (!jobs || !currentId) { return undefined; }
        const release = jobs.observe(sessionId, currentId);
        const read = () => {
          const snapshot = jobs.state?.getSnapshot?.();
          const view = snapshot?.observed?.[String(currentId)];
          const text = view?.text ?? view?.output ?? '';
          const parsed = [];
          // 控制行：roster 决定顺序，final 决定最终状态（各自只写一次）。
          let roster = null;
          let finalRows = null;
          for (const line of String(text).split('\n')) {
            const ctlAt = line.indexOf(TEAM_CONTROL);
            if (ctlAt >= 0) {
              try {
                const ctl = JSON.parse(line.slice(ctlAt + TEAM_CONTROL.length));
                if (ctl.type === 'roster' && Array.isArray(ctl.rows)) roster = ctl.rows;
                else if (ctl.type === 'final' && Array.isArray(ctl.rows)) finalRows = ctl.rows;
              } catch { /* 半行忽略 */ }
              continue;
            }
            const at = line.indexOf(TEAM_PREFIX);
            if (at < 0) continue;
            try {
              const item = JSON.parse(line.slice(at + TEAM_PREFIX.length));
              parsed.push(item);
            } catch {
              /* 半行忽略 */
            }
          }
          // 同一个 id 后到的行覆盖先到的（running → done）。
          const byId = new Map();
          for (const item of parsed) {
            byId.set(item.id, item);
          }
          // **顺序必须跨渲染持久**，不能用「本次解析到的第几个」。
          //
          // 踩过：早先按 `byId.size` 现算序号，但 job 输出环只保留尾部
          // （Host 侧 256KB 带上限、Client 侧 `RENDER_TAIL_LIMIT` 128KB），
          // 跑得久或输出多时**最早那几行会被截掉**，剩下的重新编号 → 行序乱跳。
          // 这里改用一个贯穿组件生命周期的 `orderRef`：第一次见到某个 id 就记位，
          // 之后不管中间截掉多少行，它的位置永远不变。
          const orderRef = orderRefRef.current;
          for (const id of byId.keys()) {
            if (!orderRef.has(id)) orderRef.set(id, orderRef.size);
          }
          // **已结算的行要留住**：job 结算后输出环只保留 16KB
          //（`DEFAULT_SETTLED_RETAIN_BYTES`），跑得久的场次靠前的行会被整段截掉，
          // 表现就是「完成的模型从监控窗里消失」。
          // 所以每见到一条已结算的行就存进 `lastSeen`，之后即使它被截掉也补回来。
          const lastSeen = lastSeenRef.current;
          for (const [id, item] of byId) {
            const settled = item.status === 'done' || item.status === 'failed'
              || item.status === 'stopped' || item.status === 'no-result';
            // **运行中的行也要存档**：输出环是按字节裁尾部的，长场次里靠前的
            // 运行行会被截掉；补不回来的话 roster 会把它们重新塞成「排队」，
            // 停止按钮（只对 running 渲染）也跟着消失。结算态由 final 权威覆盖。
            if (settled || item.status === 'running') lastSeen.set(id, item);
          }
          // 被截掉的已结算行补回来；仍在流里的行（running）以**新行**为准。
          for (const [id, archived] of lastSeen) {
            if (!byId.has(id)) byId.set(id, archived);
          }
          // **顺序以 roster 为唯一真源**（它在开场写一次，不受截断影响）。
          // 没有 roster（老场次/被截掉）才退回「首见顺序」。
          const orderRef2 = orderRefRef.current;
          if (roster) {
            roster.forEach((slot, index) => {
              if (!orderRef2.has(slot.id)) orderRef2.set(slot.id, index);
            });
            // 名册里点名过但从未产生进度的行，也要占位显示（状态 = 排队）。
            for (const slot of roster) {
              if (!byId.has(slot.id) && !lastSeen.has(slot.id)) {
                byId.set(slot.id, { ...slot, status: 'queued', phase: 'queued', seconds: null, tail: '' });
              }
            }
          }
          // **结果以 final 为唯一真源**：它有则整表覆盖，逐行进度只负责跑动中的中间态。
          if (finalRows) {
            const keep = new Set(finalRows.map((row) => row.id));
            for (const row of finalRows) {
              byId.set(row.id, { ...(byId.get(row.id) ?? {}), ...row });
              lastSeen.set(row.id, { ...(byId.get(row.id) ?? {}), ...row });
            }
            // final 是**整表**：不在表里的行要删掉。
            // 执行组回落时，Host 会在备选启动前播一条备选自己的行；胜出后 final 用
            // **名册里主力那条的槽位 id** 交回结果，这条备选的临时行就不该再留着
            // （否则一个组显示成「主力失败 + 备选完成」两行）。
            for (const id of [...byId.keys()]) if (!keep.has(id)) byId.delete(id);
            for (const id of [...lastSeen.keys()]) if (!keep.has(id)) lastSeen.delete(id);
          }
          // 已消失的行不删序号：删了会让后出现的行顶替它的位次（顺序又跳）。
          const ordered = [...byId.values()]
            .sort((a, b) => (orderRef2.get(a.id) ?? 0) - (orderRef2.get(b.id) ?? 0));
          setModels(ordered);
          // 落一份快照：输出环在结算后会缩到 16KB，长场次靠前的行会整段消失；
          // 落盘后即使被截掉、甚至刷新页面，也能按这份快照还原「谁跑了、结果如何」。
          try {
            const snapshot = ordered.map((item) => ({
              id: item.id, name: item.name, model: item.model, effort: item.effort,
              status: item.status, phase: item.phase, tail: item.tail, error: item.error,
              seconds: item.seconds, order: orderRef.get(item.id) ?? 0,
            }));
            localStorage.setItem(`${storageKey}.snapshot`, JSON.stringify({ jobId: currentId, rows: snapshot }));
          } catch { /* 隐私模式或超额：不影响渲染 */ }
        };
        read();
        const off = jobs.state?.subscribe?.(read);
        return () => {
          off?.();
          release?.();
        };
      }, [jobs, sessionId, currentId]);

      const isLive = current?.status === 'running' || current?.status === 'stopping';
      const total = models.length;

      // **执行中不允许关闭**：进度窗是运行期间唯一能看到「谁在跑、谁失败了」的地方，
      // 中途关掉等于把可观测性一起关掉。判定用 job 的实时状态（`isLive`），
      // 不看 jobId 是否变化——任务一旦结算就能关。
      const canClose = Boolean(current) && !isLive;

      // 新任务出现时**显式**清掉上一条关闭标记，保证「关掉之后下次执行自动打开」。
      //
      // 规则：**当前显示的这条不是被关掉的那一条 → 解除关闭**。
      // 因为 `dismissed === currentId` 时这里直接返回，所以用户点 × 之后的
      // 那次重渲染不会把标记擦掉（否则会「关不掉」）。
      React.useEffect(() => {
        if (dismissed === null) return;
        // **名册还没到（currentId 为 null）时不要当成「换了任务」。**
        // 首帧 `teamJobs` 为空，早先这里直接 `setDismissed(null)`，把刚从上一次
        // 页面刷新恢复出来的关闭标记擦掉——刷新一次，已关掉的进度窗又冒出来。
        if (currentId === null) return;
        if (dismissed === currentId) return;
        setDismissed(null);
      }, [currentId, dismissed, setDismissed]);

      // 运行中每秒刷新一次 `elapsed`；结算后用 startedAt→finishedAt 的定值。
      //
      // **必须放在所有提前 return 之前**：hook 数量不能随渲染变化。早先这个 effect
      // 写在下面三个 `return null` 之后，首帧（无任务）只跑 7 个 hook、任务出现后跑 8 个，
      // React 抛「Rendered more hooks than during the previous render」；DSH 的 slot 注册表
      // 捕获渲染错误后把这个条目标成 abdicated（inspector 里就是 `active: false`），
      // 于是监控板在页面整个生命周期内再也不渲染——表现就是「又没有自动打开」。
      React.useEffect(() => {
        if (!isLive) return undefined;
        const timer = setInterval(() => setTick((n) => n + 1), 1000);
        return () => clearInterval(timer);
      }, [isLive, currentId]);

      // 关闭动画：点 × 之后先播 `mt-dockClosing`（高度 + 透明度收到 0），**播完才**真的卸载。
      //
      // 直接 `return null` 会让整块瞬间消失；但也不能靠 CSS 动画结束后才 setState，
      // 因为卸载一旦发生 React 就不再渲染这一棵子树——所以顺序必须是
      // 「先标记 closing → 渲染带动画的同一棵树 → 定时器到点再写 dismissed」。
      //
      // `closing` 是「正在播关闭动画的那个 jobId」，与 `dismissed` 分开存：
      // `dismissed` 才是持久化、跨重载的开关，`closing` 只活在这一次过渡里。
      React.useEffect(() => {
        if (closing === null) return undefined;
        const timer = setTimeout(() => setDismissed(closing), DOCK_CLOSE_MS);
        return () => clearTimeout(timer);
      }, [closing, setDismissed]);

      if (!current) return null;
      // 手动关闭过这次任务 → 整块不渲染，不占任何一行。
      // 注意：`closing` 期间 `dismissed` **还没**写入，所以这里仍会渲染（动画才看得见）。
      if (dismissed === currentId) return null;
      // **完成后不自动消失**：这是「任务结束就能看到结果」的常驻视图，
      // 由用户点 × 主动关闭（关闭标记按 job id 记在 localStorage，下次运行会重开）。
      //
      // 早先是「结束后 10 分钟自动隐藏」，但那样一转头就看不到刚才跑成什么样；
      // 现在只要有过模型行就一直留着，只有「从未产生任何行」才不占地方。
      if (!liveJob && !models.length) return null;

      // 运行中用「现在」算，靠 tick 每秒触发重渲染；结算后用 finishedAt 定值。
      void tick;
      const endAt = current.finishedAt ?? (isLive ? Date.now() : undefined);
      const elapsed = current.startedAt && endAt ? formatDuration(endAt - current.startedAt) : '';

      // 标题行的输出文字：执行中是进度（「3/6 已结束」），结束后是结算摘要（「6/6 有结果」）。
      // Host 只报数字，活动名由 `current.label` 单独给（见下）。
      const headline = String(current.progress
        ?? (isLive ? '' : (current.status === 'completed' ? current.detail ?? '' : ''))).trim();
      // `label` 形如 `专责推理 · llm`：拆出活动名与模式，活动名排最前。
      const labelText = String(current.label ?? '多模型团队');
      const [activityName, ...modeRest] = labelText.split(' · ');
      const modeName = modeRest.join(' · ');

      // 关闭动画进行中：此时按钮禁用、整块收高并淡出，动画结束才真正卸载。
      const isClosing = closing !== null && closing === currentId;

      /**
       * 停止某一个模型（单家取消，不影响别家）。
       *
       * 走 Remote 的 `stopModel(runId, id)`：页面拿不到 Host 里的 AbortController，
       * 只能按「场次 + 进度行 id」找回那一家。失败只记日志，不弹窗打扰。
       */
      const stopOne = (item) => {
        const api = remoteApi?.();
        if (!api?.stopModel || !currentId) return;
        setStopping((prev) => ({ ...prev, [item.id]: true }));
        setStopNote('');
        Promise.resolve(api.stopModel({ runId: currentId, id: item.id }))
          .then((res) => {
            if (!res?.ok || res.value?.stopped !== true) {
              setStopping((prev) => ({ ...prev, [item.id]: false }));
              setStopNote(String(res?.value?.reason ?? res?.error?.message ?? '停止失败'));
            }
          })
          .catch((error) => {
            setStopping((prev) => ({ ...prev, [item.id]: false }));
            setStopNote(`停止失败：${error instanceof Error ? error.message : String(error)}`);
          });
      };

      const head = h('div', { className: 'mt-dockHead' },
        h('span', { className: isLive ? 'mt-dockDot mt-dockDotLive' : 'mt-dockDot' }),
        // 顺序固定为 **活动名 → 耗时 → 模式 → 进度**：先认出是哪一类活动，
        // 再看跑了多久，最后看跑到第几家。
        h('span', { className: 'mt-dockTitle' }, activityName),
        elapsed ? h('span', { className: 'mt-dockElapsed' }, elapsed) : null,
        modeName ? h('span', { className: 'mt-dockMode' }, modeName) : null,
        h('div', { style: { flex: 1 } }),
        // 停止失败要说出来：早先只把按钮复原，用户看到的就是「点了没反应」。
        stopNote ? h('span', { className: 'mt-dockProgress mt-bad', title: stopNote }, stopNote) : null,
        headline ? h('span', { className: 'mt-dockProgress' }, headline) : null,
        // 执行中禁用：`disabled` + `aria-disabled` 双标，样式也跟着变灰。
        // 动画期间（`isClosing`）同样禁用，避免连点重复触发定时器。
        h('button', {
          className: canClose && !isClosing ? 'mt-dockClose' : 'mt-dockClose mt-dockCloseLocked',
          disabled: !canClose || isClosing,
          title: canClose
            ? '关闭（下次运行会自动重新打开）'
            : '执行中不可关闭：进度窗要显示到本次执行结束',
          'aria-label': canClose ? '关闭进度窗' : '执行中不可关闭',
          'aria-disabled': canClose && !isClosing ? 'false' : 'true',
          // 先起动画，动画结束（定时器）才写 `dismissed`。
          onClick: () => { if (canClose && !isClosing) setClosing(currentId); },
        }, canClose ? '×' : '·'));

      return h('div', {
        className: isClosing ? 'mt-dock mt-dockClosing' : 'mt-dock',
        // 动画期间对读屏隐藏：内容即将消失，不该再被导航到。
        'aria-hidden': isClosing ? 'true' : undefined,
      },
        // 内层承担卡片外观；外壳只做高度（grid 行 1fr→0fr）与透明度过渡。
        h('div', { className: 'mt-dockInner' },
          head,
          total ? h('ul', { className: 'mt-dockRows' },
          models.map((item) => {
            // 阶段：Host 播报 thinking / tool / answering，结算后与 status 同义。
            const phaseKey = item.phase ?? item.status;
            const phase = PHASE_LABEL[phaseKey] ?? null;
            // 行首图标：等待 / 运行 / 完成 / 失败（运行中旋转，结算后静止）。
            const iconClass = item.status === 'failed' ? 'mt-rowIconBad'
              : item.status === 'done' ? 'mt-rowIconDone'
                : item.status === 'stopped' ? 'mt-rowIconQueued'
                  : item.status === 'no-result' ? 'mt-rowIconQueued'
                    : item.status === 'queued' ? 'mt-rowIconQueued' : 'mt-rowIconLive';
            // 行尾那段「最新输出」，执行中看它在说什么，结束后看最后一句。
            const tailNode = item.error
              ? h('span', { className: 'mt-dockTail mt-bad', title: item.error }, item.error.slice(0, 40))
              : item.tail
                ? h('span', { className: 'mt-dockTail', title: item.tail }, item.tail)
                : null;
            return h('li', { key: item.id, className: 'mt-dockRow' },
              h('span', { className: `mt-rowIcon ${iconClass}`, 'aria-hidden': 'true' }),
              h('span', { className: 'mt-dockName' }, item.name ?? item.model),
              h('span', { className: 'mt-dockEffort mt-dim' }, item.effort || '默认'),
              h('span', {
                className: item.status === 'done' ? 'mt-ok'
                  : item.status === 'failed' ? 'mt-bad' : 'mt-dim',
              }, item.status === 'running' ? '运行'
                : item.status === 'done' ? '完成'
                  : item.status === 'failed' ? '失败'
                    : item.status === 'stopped' ? '已停止'
                      : item.status === 'no-result' ? '无结果' : item.status),
              h('span', { className: 'mt-dockTime mt-dim' },
                item.seconds === null || item.seconds === undefined ? '—' : `${item.seconds}s`),
              // **阶段徽标紧跟输出文字**：思考 / 工具 / 回答 / 完成 说的是「这一段输出是什么」，
              // 两者放一起才读得通。
              phase
                ? h('span', { className: `mt-phase mt-phase-${phaseKey}` }, phase)
                : null,
              tailNode,
              // 运行中才给「停止」：已经结算的没有可取消的东西。
              item.status === 'running'
                ? h('button', {
                  className: 'mt-dockStop',
                  disabled: stopping[item.id] === true,
                  title: stopping[item.id] ? '停止中…' : '停止这一个模型（其它家继续跑）',
                  'aria-label': `停止 ${item.name ?? item.model}`,
                  onClick: () => stopOne(item),
                }, h('span', { className: 'mt-dockStopIcon', 'aria-hidden': 'true' }))
                : null);
          })) : h('p', { className: 'mt-dockWaiting' }, '等待各模型的第一条进度…')));
    }
    /**
     * 自定义下拉（替代原生 `<select>`）。
     *
     * 原生 select 在 macOS 上沿用系统外观、浮层由系统绘制，与 DSH 深色主题不协调；
     * 这里用按钮 + 浮层自己画，配色全部走 `--dsw-alias-*` token。
     */
    function Dropdown({
      value, options, onChange, placeholder = '—', disabled = false,
      narrowed = false, width, searchable = false, searchThreshold = 8,
    }) {
      const [open, setOpen] = React.useState(false);
      const [active, setActive] = React.useState(-1);
      const [query, setQuery] = React.useState('');
      const inputRef = React.useRef(null);

      const selectedIndex = options.findIndex((option) => option.value === (value ?? ''));
      const current = selectedIndex >= 0 ? options[selectedIndex] : null;
      const label = current ? current.label : placeholder;

      // 搜索：按标签与值双向匹配（用户可能输入厂商名或模型名）。
      const needle = query.trim().toLowerCase();
      const shown = needle
        ? options.filter((option) =>
          String(option.label).toLowerCase().includes(needle)
          || String(option.value).toLowerCase().includes(needle))
        : options;
      const canSearch = searchable && options.length >= searchThreshold;

      const close = () => { setOpen(false); setQuery(''); setActive(-1); };

      const choose = (option) => {
        if (!option) return;
        onChange(option.value);
        close();
      };

      // 打开时把光标放进搜索框，省一次点击。
      React.useEffect(() => {
        if (open && canSearch && inputRef.current?.focus) inputRef.current.focus();
      }, [open, canSearch]);

      const onKeyDown = (event) => {
        if (event.key === 'Escape') { event.preventDefault(); close(); return; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!open) { setOpen(true); setActive(Math.max(0, selectedIndex)); return; }
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          setActive((prev) => {
            const next = prev + delta;
            if (next < 0) return shown.length - 1;
            if (next >= shown.length) return 0;
            return next;
          });
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          if (!open) { setOpen(true); return; }
          choose(shown[active >= 0 ? active : 0]);
        }
      };

      return h('div', {
        className: narrowed ? 'mt-dd mt-effortSelect' : 'mt-dd',
        style: width ? { width } : undefined,
        onKeyDown,
        onBlur: (event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) close();
        },
      },
        h('button', {
          type: 'button',
          className: 'mt-ddButton',
          disabled,
          'aria-expanded': open ? 'true' : 'false',
          'aria-haspopup': 'listbox',
          onClick: () => { if (open) close(); else { setOpen(true); setActive(selectedIndex); } },
        },
          h('span', { className: current ? 'mt-ddValue' : 'mt-ddValue mt-ddPlaceholder' }, label),
          h('svg', { className: 'mt-ddChevron', viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': true },
            h('path', { d: 'M3 4.5 6 7.5 9 4.5', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))),
        open ? h('div', { className: 'mt-ddPanel' },
          canSearch ? h('div', { className: 'mt-ddSearchRow' },
            h('input', {
              ref: inputRef,
              className: 'mt-ddSearch',
              value: query,
              placeholder: '搜索…',
              // 输入时不要触发外层的键盘导航（Enter 要选中结果，而不是关面板）
              onKeyDown: (event) => event.stopPropagation(),
              onChange: (event) => { setQuery(event.target.value); setActive(0); },
            })) : null,
          h('ul', { className: 'mt-ddMenu', role: 'listbox' },
            shown.length
              ? shown.map((option, index) => h('li', {
                key: option.value || `opt-${index}`,
                className: 'mt-ddItem',
                role: 'option',
                'aria-selected': option.value === (value ?? '') ? 'true' : 'false',
                'data-active': active === index ? '1' : undefined,
                onMouseEnter: () => setActive(index),
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => choose(option),
              },
                h('span', { className: 'mt-ddCheck' }, option.value === (value ?? '') ? '✓' : ''),
                h('span', { className: 'mt-ddLabel', title: option.label }, option.label)))
              : h('li', { className: 'mt-ddItem mt-ddEmptyItem' }, '没有匹配的项'))) : null);
    }

    /**
     * 执行组编辑：一个模型 + 它在各厂商下的路由。
     *
     * 用户只选模型；候选自动列出该模型的全部厂商路由，列表顺序即回落顺序。
     * 思考强度是**组级**的，一次设置应用到全部路由。组名不手填，用模型名。
     */
    function GroupEditor({ api, catalog, groups, onChanged, createSignal, onCreate }) {
      const [draft, setDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');

      const byModel = React.useMemo(() => {
        const map = new Map();
        for (const model of catalog ?? []) {
          const key = model.modelKey || model.id;
          const entry = map.get(key) ?? { key, label: model.name, routes: [] };
          entry.routes.push(model);
          map.set(key, entry);
        }
        return map;
      }, [catalog]);

      const modelChoices = [...byModel.values()].sort((left, right) =>
        right.routes.length - left.routes.length || left.label.localeCompare(right.label));

      const modelOptions = [
        { value: '', label: '— 选择模型 —' },
        ...modelChoices.map((entry) => ({
          value: entry.key,
          label: `${entry.label}（${entry.routes.length} 个厂商）`,
        })),
      ];

      const chooseModel = (modelKey) => {
        if (!modelKey) { setDraft({ ...draft, modelKey: '', name: '', candidates: [] }); return; }
        const entry = byModel.get(modelKey);
        if (!entry) return;
        const effort = entry.routes[0]?.defaultEffort || '';
        const speed = entry.routes[0]?.defaultSpeed || '';
        setDraft({
          ...draft,
          modelKey,
          name: entry.label,
          reasoningEffort: effort,
          speed,
          candidates: entry.routes.map((route) => ({
            model: `${route.provider}/${route.id}`,
            reasoningEffort: effort,
            speed,
          })),
        });
      };

      React.useEffect(() => {
        if (createSignal > 0) {
          setDraft({
            groupId: `group-${Date.now().toString(36)}`,
            modelKey: '', name: '', reasoningEffort: '', speed: '', candidates: [],
            enabled: true, order: groups.length,
          });
          setError('');
        }
      }, [createSignal]);

      const editing = draft;

      const save = async () => {
        if (!editing) return;
        const filled = editing.candidates.filter((c) => String(c.model || '').trim());
        if (!filled.length) { setError('请先选择一个模型'); return; }
        setBusy(true); setError('');
        try {
          const result = await api.saveGroup({ ...editing, candidates: filled });
          if (result.ok) { setDraft(null); onChanged(result.value); }
          else setError(String(result.error?.message ?? result.error));
        } catch (error) {
          // 远端可能**抛错**而不是返回 `{ok:false}`；没有 finally 时 busy 会永久为 true，
          // 保存/删除按钮从此点不动（真机踩过）。
          setError(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
        }
      };

      const remove = async (groupId) => {
        setBusy(true); setError('');
        try {
          const result = await api.removeGroup({ groupId });
          if (result.ok) onChanged(result.value);
          else setError(String(result.error?.message ?? result.error));
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
        }
      };

      const [dragIndex, setDragIndex] = React.useState(null);
      const [dropAt, setDropAt] = React.useState(null);

      const reorder = (from, to) => {
        if (from === to || from == null || to == null) return;
        const next = [...editing.candidates];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        setDraft({ ...editing, candidates: next });
      };

      const GENERIC_EFFORTS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      /** 换厂商：只列「当前这个模型」在目录里的全部厂商路由。 */
      /**
       * 换厂商：只列该模型在目录里、且**没有被组内其他行占用**的路由。
       *
       * 三条例外都要保留，否则会静默改掉用户的选择或让下拉空白：
       * 1. 当前行自己的值（`value`）——否则选中项不显示；
       * 2. 历史遗留值不在目录里——保底显示原值；
       * 3. 空值——作为「未选择」占位。
       */
      const routeSelect = (value, onChange, index) => {
        const taken = new Set(editing.candidates
          .filter((_, i) => i !== index)
          .map((c) => c.model)
          .filter(Boolean));
        const entry = byModel.get(editing.modelKey);
        const options = (entry?.routes ?? [])
          .map((route) => `${route.provider}/${route.id}`)
          .filter((model) => model === value || !taken.has(model))
          .map((model) => ({ value: model, label: model }));
        // 当前值（含历史遗留）不在候选集里时必须补回去，不能让它变成空。
        if (value && !options.some((option) => option.value === value)) {
          options.unshift({ value, label: value });
        }
        // 该模型的全部路由都已被占用、且当前行也没值：明确提示，不静默留空。
        if (!options.length) {
          return h('span', { className: 'mt-candRoute mt-dim' }, '这个模型的厂商路由都已加入组内');
        }
        return h(Dropdown, {
          value: value || '',
          options,
          onChange,
          placeholder: '— 选择厂商路由 —',
          width: 320,
        });
      };

      const effortSelect = (modelSpec, value, onChange) => {
        const raw = String(modelSpec ?? '').trim();
        // 分档只认双 `@@`（与 Host 的 `src/team.js` 同一口径）：模型 id 自带 `@`
        // 时（`grok/grok-4.7@500k`）不能被劈开。整串先按目录命中一次兜底。
        const whole = (catalog ?? []).find((model) => `${model.provider}/${model.id}` === raw || model.id === raw);
        const doubled = raw.lastIndexOf('@@');
        const head = whole ? raw : (doubled > 0 ? raw.slice(0, doubled) : raw);
        const hit = whole ?? (catalog ?? []).find((model) => `${model.provider}/${model.id}` === head || model.id === head);
        const supported = Array.isArray(hit?.efforts) && hit.efforts.length ? hit.efforts : GENERIC_EFFORTS;
        const listed = value && !supported.includes(value) ? [...supported, value] : supported;
        return h(Dropdown, {
          value: value || '',
          options: listed.map((effort) => ({ value: effort, label: effort ? effort : '默认' })),
          onChange,
          placeholder: '默认',
          narrowed: true,
          width: 96,
        });
      };

      /** 速度档（Devin 的 fast/lightning 等）：和思考强度分开选择。 */
      const speedSelect = (modelSpec, value, onChange) => {
        const raw = String(modelSpec ?? '').trim();
        const whole = (catalog ?? []).find((model) => `${model.provider}/${model.id}` === raw || model.id === raw);
        const doubled = raw.lastIndexOf('@@');
        const head = whole ? raw : (doubled > 0 ? raw.slice(0, doubled) : raw);
        const hit = whole ?? (catalog ?? []).find((model) => `${model.provider}/${model.id}` === head || model.id === head);
        const supported = Array.isArray(hit?.speeds) && hit.speeds.length ? hit.speeds : [''];
        if (supported.length <= 1 && !value) return null;
        const listed = value && !supported.includes(value) ? [...supported, value] : supported;
        return h(Dropdown, {
          value: value || '',
          options: listed.map((speed) => ({ value: speed, label: speed || '标准' })),
          onChange,
          placeholder: '标准',
          narrowed: true,
          width: 96,
        });
      };

      /**
       * 追加一条厂商路由。
       *
       * 默认取「当前模型在目录里、但还没进这个组」的下一条路由；
       * 都被占满时追加一条空路由，由用户自己选。
       */
      /** 该模型还有没有被占用的厂商路由（决定「添加」按钮是否可用）。 */
      const spareRoutes = (current) => {
        const used = new Set(current.candidates.map((c) => c.model).filter(Boolean));
        return (byModel.get(current.modelKey)?.routes ?? [])
          .map((route) => `${route.provider}/${route.id}`)
          .filter((model) => !used.has(model));
      };

      const addRoute = (current) => {
        const [spare] = spareRoutes(current);
        // 全部厂商路由都已在组内：不加重复项，按钮本身也已禁用。
        if (!spare) return;
        setDraft({
          ...current,
          candidates: [...current.candidates, { model: spare, reasoningEffort: current.reasoningEffort ?? '', speed: current.speed ?? '' }],
        });
      };

      const routeRow = (candidate, index) => h('div', {
        key: candidate.model || index,
        className: 'mt-cand',
        draggable: true,
        'data-dragging': dragIndex === index ? '1' : undefined,
        'data-drop-before': dropAt && dropAt.index === index && !dropAt.after ? '1' : undefined,
        'data-drop-after': dropAt && dropAt.index === index && dropAt.after ? '1' : undefined,
        onDragStart: (event) => {
          setDragIndex(index);
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', String(index));
        },
        onDragEnd: () => { setDragIndex(null); setDropAt(null); },
        onDragOver: (event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const rect = event.currentTarget.getBoundingClientRect();
          setDropAt({ index, after: event.clientY > rect.top + rect.height / 2 });
        },
        onDragLeave: () => setDropAt(null),
        onDrop: (event) => {
          event.preventDefault();
          const from = dragIndex ?? Number(event.dataTransfer.getData('text/plain'));
          let to = index;
          if (from != null && !Number.isNaN(from)) {
            if (dropAt?.after) to = index + 1;
            if (from < to) to -= 1;
            reorder(from, to);
          }
          setDragIndex(null);
          setDropAt(null);
        },
      },
        h('button', {
          className: 'mt-dragHandle',
          title: '拖拽排序',
          'aria-label': '拖拽排序',
          type: 'button',
        }, '⠿'),
        // 厂商路由可换（同一模型的不同厂商）、可移除。
        routeSelect(candidate.model, (value) => {
          const next = [...editing.candidates];
          next[index] = { ...next[index], model: value };
          setDraft({ ...editing, candidates: next });
        }, index),
        h('button', {
          className: 'mt-button mt-buttonGhost mt-candRemove',
          title: '移除这条路由',
          disabled: busy,
          onClick: () => {
            const next = editing.candidates.filter((_, i) => i !== index);
            setDraft({ ...editing, candidates: next });
          },
        }, '移除'));

      const routesFieldOf = (current) => h('div', { className: 'mt-field' },
        h('span', { className: 'mt-fieldLabel' }, '厂商路由（按顺序回落，可拖拽排序）'),
        current.candidates.map(routeRow));

      /** 组级思考强度：一致时返回该值；历史数据不一致时返回空（避免误报）。 */
      const groupEffort = (group) => {
        const values = [...new Set((group.candidates ?? []).map((c) => c.reasoningEffort || ''))];
        return values.length === 1 ? values[0] : '';
      };
      const groupSpeed = (group) => {
        const values = [...new Set((group.candidates ?? []).map((c) => c.speed || ''))];
        return values.length === 1 ? values[0] : '';
      };

      /** 编辑器主体：就地展开在它所属的执行组条目里。 */
      const editorBodyOf = (current) => h('div', { className: 'mt-editor' },
        h('div', { className: 'mt-field' },
          h('span', { className: 'mt-fieldLabel' },
            current.name ? `模型与思考强度　·　执行组名称：${current.name}` : '模型与思考强度'),
          h('div', { className: 'mt-cand' },
            h(Dropdown, {
              value: current.modelKey || '',
              options: modelOptions,
              onChange: chooseModel,
              placeholder: '— 选择模型 —',
              width: 340,
              searchable: true,
            }),
            effortSelect(current.candidates[0]?.model, current.reasoningEffort ?? '', (value) => {
              // 思考强度是组级的：一次设置同步到全部厂商路由。
              setDraft({
                ...current,
                reasoningEffort: value,
                candidates: current.candidates.map((candidate) => ({ ...candidate, reasoningEffort: value })),
              });
            }),
            speedSelect(current.candidates[0]?.model, current.speed ?? groupSpeed(current), (value) => {
              // 速度同样是组级的；Devin 的 fast/lightning 不再拼进模型名。
              setDraft({
                ...current,
                speed: value,
                candidates: current.candidates.map((candidate) => ({ ...candidate, speed: value })),
              });
            }),
            h('span', { className: 'mt-rowHint', style: { margin: 0 } },
              `${current.reasoningEffort ? `强度「${current.reasoningEffort}」` : 'provider 默认档'}${current.speed || groupSpeed(current) ? ` · 速度「${current.speed || groupSpeed(current)}」` : ''}`))),

        current.candidates.length
          ? h('div', { className: 'mt-field' },
            h('span', { className: 'mt-fieldLabel' }, '厂商路由（按顺序回落，可拖拽排序）'),
            current.candidates.map(routeRow),
            h('button', {
              className: 'mt-addRow mt-addRowInner',
              disabled: busy || spareRoutes(current).length === 0,
              onClick: () => addRoute(current),
            }, spareRoutes(current).length ? '＋ 添加厂商路由' : '该模型的厂商路由已全部加入'))
          : h('p', { className: 'mt-empty' }, '先选择模型，候选会自动列出它的各厂商路由。'),

        h('div', { className: 'mt-actions' },
          h('button', { className: 'mt-button', disabled: busy || !current.candidates.length, onClick: save },
            busy ? '保存中…' : '保存'),
          h('button', {
            className: 'mt-button mt-buttonGhost',
            onClick: () => { setDraft(null); setError(''); },
          }, '取消')),
        error ? h('p', { className: 'mt-error' }, error) : null);

      return h('section', { className: 'mt-row' },
        h('div', { className: 'mt-groupHead' },
          h('h2', { className: 'mt-rowTitle' }, '执行组')),
        h('p', { className: 'mt-rowHint' },
          '一个执行组对应一个模型；候选是它在各厂商下的路由，第一个先走，失败后按顺序换下一个厂商。'),

        groups.length === 0 && !editing ? h('p', { className: 'mt-empty' }, '还没有执行组。') : null,

        (groups.length > 0 || Boolean(editing)) ? h('ul', { className: 'mt-groups' }, [
          // 已保存的执行组；正在编辑的那条就地展开编辑器。
          ...groups.map((group) => {
            const open = editing && editing.groupId === group.groupId;
            return h('li', {
              key: group.groupId,
              className: open ? 'mt-item mt-itemOpen' : 'mt-item',
            },
              h('div', { className: open ? 'mt-itemHead' : 'mt-itemHeadPlain' },
              h('div', { className: 'mt-itemMain' },
                h('div', { className: 'mt-itemTitle' },
                  h('span', { className: 'mt-itemTitle' }, group.name),
                  // 思考强度是**组级**的：跟在模型名后一次即可，不该逐条厂商重复。
                  groupEffort(group) ? h('span', { className: 'mt-tag' }, `强度 ${groupEffort(group)}`) : null,
                  h('span', { className: group.enabled ? 'mt-tag mt-tagOk' : 'mt-tag' }, group.enabled ? '启用' : '停用'),
                  h('span', { className: 'mt-dim' }, `${group.candidates.length} 个厂商`)),
                h('div', { className: 'mt-vendors' },
                  // 每个厂商一个描边 tag，按回落顺序排列，不显示序号。
                  group.candidates.map((candidate) => h('span', {
                    key: candidate.model,
                    className: 'mt-vendorTag',
                    title: candidate.model,
                  }, candidate.model)))),
              h('div', { className: 'mt-itemActions' },
                open
                  ? h('button', {
                    className: 'mt-button mt-buttonGhost',
                    onClick: () => { setDraft(null); setError(''); },
                  }, '关闭')
                  : h('button', {
                    className: 'mt-button mt-buttonGhost',
                    onClick: () => {
                      const first = group.candidates?.[0]?.model ?? '';
                      const hit = (catalog ?? []).find((model) => `${model.provider}/${model.id}` === first);
                      const clone = JSON.parse(JSON.stringify(group));
                      setDraft({
                        ...clone,
                        modelKey: hit?.modelKey ?? '',
                        reasoningEffort: clone.candidates?.[0]?.reasoningEffort ?? '',
                        speed: clone.candidates?.[0]?.speed ?? '',
                      });
                      setError('');
                    },
                  }, '编辑'),
                h('button', {
                  className: 'mt-button mt-buttonGhost',
                  disabled: busy,
                  onClick: () => remove(group.groupId),
                }, '删除')),
              ),
              open ? h('div', { className: 'mt-itemEditor' },
                h('span', { className: 'mt-fieldLabel' }, '编辑执行组'),
                editorBodyOf(editing)) : null);
          }),
          // 新建（尚未保存）也是一条，就地展开。
          editing && !groups.some((group) => group.groupId === editing.groupId)
            ? h('li', { key: editing.groupId, className: 'mt-item mt-itemOpen' },
              h('div', { className: 'mt-itemHead' },
              h('div', { className: 'mt-itemMain' },
                h('div', { className: 'mt-itemTitle' },
                  h('span', { className: 'mt-itemTitle' }, editing.name || '未命名执行组'),
                  h('span', { className: 'mt-tag' }, '未保存'))),
              h('div', { className: 'mt-itemActions' },
                h('button', {
                  className: 'mt-button mt-buttonGhost',
                  onClick: () => { setDraft(null); setError(''); },
                }, '关闭')),
              ),
              h('div', { className: 'mt-itemEditor' },
                h('span', { className: 'mt-fieldLabel' }, '新建执行组'),
                editorBodyOf(editing)))
            : null,
        ]) : null,

        // 删除失败时编辑器可能没展开（错误只渲染在编辑器里会看不见）。
        error && !editing ? h('p', { className: 'mt-error' }, error) : null,

        // 列表下方的整行虚线按钮：新建执行组。
        h('button', {
          className: 'mt-addRow',
          disabled: busy,
          onClick: () => onCreate(),
        }, '＋ 新建执行组'));
    }

    /**
     * 活动绑定：三类活动各自参与哪些执行组。
     *
     * 执行组共用一份；这里只决定「派谁上场」。
     */
    /**
     * 可用 CLI 范围：决定「下面模型选择里有哪些厂商路由」。
     *
     * 交互与「活动绑定」一致（点芯片切换、✓ 标记、已选计数），因为它也是**选择**而不是开关；
     * 只有范围内（且本机已装）的 CLI 才会被发现模型、进目录、允许调用。
     * DSH 用特殊 id `'dsh'`：关掉它连原生 provider 模型一起不列。
     */
    function ScopeEditor({ api, prefs, harnesses, onChanged }) {
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const scope = Array.isArray(prefs?.enabledHarnesses) ? prefs.enabledHarnesses : null;
      const options = Array.isArray(harnesses) && harnesses.length
        ? harnesses
        : [{ id: 'dsh', label: 'DSH（内置模型）', available: true, kind: 'dsh' }];
      const picked = scope ?? options.map((item) => item.id);
      const isOn = (id) => picked.includes(id);

      const toggle = async (id) => {
        const next = new Set(picked);
        if (next.has(id)) next.delete(id); else next.add(id);
        const values = [...next];
        setBusy(true); setError('');
        try {
          const result = await api.savePrefs({
            reportModel: prefs?.reportModel ?? '',
            concurrency: prefs?.concurrency ?? 0,
            reportDir: prefs?.reportDir ?? '',
            autoUpload: prefs?.autoUpload === true,
            persistData: prefs?.persistData === true,
            // 全选归一成 null：以后新增 CLI 默认也在范围内。
            enabledHarnesses: values.length === options.length ? null : values,
          });
          if (result?.ok) onChanged(result.value);
          else setError(String(result?.error?.message ?? result?.error ?? '保存失败（未返回原因）'));
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      };

      const installed = options.filter((item) => item.kind === 'dsh' || item.available !== false).length;
      return h('section', { className: 'mt-row' },
        h('div', { className: 'mt-groupHead' },
          h('h2', { className: 'mt-rowTitle' }, '可用 CLI 范围'),
          h('span', { className: 'mt-dim', style: { fontSize: 12 } },
            `已选 ${picked.length}/${options.length} · 本机可用 ${installed}`)),
        h('p', { className: 'mt-rowHint' },
          '先选范围，再选模型：范围内的 CLI 才会被发现模型并出现在厂商路由里；'
          + '范围外的既不加载模型，也不允许调用。未安装的置灰。'),
        h('div', { className: 'mt-chips' },
          options.map((item) => {
            const on = isOn(item.id);
            const missing = item.kind === 'cli' && item.available === false;
            return h('button', {
              key: item.id,
              className: on ? 'mt-chip mt-chipOn' : 'mt-chip',
              disabled: busy || missing,
              onClick: () => toggle(item.id),
              title: missing
                ? '本机未安装或未配置：装好后重载插件即可选'
                : (item.kind === 'dsh'
                  ? 'DSH 原生模型（含 subagent 路径）'
                  : `${item.label} 的模型会自动发现`),
            }, [
              on ? h('span', { key: 'check', className: 'mt-chipCheck' }, '✓') : null,
              on || !missing ? item.label : `${item.label}（未安装）`,
            ]);
          })),
        error ? h('p', { className: 'mt-error' }, `保存失败：${error}`) : null);
    }

    function BindingsEditor({ api, groups, bindings, onChanged }) {
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const kinds = [
        { kind: 'audit', label: '事后审计', hint: '找缺陷；需要看得细的模型' },
        { kind: 'design', label: '设计分叉', hint: '出 2～4 个方向，禁止拍板' },
        { kind: 'reason', label: '专责推理', hint: '结构化方案：结论、步骤、风险' },
      ];

      const toggle = async (kind, groupId) => {
        const current = bindings?.[kind] ?? [];
        const next = current.includes(groupId)
          ? current.filter((id) => id !== groupId)
          : [...current, groupId];
        setBusy(true); setError('');
        try {
          const result = await api.setBinding({ kind, groupIds: next });
          if (result.ok) onChanged(result.value);
          else setError(String(result.error?.message ?? result.error));
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      };

      return h('section', { className: 'mt-row' },
        h('div', { className: 'mt-groupHead' }, h('h2', { className: 'mt-rowTitle' }, '活动绑定')),
        h('p', { className: 'mt-rowHint' },
          '三类活动各自派哪些执行组上场。执行组共用上面的配置，这里只做选择；未选时退回全部启用组。'),

        groups.length === 0
          ? h('p', { className: 'mt-empty' }, '先去上面建执行组，这里才有可选的。')
          : kinds.map(({ kind, label, hint }) => {
            const picked = bindings?.[kind] ?? [];
            return h('div', { key: kind, className: 'mt-bindRow' },
              h('div', { className: 'mt-bindHead' },
                h('div', null,
                  h('div', { className: 'mt-bindTitle' }, label),
                  h('div', { className: 'mt-bindHint' }, hint)),
                h('span', { className: 'mt-dim', style: { fontSize: 12 } },
                  picked.length ? `已选 ${picked.length} 组` : '未选（用全部启用组）')),
              h('div', { className: 'mt-chips' },
                groups.map((group) => {
                  const on = picked.includes(group.groupId);
                  return h('button', {
                    key: group.groupId,
                    className: on ? 'mt-chip mt-chipOn' : 'mt-chip',
                    disabled: busy,
                    onClick: () => toggle(kind, group.groupId),
                    title: group.candidates?.map((c) => c.model).join(' / ') ?? '',
                  }, on
                    ? [h('span', { key: 'check', className: 'mt-chipCheck' }, '✓'), group.name]
                    : group.name);
                })));
          }),

        // 绑定保存失败要看得见：早先 `{ok:false}` 被静默吞掉，点了没反应。
        error ? h('p', { className: 'mt-error' }, `保存失败：${error}`) : null);
    }

    /** 偏好：周报总结模型 + 报告目录 + 自动上传开关。 */
    function PrefsEditor({ api, catalog, prefs, onChanged }) {
      const [busy, setBusy] = React.useState(false);
      const [dir, setDir] = React.useState(prefs?.reportDir ?? '');
      React.useEffect(() => { setDir(prefs?.reportDir ?? ''); }, [prefs?.reportDir]);
      const options = catalog ?? [];

      // 保存失败时必须**看得见**：早先静默丢弃（`if (result.ok)` 之外什么都不做），
      // 表现就是「点了开关没反应」——用户不知道是没点着还是存不上。
      const [saveError, setSaveError] = React.useState('');
      const persist = async (patch) => {
        setBusy(true);
        setSaveError('');
        try {
          const result = await api.savePrefs({
            reportModel: prefs?.reportModel ?? '',
            concurrency: prefs?.concurrency ?? 0,
            reportDir: prefs?.reportDir ?? '',
            autoUpload: prefs?.autoUpload === true,
            persistData: prefs?.persistData === true,
            enabledHarnesses: prefs?.enabledHarnesses ?? null,
            ...patch,
          });
          if (result?.ok) onChanged(result.value);
          else setSaveError(String(result?.error?.message ?? result?.error ?? '保存失败（未返回原因）'));
        } catch (error) {
          setSaveError(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
        }
      };

      // 官方设置页的「行」形态：左边标题 + 说明，右边控件。
      const row = (key, title, hint, control) => h('div', { key, className: 'mt-prefRow' },
        h('div', { className: 'mt-prefMain' },
          h('div', { className: 'mt-prefTitle' }, title),
          hint ? h('div', { className: 'mt-prefHint' }, hint) : null),
        h('div', { className: 'mt-prefControl' }, control));

      // 总开关关着时，下面的模型/目录/上传都没意义——直接收起，避免误以为在生效。
      const on = prefs?.persistData === true;

      return h('section', { className: 'mt-row' },
        h('div', { className: 'mt-groupHead' }, h('h2', { className: 'mt-rowTitle' }, '周报与报告')),

        // **总开关**：放在最前。关着时整场「用完即走」——不写账本、不写会话日志、
        // 不生成周报与报告。打开后下面几项才起作用。
        row('persist', '保存数据（周报与报告总开关）',
          on
            ? '已开启：每次执行会把场次与逐模型结果写入本机账本，周报与报告据此生成。'
            : '关闭中：执行结果只在本次对话里返回，不落任何文件，周报与报告不可用。',
          h(Switch, {
            checked: on,
            disabled: busy,
            label: '保存数据',
            onChange: (next) => persist({ persistData: next }),
          })),

        saveError ? h('p', { className: 'mt-error' }, `保存失败：${saveError}`) : null,

        // 开关打开后才显示下面三项：关着时它们不生效，摆出来只会误导。
        on ? h('div', { className: 'mt-prefGroup' },
          row('model', '周报总结模型', '一键生成周报时，用这个模型做 LLM 总结。',
            h(Dropdown, {
              value: prefs?.reportModel || '',
              options: [
                { value: '', label: '— 未配置 —' },
                ...options.map((model) => ({
                  value: `${model.provider}/${model.id}`,
                  label: `${model.name}（${model.provider}/${model.id}）`,
                })),
              ],
              disabled: busy,
              onChange: (next) => persist({ reportModel: next }),
              placeholder: '— 未配置 —',
              width: 280,
              searchable: true,
            })),

          row('dir', '报告目录', '报告写在 <目录>/reports/ 下。留空用默认 ~/.model-team。',
            h('input', {
              className: 'mt-input',
              style: { width: 280 },
              placeholder: '留空 = ~/.model-team',
              value: dir,
              onChange: (event) => setDir(event.target.value),
              onBlur: () => { if ((prefs?.reportDir ?? '') !== dir.trim()) persist({ reportDir: dir.trim() }); },
            })),

          row('upload', '生成报告后自动上传',
            '需同时满足：本开关打开 + 报告目录在 git 仓库里 + 仓库配了远端。',
            h(Switch, {
              checked: prefs?.autoUpload === true,
              disabled: busy,
              label: '生成报告后自动上传',
              onChange: (next) => persist({ autoUpload: next }),
            }))
        ) : null);
    }

    /**
     * 报告：生成静态 HTML 并用浏览器打开。
     *
     * 执行情况与周报是查阅用途，不进配置页；产物落在 `<报告目录>/reports/`。
     */
    function ReportSection({ api }) {
      const [busy, setBusy] = React.useState(false);
      const [result, setResult] = React.useState(null);
      const [error, setError] = React.useState('');
      const [days, setDays] = React.useState('7');

      /** 生成一份新报告，并按 `openAfter` 决定是否立刻用浏览器打开。 */
      const run = async (openAfter) => {
        setBusy(true); setError('');
        try {
          const response = await api.openReport({ days: Number(days) || 7, open: openAfter });
          if (!response.ok) { setError(String(response.error?.message ?? response.error)); return; }
          setResult(response.value);
          if (openAfter) {
            try {
              window.open(`file://${response.value.latest}`, '_blank', 'noopener');
            } catch {
              /* 打不开时下面的链接仍可手动点开 */
            }
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          // 抛错时也要复位，否则「生成并打开」会永久停在「处理中…」。
          setBusy(false);
        }
      };

      /**
       * 只打开已有的最新报告，不重新生成。
       *
       * 走 `openReport({ reuse: true })`：Host 直接返回上次落盘的文件路径，
       * 没有就报错让用户先生成，避免静默生成一份新的。
       */
      const openLatest = async () => {
        setBusy(true); setError('');
        try {
          const response = await api.openReport({ days: Number(days) || 7, reuse: true });
          if (!response.ok) { setError(String(response.error?.message ?? response.error)); return; }
          setResult(response.value);
          try {
            window.open(`file://${response.value.latest}`, '_blank', 'noopener');
          } catch {
            /* 链接仍可手动点开 */
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      };

      return h('section', { className: 'mt-row' },
        h('div', { className: 'mt-groupHead' },
          h('h2', { className: 'mt-rowTitle' }, '执行报告'),
          h('div', { style: { flex: 1 } }),
          h(Dropdown, {
            value: days,
            options: [
              { value: '1', label: '近 1 天' },
              { value: '7', label: '近 7 天' },
              { value: '30', label: '近 30 天' },
            ],
            onChange: setDays,
            width: 280,
          })),
        h('p', { className: 'mt-rowHint' },
          '生成一份自包含的 HTML 报告（场次、模型表现、周报），用浏览器打开查阅；不进设置页。'),

        result ? h('div', { className: 'mt-field' },
          h('p', { className: 'mt-rowHint' },
            h('a', {
              href: `file://${result.latest}`, target: '_blank', rel: 'noopener',
              style: { color: 'var(--dsw-alias-brand-primary)' },
            }, '最新报告文件'),
            h('span', { className: 'mt-dim' }, `　${result.latest}`)),
          h('p', { className: 'mt-rowHint' },
            result.publish === 'uploaded'
              ? h('span', { className: 'mt-ok' }, `已上传：${result.publishNote}`)
              : result.publish === 'skipped' || result.publish === 'reused'
                // `reused` = 只打开了已有报告，不是失败，别用红字。
                ? h('span', { className: 'mt-dim' }, result.publishNote)
                : h('span', { className: 'mt-error' }, result.publishNote)),
          result.github
            ? h('p', { className: 'mt-rowHint' },
              h('a', {
                href: result.github, target: '_blank', rel: 'noopener',
                style: { color: 'var(--dsw-alias-brand-primary)' },
              }, '在线查看归档'),
              h('span', { className: 'mt-dim' }, `　${result.github}`))
            : null) : null,

        error ? h('p', { className: 'mt-error' }, error) : null,

        // 操作放最下方：两个动作并列，主次分明。
        h('div', { className: 'mt-actions mt-actionsEnd' },
          h('button', {
            className: 'mt-button',
            disabled: busy,
            onClick: () => run(true),
          }, busy ? '处理中…' : '生成并打开'),
          h('button', {
            className: 'mt-button mt-buttonGhost',
            disabled: busy,
            onClick: openLatest,
          }, '打开最新')));
    }

    function Page({ dict, read }) {
      const api = React.useMemo(() => read?.() ?? null, [read]);
      const load = React.useCallback(async () => {
        if (!api) return { ok: false, error: { message: 'remote unavailable' } };
        return await api.overview(20);
      }, [api]);
      const [state, reload] = useOverview(load);
      const [config, setConfig] = React.useState(null);
      const [catalog, setCatalog] = React.useState([]);
      const [createSignal, setCreateSignal] = React.useState(0);
      const [configError, setConfigError] = React.useState('');
      const loadConfig = React.useCallback(async () => {
        if (!api) return;
        try {
          const [cfg, cat] = await Promise.all([api.configuration(), api.catalog()]);
          if (cfg.ok) setConfig(cfg.value);
          else setConfigError(String(cfg.error?.message ?? cfg.error));
          if (cat.ok) setCatalog(cat.value.models ?? []);
        } catch (error) {
          // 失败要显示原因：早先静默保持 null，页面按空数组渲染，看起来像「还没有执行组」。
          setConfigError(error instanceof Error ? error.message : String(error));
        }
      }, [api]);
      // 只重拉目录（范围变更后用）：配置以 savePrefs 的写回结果为准，不再二次读。
      const loadCatalog = React.useCallback(async () => {
        if (!api) return;
        try {
          const cat = await api.catalog();
          if (cat.ok) setCatalog(cat.value.models ?? []);
        } catch {
          /* 目录拉取失败时保留旧列表，用户可手动刷新 */
        }
      }, [api]);
      React.useEffect(() => { loadConfig(); }, [loadConfig]);

      if (state.phase === 'loading') {
        return h('div', { className: 'mt-root' },
          h('style', { key: 'mt-css' }, css),
          h('p', { className: 'mt-empty' }, t(dict, 'loading')));
      }
      if (state.phase === 'failed') {
        return h('div', { className: 'mt-root' },
          h('style', { key: 'mt-css' }, css),
          h('div', { className: 'mt-row' },
            h('p', { className: 'mt-error' }, `${t(dict, 'failed')}：${state.error}`),
            h('div', { className: 'mt-actions' },
              h('button', { className: 'mt-button', onClick: reload }, t(dict, 'retry')))));
      }
      const data = state.data ?? {};
      // **账本没就绪不等于整页不可用**：执行组、绑定、总开关都只依赖配置域，
      // 早先这里直接 return 一个「账本未就绪」，SQLite 一打不开用户连配置都改不了。
      const ledgerReady = data.ready !== false;

      return h('div', { className: 'mt-root' },
        // 样式随组件树渲染：只定义 css 字符串而不渲染，界面就完全没有排版（踩过）。
        h('style', { key: 'mt-css' }, css),
        ledgerReady ? null : h('p', { className: 'mt-empty' }, t(dict, 'notReady')),
        configError ? h('p', { className: 'mt-error' }, `配置读取失败：${configError}`) : null,
        h('header', null,
          h('h1', { className: 'mt-pageTitle' }, '多模型团队'),
          h('p', { className: 'mt-intro' }, t(dict, 'subtitle')),

          // Host 半落后于磁盘源码：DSH 的 HMR 只热更 Client 半，改完 index.js 得重载插件。
          // 不提示的话，现象是「前端改了、后端行为没变」，很容易被当成修复失败。
          data.settings?.build?.hostFresh === false
            ? h('p', { className: 'mt-error' }, `⚠ ${data.settings.build.note}`)
            : null),

        // 范围在最上面：它决定下面的执行组能选到哪些厂商路由。
        config?.ready === false
          ? null
          : h(ScopeEditor, {
            api, prefs: config?.prefs, harnesses: config?.harnesses,
            // 立刻用写回结果更新配置（乐观、不做二次读）：再拉一次 configuration 时
            // 若拿到保存前的快照，芯片会闪回「已选」，看起来就是「点了取消没生效」。
            // catalog 必须重拉：范围内的模型集合变了。
            onChanged: (value) => { setConfig(value); loadCatalog(); },
          }),

        config?.ready === false
          ? h('section', { className: 'mt-row' },
            h('div', { className: 'mt-groupHead' }, h('h2', { className: 'mt-rowTitle' }, '执行组')),
            h('p', { className: 'mt-empty' }, '配置存储未就绪：需要 storageDomain。'))
          : h(GroupEditor, {
            api, dict, catalog,
            groups: config?.groups ?? [],
            onChanged: setConfig,
            createSignal,
            onCreate: () => setCreateSignal((n) => n + 1),
          }),

        h(BindingsEditor, {
          api, groups: config?.groups ?? [], bindings: config?.bindings,
          onChanged: setConfig,
        }),

        h(PrefsEditor, {
          api, catalog, prefs: config?.prefs,
          onChanged: (value) => { setConfig(value); },
        }),

        // 报告区跟着总开关走：关着时报告本来就生成不了，摆一个点不动的按钮只会让人困惑。
        config?.prefs?.persistData === true
          ? h(ReportSection, { api })
          : null);
    }

    return {
      inject: ['slots', 'locale', 'remote'],
      async apply(ctx) {
        console.log('model-team: client build', BUILD);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'model-team: dictionaries');

        // 样式必须**插件级**注入一次：`<style>` 若只渲染在某个 slot 的组件树里，
        // 其他 slot（例如输入框上方的 dock）就完全没有样式（踩过：dock 是裸 HTML）。
        // `styles` 是浏览器半拿到的作用域对象；拿不到时退回 document.head。
        ctx.effect(() => {
          if (typeof styles !== 'undefined' && styles?.insert) return styles.insert(css);
          if (typeof document === 'undefined') return undefined;
          const node = document.createElement('style');
          node.setAttribute('data-model-team', '');
          node.textContent = css;
          document.head.appendChild(node);
          return () => node.remove();
        }, 'model-team: styles');

        // 先挂载本包的 Remote 描述符，再用 ctx.inject 声明「remote.modelTeam」取得作用域。
        // 关键：Remote 命名空间是完整服务键 `remote.modelTeam`，直接 ctx.remote.modelTeam
        // 读会在 Cordis 的访问守卫下抛 "without inject"（踩过）。
        const unmount = await ctx.remote.$mount(REMOTE_SPEC);
        const mounted = ctx.inject(['remote.modelTeam', 'slots', 'locale'], (scoped) => {
          const remoteApi = () => scoped.remote.modelTeam ?? null;

          // ① 设置 → 多模型团队（主入口）。
          scoped.slots.inject('settings.section', () => scoped.slots.register({
            name: 'settings.section',
            id: 'model-team',
            order: 30,
            label: () => '多模型团队',
            locale: NS,
            inject: () => ({ remoteApi }),
          }, function ModelTeamSettings(props) {
            return h(Page, { dict: { ...zh, ...en }, read: props.remoteApi });
          }));

          // ② 对话内的实时进度窗（输入框上方整行）。
          // Client 的 `jobs` 服务由 api-job-controller 安装，可能晚于本插件激活，
          // 所以用可选读取 + 等到它就绪再注册，不把它写进 inject（否则本插件可能永不激活）。
          let liveJobs = scoped.get?.('jobs') ?? null;
          const registerDock = () => {
          if (liveJobs) {
            scoped.slots.inject('conversation.input.dock', () => scoped.slots.register({
              name: 'conversation.input.dock',
              id: 'model-team-live',
              order: 10,
              locale: NS,
            }, function ModelTeamLive(props) {
              return h(LiveTeamDock, { sessionId: props.sessionId, jobs: liveJobs, remoteApi });
            }));
          }
          };

          // 服务晚到时轮询几次（最多约 10 秒），拿到就注册。
          if (liveJobs) registerDock();
          else {
            let tries = 0;
            const timer = setInterval(() => {
              liveJobs = scoped.get?.('jobs') ?? null;
              tries += 1;
              if (liveJobs) { clearInterval(timer); registerDock(); }
              else if (tries > 50) clearInterval(timer);
            }, 200);
            scoped.effect?.(() => () => clearInterval(timer));
          }

          // ③ 设置 → 插件 → 多模型团队（同一套面板）。
          scoped.slots.inject('settings.plugins.tab', () => scoped.slots.register({
            name: 'settings.plugins.tab',
            id: 'model-team',
            order: 20,
            label: () => '多模型团队',
            locale: NS,
            inject: () => ({ remoteApi }),
          }, function ModelTeamPluginsTab(props) {
            return h(Page, { dict: { ...zh, ...en }, read: props.remoteApi });
          }));
        });

        // ③ 插件详情页保留一行说明 + 跳转提示（bundle 配置页只画在详情页）。
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: BUNDLE,
          locale: NS,
        }, function ModelTeamBundleNote(props) {
          if (props.view === 'summary') return h('span', { className: 'mt-intro' }, t(zh, 'subtitle'));
          return h('div', { className: 'mt-intro' },
            t(zh, 'subtitle'),
            h('div', { className: 'mt-dim', style: { marginTop: 6 } },
              '配置已移到「设置 → 多模型团队」，或「设置 → 插件 → 多模型团队」。'));
        }));

        // 挂载与 UI 都成功后才把清理器交回去；任一步失败都要把已挂的部分撤掉。
        try {
          await mounted;
        } catch (error) {
          await unmount();
          throw error;
        }
        return async () => {
          try { await mounted.dispose?.(); } finally { await unmount(); }
        };
      },
    };
  },
});
