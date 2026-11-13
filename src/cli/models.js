/**
 * `model-team models ...`：模型名单与对照表。
 *
 * 与旧 CLI 的差别：没有 `models.json` 的「attempt（同一模型的多条工具链）」概念，
 * 改成「一家 CLI = 一条路由」，列出的是**已发现且本机可用**的 `cli-<harness>/<id>`。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { dataRoot } from './config.js';
import { specOf } from './catalog.js';

/** 按模型 id 取价格表（旧 CLI 的 `models.json` 里 `pricing`，有就显示，没有就留空）。 */
export function loadPricing() {
  const path = join(dataRoot(), 'models.json');
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const list = Array.isArray(raw?.models) ? raw.models : [];
    const table = {};
    for (const model of list) {
      const id = String(model?.id ?? '').trim();
      if (!id) continue;
      table[id] = model?.pricing ?? model?.prices ?? null;
    }
    return table;
  } catch {
    return {};
  }
}

/** `models list`：目录 + 默认名单标记。 */
export function modelsList(catalog, config) {
  const defaults = new Set(config.defaultModels);
  return catalog.map((entry) => ({
    spec: specOf(entry),
    model: entry.id,
    provider: entry.provider,
    name: entry.name,
    harness: entry.harness,
    efforts: entry.efforts ?? [],
    default_effort: entry.defaultEffort ?? '',
    is_default: defaults.has(specOf(entry)),
  }));
}

/** `models catalog`：`id → 显示名 + 各 harness 下的真实模型名`。 */
export function modelsCatalog(catalog) {
  const byKey = new Map();
  for (const entry of catalog) {
    const key = entry.modelKey || entry.id;
    const row = byKey.get(key) ?? { modelKey: key, name: entry.name, routes: [] };
    row.routes.push({
      spec: specOf(entry),
      harness: entry.harness,
      harness_model: entry.harnessModel ?? entry.id,
      harness_provider: entry.harnessProvider ?? '',
    });
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

/** `models check`：默认名单里的每一条是否都能解析到目录。 */
export function modelsCheck(catalog, specs) {
  const known = new Set(catalog.map(specOf));
  return specs.map((spec) => ({ spec, ok: known.has(spec) }));
}

/** 渲染成人读表格。 */
export function renderModelsTable(rows) {
  const lines = [];
  const width = Math.max(8, ...rows.map((row) => row.spec.length));
  for (const row of rows) {
    const mark = row.is_default ? '*' : ' ';
    lines.push(`${mark} ${row.spec.padEnd(width)}  ${row.name}${row.harness ? `  [${row.harness}]` : ''}`);
  }
  return lines.join('\n');
}

export { homedir };

/**
 * 增删 `defaultModels`（写回 `~/.model-team/cli.json`）。
 *
 * @param config - `loadCliConfig()` 的结果（含 path）。
 * @param specs - 要增/删的 spec 列表。
 * @param add - true = 加，false = 删。
 */
export function editDefaultModels(config, specs, add) {
  const path = config.path;
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const list = Array.isArray(current.defaultModels) ? current.defaultModels.map(String) : [];
  const set = new Set(list);
  for (const spec of specs) {
    if (add) set.add(spec);
    else set.delete(spec);
  }
  const next = { ...current, defaultModels: [...set] };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2), 'utf8');
  return { path, added: add ? specs : [], removed: add ? [] : specs, defaultModels: next.defaultModels };
}
