/**
 * 内置技能 provider：把 `assets/model-team.md` 注册成 DSH 的 `model-team` 技能。
 *
 * 为什么要在插件里注册，而不是把 `.dsh/skills/model-team/SKILL.md` 一起发到 npm：
 * DSH 的技能根只有「项目 `.dsh/skills`」「项目 `.agents/skills`」「customSkillDirs」
 * 「`~/.dsh/skills`」「`~/.agents/skills`」「bundledSkillDir」这几处。
 * 装进 `node_modules/@vastplan/model-team/.dsh/skills` 的技能**一处都落不到**，
 * 别人装了插件也只看得到 `model_team` 工具、看不到技能。
 *
 * 官方 `@deepseek-ai/dsh-skill-badge` 就是这么做的：技能正文随包发布成资源，
 * 由插件在 `apply()` 里 `ctx.skills.registerProvider(...)` 注册成 bundled provider。
 *
 * 优先级：本 provider 用 `BUNDLED_SKILL_RANK`（最低），项目/用户目录里的同名技能
 * 会**压过**它——所以在本项目里改 `.dsh/skills/model-team/SKILL.md` 仍然即时生效。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** provider 名（同一 Cordis 层内不允许重名）。 */
export const PROVIDER_NAME = 'vastplan-model-team';

/** 技能正文的包内位置。 */
const SKILL_URL = new URL('../assets/model-team.md', import.meta.url);

/** 技能正文所在目录，作为 `resourceBase`（技能里引用相对资源时用得上）。 */
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
};

/**
 * bundled 技能的 rank（数字越大优先级越低）。
 *
 * DSH 的 `BUNDLED_SKILL_RANK` 实际是 **600**（`@deepseek-ai/dsh-skill/lib/index.js:24`），
 * 不是这里一度写错的 1000。用 600 是为了与官方 bundled 技能**同级**，
 * 这样「项目 `.dsh/skills`（100）/ 项目 `.agents/skills`（200）/ `~/.dsh/skills`（400）/
 * `~/.agents/skills`（500）」都稳压它一头，符合「本地覆盖内置」的预期。
 *
 * 仍然写死而不 import：`@deepseek-ai/dsh-skill` 只是 peer，宿主一定装，
 * 但本插件不该为**一个数字**把它变成运行时依赖（拿不到时也要能跑）。
 * 数值若有变动，这里的 `rank` 偏大只会让内置技能优先级更低，不会反过来压住本地技能。
 */
const BUNDLED_RANK = 600;

/**
 * 极简 frontmatter 解析：只取顶层 `name` 与 `description`。
 *
 * 不引入 YAML 依赖——技能文件的 frontmatter 就这几行，够用即可。
 * `description: >` 这种折叠块会按行拼接成一句（与 DSH 自己的解析口径一致到能用的程度）。
 *
 * @param raw - 技能文件全文。
 * @returns `{ name, description, whenToUse, body }`；缺字段时给空串。
 */
export function parseSkillMarkdown(raw) {
  const text = String(raw ?? '');
  if (!text.startsWith('---')) return { name: '', description: '', whenToUse: '', body: text.trim() };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { name: '', description: '', whenToUse: '', body: text.trim() };
  const front = text.slice(3, end);
  const body = text.slice(end + 4).trim();

  const fields = {};
  let key = '';
  for (const line of front.split('\n')) {
    if (!line.trim()) continue;
    // 折叠块的续行：缩进且当前 key 是 `>` / `|`
    if (/^\s+\S/.test(line) && key) {
      fields[key] = `${fields[key]} ${line.trim()}`;
      continue;
    }
    const at = line.indexOf(':');
    if (at < 0) continue;
    key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') value = '';
    fields[key] = value;
  }
  const collapse = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  return {
    name: collapse(fields.name),
    description: collapse(fields.description),
    whenToUse: collapse(fields.whenToUse),
    body,
  };
}

/**
 * 构造 provider 对象（与 `ctx.skills.registerProvider` 的契约一致）。
 *
 * `list()` 返回候选摘要，`get(candidate)` 才读正文——注册时不读盘，
 * 只有真的要加载技能时才碰文件（DSH 的 provider 契约就是这样分两段的）。
 *
 * @returns provider 实例。
 */
export function createSkillProvider() {
  /** 只读一次并缓存：技能正文在进程内不会变（改了要重载插件）。 */
  let cached = null;
  const load = async () => {
    if (cached) return cached;
    const raw = await readFile(SKILL_URL, 'utf8');
    const parsed = parseSkillMarkdown(raw);
    cached = {
      name: parsed.name || 'model-team',
      description: parsed.description || '多模型团队：并发调用各模型做审计、分叉与推理。',
      ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
      content: parsed.body,
    };
    return cached;
  };

  const candidateOf = (skill) => ({
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER_NAME,
    source: 'bundled',
    resourceBase: RESOURCE_BASE,
    rank: BUNDLED_RANK,
    locator: { kind: 'model-team' },
  });

  return {
    name: PROVIDER_NAME,
    async list() {
      return [candidateOf(await load())];
    },
    async get(_candidate) {
      const skill = await load();
      return {
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'bundled',
        provider: PROVIDER_NAME,
        resourceBase: RESOURCE_BASE,
        content: skill.content,
      };
    },
  };
}

/**
 * 在给定 ctx 上注册内置技能。
 *
 * `skills` 服务缺席时**安静跳过**：插件的主功能是 `model_team` 工具，
 * 不该因为宿主没挂技能注册表就整个装不起来。
 *
 * @param ctx - Cordis 上下文。
 * @returns 是否成功注册。
 */
export function registerBundledSkill(ctx) {
  try {
    // `ctx.get()` 走 `_getImpl`（不受 inject 门禁），`ctx.skills` 才对 inject 有要求。
    // 本插件不把 `skills` 写进 inject：Cordis 的 `_refresh()` 对**任何**缺失的 inject
    // 服务都会把插件置为 INACTIVE，那样没装技能注册表的宿主连 `model_team` 工具都用不了。
    const skills = ctx.get?.('skills');
    if (!skills || typeof skills.registerProvider !== 'function') {
      ctx.logger?.warn?.('model-team: 宿主没有 skills 服务，内置技能未注册（工具不受影响）');
      return false;
    }
    // registerProvider 必须**同步**调用（契约要求「during plugin apply」），
    // 所以直接调，不套 ctx.effect —— 它自己会挂到调用方 fiber 上。
    const dispose = skills.registerProvider(() => createSkillProvider());
    ctx.effect(() => dispose, 'model-team: bundled skill');
    ctx.logger?.info?.(`model-team: 内置技能已注册（provider=${PROVIDER_NAME}）`);
    return true;
  } catch (error) {
    ctx.logger?.warn?.(`model-team: 内置技能注册失败（工具不受影响）：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
