/**
 * 执行组：同一组里多个备选模型，第一个是主力，失败后按顺序落到下一个。
 *
 * 这与「名单里的多条独立条目」是两件事：
 * - **列表项**：每家各跑一次（并发），用于横向对比；
 * - **执行组**：一组算一家，只有第一个有结果的算数，后面的只在前面失败时启用。
 *
 * 存储位置：DSH 系统存储（`ctx.storageDomain`，域 `model_team_config`）。
 * 这是非核心的界面配置，量很小（几条），全量载入无压力。
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

import { joinEffort, splitEffort } from './team.js';

/** 一个候选：模型 + 可选的思考强度。 */
const candidateSchema = z.object({
  /** `provider/model` 形式；与 `resolveTeam` 的解析口径一致。 */
  model: z.string(),
  /** 思考强度；空串表示用 provider 默认。 */
  reasoningEffort: z.string(),
});

/** 一个执行组。 */
const groupSchema = z.object({
  /** 组 id（稳定标识，页面按它增删）。 */
  groupId: z.string(),
  /** 展示名。 */
  name: z.string(),
  /** 候选列表：`[0]` 是主力，其后是备选，按顺序回落。 */
  candidates: z.array(candidateSchema),
  /** 是否参与默认执行；`false` 时只在显式点名时使用。 */
  enabled: z.boolean(),
  /** 排序权重，小的在前。 */
  order: z.number(),
});

/** 配置域：一个 `groups` 表 + 一个 `prefs` 表（总结模型等）。 */
export const CONFIG_SPEC = defineDomain({
  name: 'model_team_config',
  // v2：新增 `bindings` 表（三类活动各自参与哪些执行组）。
  // 旧记录读入时缺这个表，`loadAll` 会给空表，不影响已有 groups / prefs。
  version: 2,
  compatibleVersions: [1],
  tables: {
    groups: domainTable(groupSchema),
    prefs: domainTable(z.object({
      reportModel: z.string(),
      /** 每次执行最大并发数；0 表示不限制。 */
      concurrency: z.number(),
      /**
       * 报告输出目录。
       *
       * 空串 = 用默认的 `~/.model-team`（技能侧的归档根，本身是 git 仓，
       * 有远端就自动上传）。填别的目录就在那里生成，同样按目录的 git 状态决定是否推送。
       */
      reportDir: z.string(),
      /**
       * 生成报告后是否自动上传。
       *
       * 默认关：上传是外发动作，必须显式打开。
       * 打开后仍需目录本身满足条件（git 仓 + 有远端），否则只落本地。
       */
      autoUpload: z.boolean(),
      /**
       * **总开关：是否把数据落盘**。
       *
       * 关着的时候（默认）：
       * - 不写账本（`$DSH_HOME/model-team/ledger.db`）；
       * - 不写会话日志（`runs/<场次ID>/`）；
       * - 不生成周报、不生成报告——两者的数据源都是「已落盘的数据」。
       *
       * 打开后上述功能全部启用。之所以默认关：这个插件会在本机持续累积
       * 各模型的调用记录与正文，属于「用户没主动要就不该落盘」的东西。
       *
       * `.optional()` 是给已有配置的兼容：老记录里没有这个键，
       * 读出来按 `undefined` 处理，由 `readPrefs` 统一归一成 `false`。
       */
      persistData: z.boolean().optional(),
      /**
       * 可用 CLI 范围：允许被选择/调用的 harness id 列表（`'dsh'` 表示 DSH 原生模型）。
       *
       * `null`/缺失 = 全部启用（默认）。空数组 = 全部关闭（只剩显式点名也无法调用）。
       * 老记录读到 `undefined` 时由 {@link readPrefs} 归一成 `null`，行为保持「全开」。
       */
      enabledHarnesses: z.array(z.string()).nullable().optional(),
    })),
    /**
     * 活动类型 → 参与的执行组 id 列表。
     *
     * 执行组本身**共用一份**（groups 表）；这里只决定「某类活动跑哪些组」。
     * 空列表 = 该类活动不跑任何组（只跑显式点名的）。
     */
    bindings: domainTable(z.object({
      kind: z.enum(['audit', 'design', 'reason']),
      groupIds: z.array(z.string()),
    })),
  },
});

/** 三类活动。 */
export const KINDS_OF_RUN = ['audit', 'design', 'reason'];

/** 读某类活动绑定的执行组 id；缺省返回空数组（= 不自动跑组）。 */
export function readBinding(config, kind) {
  if (!config) return [];
  return config.table('bindings').get(kind)?.groupIds ?? [];
}

/** 写某类活动绑定的执行组 id。 */
export async function saveBinding(config, kind, groupIds) {
  if (!config) throw new Error('配置存储不可用（需要 storageDomain）');
  await config.table('bindings').put(kind, { kind, groupIds: [...new Set(groupIds)] });
}

/** 读全部绑定（页面渲染用）。 */
export function readBindings(config) {
  if (!config) return Object.fromEntries(KINDS_OF_RUN.map((kind) => [kind, []]));
  const out = Object.fromEntries(KINDS_OF_RUN.map((kind) => [kind, []]));
  for (const [, binding] of config.table('bindings').entries()) {
    if (binding?.kind) out[binding.kind] = binding.groupIds ?? [];
  }
  return out;
}

/** 打开配置域；已打开时复用（域一次只允许一个句柄）。 */
export async function openConfig(ctx) {
  const storage = ctx.get('storageDomain');
  if (!storage) return null;
  const existing = storage.get('model_team_config');
  if (existing) return existing;
  try {
    return await storage.open(CONFIG_SPEC);
  } catch (error) {
    // `already-open` 说明别人先开了：直接拿它，别让配置面失效。
    const raced = storage.get('model_team_config');
    if (raced) return raced;
    ctx.logger?.warn?.(`model-team: 配置域打开失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** 读全部执行组，按 `order` 升序。 */
export function readGroups(config) {
  if (!config) return [];
  return [...config.table('groups').entries()]
    .map(([, group]) => group)
    .sort((left, right) => left.order - right.order || left.groupId.localeCompare(right.groupId));
}

/** 读偏好设置。 */
/** 偏好的完整默认值（新增字段只在这里加，读出来的对象形状恒定）。 */
export const DEFAULT_PREFS = Object.freeze({
  reportModel: '',
  concurrency: 0,
  reportDir: '',
  autoUpload: false,
  /** 总开关：保存数据 / 启用周报与报告。默认关。 */
  persistData: false,
  /** 可用 CLI 范围：`null` = 全部（含 dsh）；数组 = 仅这些。 */
  enabledHarnesses: null,
});

export function readPrefs(config) {
  const stored = config ? config.table('prefs').get('default') : null;
  // **总是补齐默认值**：老记录缺 `persistData` 时不能读成 undefined，
  // 否则 `if (prefs.persistData)` 这种判断看着是 false、`=== false` 判断又对不上。
  const merged = { ...DEFAULT_PREFS, ...(stored ?? {}) };
  // `null` 与 `undefined` 都表示「全开」；只有数组才是显式范围。
  merged.enabledHarnesses = Array.isArray(merged.enabledHarnesses)
    ? [...new Set(merged.enabledHarnesses.map((item) => String(item).trim()).filter(Boolean))]
    : null;
  return merged;
}

/** 写一个执行组（新增或覆盖）。 */
export async function saveGroup(config, group) {
  if (!config) throw new Error('配置存储不可用（需要 storageDomain）');
  await config.table('groups').put(group.groupId, group);
}

/** 删除一个执行组。 */
export async function deleteGroup(config, groupId) {
  if (!config) throw new Error('配置存储不可用（需要 storageDomain）');
  const id = String(groupId ?? '');
  // **先清理绑定再删组**：否则活动绑定会指向不存在的组。
  // 下游选组时解析为空，早先会退化成「跑整个模型目录」（见 index.js 的选组逻辑）。
  const bindings = config.table('bindings');
  const pending = [...bindings.entries()]
    .filter(([, binding]) => Array.isArray(binding?.groupIds) && binding.groupIds.includes(id))
    .map(([kind, binding]) => [kind, binding.groupIds.filter((item) => item !== id)]);
  for (const [kind, groupIds] of pending) {
    await bindings.put(kind, { kind, groupIds: [...new Set(groupIds)] });
  }
  return await config.table('groups').delete(id);
}

/** 写偏好设置。 */
export async function savePrefs(config, prefs) {
  if (!config) throw new Error('配置存储不可用（需要 storageDomain）');
  await config.table('prefs').put('default', prefs);
}

/**
 * 把执行组的候选折叠成可调用条目（不含 provider 解析）。
 *
 * 候选写法与名单一致：`provider/model` 或 `provider/model@@effort`。返回顺序即回落顺序。
 *
 * 分档**只认双 `@@`**：模型 id 自带 `@`（`grok/grok-4.7@500k` 里的 500k 是上下文窗口
 * 标注）时不会被劈开。早期版本把单 `@` 也当分隔符，拼出过 `...@500k@` 这种空尾巴；
 * 历史配置里的这种写法由 {@link stripLegacyTail} 收口。
 */
export function candidatesOf(group) {
  return (group?.candidates ?? []).map((candidate) => {
    const raw = stripLegacyTail(String(candidate.model ?? '').trim());
    const { head, effort: embedded } = splitEffort(raw);
    const effort = String(candidate.reasoningEffort ?? '').trim() || embedded;
    return joinEffort(head, effort);
  }).filter(Boolean);
}

/**
 * 收口「早先按单 `@` 拼出来」的历史尾巴：`...@500k@` 这种以 `@` 结尾的写法。
 *
 * 只剥掉**末尾孤立的** `@`（它一定是被拼空的 effort），不动模型 id 中间自带的 `@`。
 */
function stripLegacyTail(raw) {
  return raw.endsWith('@') ? raw.slice(0, -1) : raw;
}
