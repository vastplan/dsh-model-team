/**
 * 读 DSH 插件页的配置（执行组 / 绑定 / 偏好），让命令行**沿用页面里的设置**。
 *
 * 页面把配置存在 `$DSH_HOME/storages/model_team_config.json`（StorageDomain 的 json 后端）：
 * ```
 * { tables: { groups: {id: {groupId,name,candidates[{model,reasoningEffort,speed}],enabled,order,mode}},
 *             bindings: {audit:{kind,groupIds},...},
 *             prefs: {default:{enabledHarnesses,...}} } }
 * ```
 * CLI 只跑 CLI harness，所以 `magpie-anthropic/zcode/...` 这类 DSH 原生路由会被跳过并提示。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 默认的 DSH 配置落点。 */
export function defaultDshConfigPath() {
  const home = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh');
  return join(home, 'storages', 'model_team_config.json');
}

/**
 * 读配置。
 *
 * @param explicitPath - `--dsh-config`；空串走默认。
 * @returns `{ path, exists, groups, bindings, prefs }`
 */
export function readDshConfig(explicitPath = '') {
  const path = String(explicitPath ?? '').trim() || defaultDshConfigPath();
  if (!existsSync(path)) return { path, exists: false, groups: [], bindings: {}, prefs: {} };
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`DSH 配置不是合法 JSON：${path}（${error instanceof Error ? error.message : String(error)}）`);
  }
  const tables = raw?.tables ?? {};
  const groups = Object.values(tables.groups ?? {})
    .filter((group) => group && typeof group === 'object')
    .sort((left, right) => (Number(left.order) || 0) - (Number(right.order) || 0));
  const bindings = {};
  for (const [kind, value] of Object.entries(tables.bindings ?? {})) {
    bindings[kind] = Array.isArray(value?.groupIds) ? value.groupIds.map(String) : [];
  }
  const prefs = tables.prefs?.default ?? tables.prefs ?? {};
  return { path, exists: true, groups, bindings, prefs };
}

/** 组里的候选 → 规范 spec（`provider/id@@effort`）。 */
export function candidateSpec(candidate) {
  const model = String(candidate?.model ?? '').trim();
  if (!model) return '';
  const effort = String(candidate?.reasoningEffort ?? '').trim();
  return effort && !model.includes('@@') ? `${model}@@${effort}` : model;
}

/**
 * 按活动类型取要跑的组。
 *
 * 规则与插件页一致：
 * - 有绑定 → 只用绑定的组（顺序按绑定顺序）；
 * - 没绑定 → 退回全部**启用**的组；
 * - 组被停用 → 默认执行时跳过。
 *
 * @returns `{ groups: [{groupId,name,candidates:string[]}], skipped: [{group, model, reason}] }`
 */
export function planFromDsh(config, kind, catalog, options = {}) {
  const enabledIds = Array.isArray(options.groupIds) && options.groupIds.length ? new Set(options.groupIds) : null;
  const bound = config.bindings?.[kind] ?? [];
  const useBound = bound.length > 0;
  const selected = config.groups.filter((group) => {
    if (enabledIds) return enabledIds.has(String(group.groupId));
    if (useBound) return bound.includes(String(group.groupId)) && group.enabled !== false;
    return group.enabled !== false;
  });
  if (useBound) {
    // 绑定顺序优先于 order。
    selected.sort((left, right) => bound.indexOf(String(left.groupId)) - bound.indexOf(String(right.groupId)));
  }
  const known = new Set(catalog.map((entry) => `${entry.provider}/${entry.id}`));
  // 页面「可用 CLI 范围」（prefs.enabledHarnesses）：null/缺省 = 全部；数组 = 只允许这些 harness。
  const scope = Array.isArray(config.prefs?.enabledHarnesses)
    ? new Set(config.prefs.enabledHarnesses.map(String))
    : null;
  const groups = [];
  const skipped = [];
  for (const group of selected) {
    const candidates = [];
    for (const candidate of group.candidates ?? []) {
      const spec = candidateSpec(candidate);
      if (!spec) continue;
      const head = spec.split('@@')[0];
      if (!known.has(head)) {
        skipped.push({ group: group.name, model: spec, reason: '不在 CLI 目录（可能是 DSH 原生路由）' });
        continue;
      }
      const harness = head.startsWith('cli-') ? head.slice(4).split('/')[0] : '';
      if (scope && harness && !scope.has(harness)) {
        skipped.push({ group: group.name, model: spec, reason: `不在页面「可用 CLI 范围」里（${harness}）` });
        continue;
      }
      candidates.push(spec);
    }
    if (!candidates.length) {
      skipped.push({ group: group.name, model: '', reason: '组内没有 CLI 可跑的候选' });
      continue;
    }
    groups.push({ groupId: String(group.groupId), name: String(group.name ?? group.groupId), candidates });
  }
  return { groups, skipped };
}
