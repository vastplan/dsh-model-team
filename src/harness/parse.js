/**
 * 解析层（P4）：与 Python `invoke_parse.py` 一一对应——用量/成本/事件/正文。
 *
 * 设计要点与 Python 相同：**按事件形状识别，不认识工具名**。
 * - pi 对 `message_end.usage` 按轮相加（不要把每条 `message_update` 的 cacheRead 加总）；
 * - Cursor 取 `result.usage` 一次；
 * - cline `--json`（`agent_event` 包一层）：`usage` 按轮相加、`totalCost` 是累计金额，`content_end` 是整块正文；
 * - 逐字增量形状（正文/思考平铺在 `data`、逐消息 `usage` 是每轮增量、收尾终局事件的 `usage`
 *   是**累计值**且带账单金额 `total_cost_usd`）：正文按顺序首尾相接（按事件换行拼会碎成单字行）；
 *   累计值**覆写**取一次，逐消息那些轮值不能一起加（会双算）；
 * - 会话文件（旧版把 usage 放顶层）兜底。
 */
import { readFileSync } from "node:fs";
import { COST_KEYS, SESSION_USAGE_KEYS } from "./usage-keys.js";
/** 预览一段工具入参/输出（截断，避免会话日志被大块 JSON 撑爆）。 */
function preview(value, max = 300) {
    const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
    return text.length > max ? text.slice(0, max) + "…" : text;
}
/** cline `--json`：`agent_event` 里再包一层事件（hook_event / run_result / error 与它同级）。 */
function unwrapEvent(ev) {
    const type = String(ev.type ?? "");
    if ((type === "agent_event" || type === "stream_event") && ev.event && typeof ev.event === "object") {
        return ev.event;
    }
    return ev;
}
function asInt(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return Math.round(value);
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
        return Math.round(Number(value));
    return null;
}
function asMoney(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
        return Number(value);
    return null;
}
export function isTokenUsage(obj) {
    if (!obj || typeof obj !== "object")
        return false;
    const record = obj;
    if ("totalTokens" in record || "total_tokens" in record)
        return true;
    if ("inputTokens" in record || "outputTokens" in record || "cacheReadTokens" in record)
        return true;
    // qoderclicn（无头模式 result.usage）用 snake_case
    if ("input_tokens" in record || "output_tokens" in record)
        return true;
    if (record.cost && typeof record.cost === "object" && "input" in record && "output" in record)
        return true;
    // 旧版会话文件直接存本仓库的规范名（input/output/cache_read/cache_write）
    return "input" in record && "output" in record && ("cache_read" in record || "cache_write" in record);
}
export function parseTokenUsage(obj) {
    const isTurn = "totalTokens" in obj || "total_tokens" in obj || (obj.cost !== undefined && typeof obj.cost === "object");
    const keys = SESSION_USAGE_KEYS;
    const acc = {};
    for (const [key, slot] of Object.entries(keys)) {
        const raw = obj[key];
        if (raw === undefined || raw === null)
            continue;
        const value = asInt(raw);
        if (value === null)
            continue;
        // 轮用量与累计用量都归到同一 slot；按轮时只在第一次写入，避免重复累加（Python 同语义）
        if (isTurn)
            acc[slot] = (acc[slot] ?? 0) + value;
        else
            acc[slot] = value;
    }
    return acc;
}
export function parseCostUsage(obj) {
    // qoderclicn 把金额平铺在 `total_cost_usd`（订阅制为 0）；0 会在 resolveCost 里落回估价/未采集
    const flat = asMoney(obj.total_cost_usd);
    if (flat !== null)
        return { total: flat };
    const blob = obj.cost;
    if (!blob || typeof blob !== "object")
        return {};
    const acc = {};
    for (const [key, slot] of Object.entries(COST_KEYS)) {
        const value = asMoney(blob[key]);
        if (value === null)
            continue;
        acc[slot] = value;
    }
    return acc;
}
export function walkUsage(obj, acc) {
    if (isTokenUsage(obj) && obj && typeof obj === "object") {
        for (const [slot, value] of Object.entries(parseTokenUsage(obj))) {
            acc[slot] = (acc[slot] ?? 0) + value;
        }
        return;
    }
    if (obj && typeof obj === "object") {
        const record = obj;
        if (isTokenUsage(record.usage)) {
            walkUsage(record.usage, acc);
            return;
        }
        const message = record.message;
        if (message && typeof message === "object" && isTokenUsage(message.usage)) {
            walkUsage(message.usage, acc);
            return;
        }
        for (const value of Object.values(record)) {
            if (value && typeof value === "object")
                walkUsage(value, acc);
        }
    }
}
/** 有些 CLI 会在 JSON 前加状态码/前缀（pi 的 `429: {"type":"GoUsageLimitError",…}`），剥掉再解析。 */
function stripStatusPrefix(line) {
    return line.replace(/^(?:\d{3}\s*[:：]\s*|error\s*[:：]\s*)/i, "");
}
export function eventsFromRaw(raw) {
    const stripped = stripStatusPrefix(raw.trim());
    if (!stripped)
        return [];
    if (stripped.startsWith("{") || stripped.startsWith("[")) {
        let blob = null;
        try {
            blob = JSON.parse(stripped);
        }
        catch {
            blob = null;
        }
        if (blob && typeof blob === "object" && !Array.isArray(blob)) {
            const record = blob;
            if ("messages" in record || "events" in record || "answer" in record)
                return eventsFromSession(record);
            return [record];
        }
        if (Array.isArray(blob))
            return blob.filter((item) => !!item && typeof item === "object");
    }
    const events = [];
    for (const line of raw.split("\n")) {
        const text = stripStatusPrefix(line.trim());
        if (!text.startsWith("{"))
            continue;
        try {
            const ev = JSON.parse(text);
            if (ev && typeof ev === "object")
                events.push(ev);
        }
        catch {
            /* 半行忽略 */
        }
    }
    return events;
}
function eventsFromSession(blob) {
    const events = [];
    if (Array.isArray(blob.messages)) {
        for (const message of blob.messages)
            events.push({ type: "message_end", message });
    }
    if (Array.isArray(blob.events))
        for (const ev of blob.events)
            if (ev && typeof ev === "object")
                events.push(ev);
    if (!events.length)
        events.push(blob);
    return events;
}
/** qoder message.content 的块按类归拢（顺序在外层保留）。 */
function messageParts(message) {
    const texts = [];
    const tools = [];
    const thinks = [];
    const content = Array.isArray(message.content) ? message.content
        : typeof message.content === "string" ? [message.content] : [];
    for (const part of content) {
        if (typeof part === "string") {
            if (part.trim())
                texts.push(part);
            continue;
        }
        if (!part || typeof part !== "object")
            continue;
        const block = part;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim())
            texts.push(block.text);
        else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim())
            thinks.push(block.thinking);
        else if (block.type === "tool_use")
            tools.push(String(block.name ?? block.id ?? "tool"));
    }
    return { texts, tools, thinks };
}
/** 服务端错误信封（按形状识别，不认识工具名）：`{"type":"GoUsageLimitError","message":"…"}`、
 *  `{"error":{…}}`、`errorMessage` 这类。**必须落进正文**——否则 `hasResult` / `failureKind` / 配额归类
 *  全都看不到它（踩过：opencode-go 日配额用尽只写 stderr 一行 `429: {…}`，结果 exit 0 + 正文空，
 *  被当成「调用成功但没话说」，冷却与用量统计全都漏掉）。 */
function errorEnvelopeText(ev) {
    const type = String(ev.type ?? "");
    const err = ev.error;
    const hasError = (!!err && typeof err === "object" && Object.keys(err).length > 0)
        || (typeof err === "string" && err.trim().length > 0);
    const hasErrorMessage = typeof ev.errorMessage === "string" && ev.errorMessage.trim().length > 0;
    if (hasError || hasErrorMessage)
        return JSON.stringify(ev);
    // 没有 error 字段时只看类型名（`GoUsageLimitError` / `RateLimitError`…），但排除正向事件类型
    if (/error|denied|forbidden|limit|quota|exceeded|unavailable|unauthorized/i.test(type)
        && !/^(message|assistant|result|done|usage|tool|text|thinking|reasoning)/i.test(type)) {
        return JSON.stringify(ev);
    }
    return "";
}
/** 流式事件 → (kind, text)。kind ∈ think/tool/answer/result。 */
export function classifyStreamEvent(raw) {
    const ev = unwrapEvent(raw);
    const type = String(ev.type ?? "");
    // Claude Code `--include-partial-messages`：stream_event 解包后是 content_block_delta/start。
    if (type === "content_block_delta") {
        const delta = ev.delta;
        if (delta && typeof delta === "object") {
            if (delta.type === "text_delta" && typeof delta.text === "string")
                return ["answer", delta.text];
            if (delta.type === "thinking_delta" && typeof delta.thinking === "string")
                return ["think", delta.thinking];
        }
        return ["", ""];
    }
    if (type === "content_block_start" && ev.content_block && ev.content_block.type === "tool_use") {
        return ["tool", String(ev.content_block.name ?? "tool")];
    }
    // cline `--json`：content_start（增量）/ content_end（整块）是思考与正文；tool 块带工具名与入参/输出
    if (type === "content_start" || type === "content_end") {
        const contentType = String(ev.contentType ?? "");
        if (contentType === "reasoning") {
            const text = ev.reasoning;
            return typeof text === "string" && text ? ["think", text] : ["", ""];
        }
        if (contentType === "text") {
            const text = ev.text;
            return typeof text === "string" && text ? ["answer", text] : ["", ""];
        }
        if (contentType === "tool") {
            const name = String(ev.toolName ?? "tool");
            if (type === "content_start")
                return ["tool", `${name}: ${preview(ev.input ?? "")}`];
            return ["tool", `${name} → ${preview(ev.output ?? "")}`];
        }
        return ["", ""];
    }
    // qoderclicn stream-json：assistant/user 事件里是完整 message（thinking / tool_use / text 混排）
    if ((type === "assistant" || type === "user") && ev.message && typeof ev.message === "object") {
        const parts = messageParts(ev.message);
        if (parts.texts.length)
            return ["answer", parts.texts.join("\n")];
        if (parts.tools.length)
            return ["tool", parts.tools.join(", ")];
        if (parts.thinks.length)
            return ["think", parts.thinks[0]];
    }
    if (type === "message_update" || type === "message_delta") {
        const delta = (ev.delta ?? ev.message?.delta);
        if (delta) {
            const text = delta.text ?? delta.content;
            if (typeof text === "string")
                return ["answer", text];
            // 思考增量归 think，不能当 answer：混进正文会让 hasResult 误判、简报提取到脏结果（踩过）
            const thinking = delta.thinking;
            if (typeof thinking === "string")
                return ["think", thinking];
        }
    }
    if (type === "message_end" && ev.message && typeof ev.message === "object") {
        const message = ev.message;
        const content = message.content;
        if (typeof content === "string" && content)
            return ["answer", content];
        if (Array.isArray(content)) {
            const piece = content
                .map((part) => (part && typeof part === "object" ? String(part.text ?? "") : ""))
                .join("");
            if (piece)
                return ["answer", piece];
        }
        // 空内容 + 错误收尾：把 errorMessage 顶上来（否则配额用尽只留在 usage=0 里，
        // exit 0 + 空正文会被当成「成功但没话说」——真机 opencode-go 就是这个形状）
        const errMsg = message.errorMessage ?? message.error;
        if (typeof errMsg === "string" && errMsg.trim())
            return ["answer", errMsg];
        if (message.stopReason === "error" || message.finishReason === "error")
            return ["answer", JSON.stringify(message)];
    }
    if (type === "tool_use" || type === "tool_call" || type === "tool_start") {
        return ["tool", String(ev.name ?? ev.tool ?? ev.toolName ?? ev.title ?? "")];
    }
    // 逐字增量流：正文/思考平铺在 `data`（**逐字**事件，一次一个字）；有的形状把同一块内容
    // 嵌在 `part` 里（opencode v2 的 `text` 事件：正文在 `part.text`）——两种都收。
    // 工具调用分发起与结果两段（`tool_call` / `tool_call_update`）；收尾终局事件带累计用量与账单金额。
    // 按事件形状识别，不认识具体工具（改一家不能碰机制层）。
    if (type === "text" || type === "thought") {
        const part = (ev.part ?? {});
        const text = typeof ev.data === "string" ? ev.data
            : typeof ev.text === "string" ? ev.text
                : typeof part.text === "string" ? part.text
                    : typeof part.thinking === "string" ? part.thinking
                        : "";
        return text ? [type === "thought" ? "think" : "answer", text] : ["", ""];
    }
    if (type === "tool_call_update") {
        const name = String(ev.toolName ?? "tool");
        const output = ev.rawOutput;
        return ["tool", output === undefined || output === null ? name : `${name} → ${preview(output)}`];
    }
    if (type === "end") {
        // 正常收尾：标「已处理」但不带正文（正文在上面按顺序拼）；收尾异常时把原因顶成正文——
        // 否则上限/配额类失败只留在 usage=0 里，看着像「成功但没话说」。
        const reason = String(ev.stopReason ?? "");
        if (reason && !/end_turn|stop|complete/i.test(reason))
            return ["answer", `调用收尾异常（${reason}）：${JSON.stringify(ev)}`];
        return ["result", ""];
    }
    if (type === "result" || type === "run_result" || type === "done") {
        const text = typeof ev.result === "string" ? ev.result : typeof ev.text === "string" ? ev.text : "";
        return text ? ["result", text] : ["", ""];
    }
    if (type === "reasoning" || type === "thinking") {
        return ["think", String(ev.text ?? ev.delta ?? "")];
    }
    const envelope = errorEnvelopeText(ev);
    if (envelope)
        return ["answer", envelope];
    return ["", ""];
}
export function extractText(ev) {
    const type = String(ev.type ?? "");
    if (type === "text" || type === "assistant" || type === "message") {
        if (typeof ev.text === "string")
            return ev.text;
        if (typeof ev.content === "string")
            return ev.content;
        if (Array.isArray(ev.content)) {
            return ev.content
                .map((part) => (part && typeof part === "object" ? String(part.text ?? "") : ""))
                .join("");
        }
        // 逐字增量流：正文平铺在 `data`（逐字事件，拼接口径见 deltaTextAnswer）
        if (typeof ev.data === "string")
            return ev.data;
        const part = (ev.part ?? {});
        if (typeof part.text === "string")
            return part.text;
    }
    return "";
}
function assistantContent(message) {
    const content = message.content;
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => (part && typeof part === "object" ? String(part.text ?? "") : ""))
            .join("");
    }
    return "";
}
/** pi 按轮账单 SUM message_end.usage；Cursor 取 result.usage 一次。
 *  `aggregate` 只决定「同一形状的用量事件重复出现时怎么合」：相加 / 取最后一次 / 按形状猜。 */
export function collectUsage(events, aggregate = "auto") {
    const usage = {};
    const cost = {};
    /** 按声明的口径落一笔用量：auto 保持各分支原有的形状规则。 */
    const merge = (mapped, shape) => {
        const mode = aggregate === "auto" ? (shape === "turn" ? "sum" : "last") : aggregate === "sum-turns" ? "sum" : "last";
        for (const [slot, value] of Object.entries(mapped)) {
            usage[slot] = mode === "sum" ? (usage[slot] ?? 0) + value : value;
        }
    };
    for (const raw of events) {
        const ev = unwrapEvent(raw);
        const type = String(ev.type ?? "");
        if (type === "usage") {
            // cline 按轮用量事件：per-turn 字段相加；totalCost 是累计金额（>0 才算账单，0 落回估价）
            merge(parseTokenUsage(ev), "turn");
            const totalCost = asMoney(ev.totalCost);
            if (totalCost !== null && totalCost > 0)
                cost.total = totalCost;
            continue;
        }
        // 逐字增量形状：逐消息 `usage` 事件 + 带 `total_cost_usd` 的收尾终局事件。
        // 按事件形状识别、不认识具体工具（认工具名就会在 CLI 换实现时静默失效）。
        // 真机两轮核对（2026-10-13）：34812+428=35240、229+86=315、0+34688=34688，与终局 usage 逐位一致。
        if (type === "end") {
            if (isTokenUsage(ev.usage))
                merge(parseTokenUsage(ev.usage), "cumulative");
            for (const [slot, value] of Object.entries(parseCostUsage(ev)))
                cost[slot] = value;
            continue;
        }
        if (type === "step_finish" || type === "step-finish") {
            const part = (ev.part ?? {});
            const tokens = (part.tokens ?? {});
            const cache = (tokens.cache ?? {});
            const mapped = {};
            const input = asInt(tokens.input);
            const output = asInt(tokens.output);
            const reasoning = asInt(tokens.reasoning ?? tokens.reasoningTokens);
            // opencode v2 把缓存读写嵌在 `tokens.cache.{read,write}`——不收就是「token 少了两项」
            // 且查不出原因（2026-10-15 真机核实：free 档回包带 cache.read）。
            const cacheRead = asInt(cache.read ?? cache.readTokens);
            const cacheWrite = asInt(cache.write ?? cache.writeTokens);
            if (input !== null)
                mapped.input = input;
            if (output !== null)
                mapped.output = output;
            if (reasoning !== null)
                mapped.reasoning = reasoning;
            if (cacheRead !== null)
                mapped.cache_read = cacheRead;
            if (cacheWrite !== null)
                mapped.cache_write = cacheWrite;
            // `step_finish` 是**每一步各自的用量**（不是累计值）：多步 agent 循环里每条都独立，
            // 必须相加。真机三步实测（2026-10-18，免费档连跑三条 shell）：
            //   step1 input 98 / out 71 / reasoning 6849 / cache_read 24576
            //   step2 input 11875 / out 57 / reasoning 33 / cache_read 24576
            //   step3 input 221 / out 53 / reasoning 32 / cache_read 36352
            // 累计值会是 98、11875、221 递增；这里明显是每步独立 → 取 max 会**丢步**
            // （旧实现 `Math.max(usage[slot] ?? 0, value)` 还会做字段级混搭：
            //  input 来自步 1、output 来自步 2，拼出一个任何真实请求都不存在的组合）。
            merge(mapped, "turn");
            // 同事件的 `cost` 是账单金额（>0 才算账单；Free 档恒 0 → 落回估价/未采集）
            const partCost = asMoney(part.cost);
            if (partCost !== null && partCost > 0)
                cost.total = partCost;
            continue;
        }
        if (type === "message_end" && ev.message && typeof ev.message === "object") {
            const message = ev.message;
            if (isTokenUsage(message.usage))
                merge(parseTokenUsage(message.usage), "turn");
            if (message.cost && typeof message.cost === "object") {
                for (const [slot, value] of Object.entries(parseCostUsage(message))) {
                    cost[slot] = (cost[slot] ?? 0) + value;
                }
            }
            continue;
        }
        if (type === "result") {
            if (isTokenUsage(ev.usage))
                merge(parseTokenUsage(ev.usage), "cumulative");
            for (const [slot, value] of Object.entries(parseCostUsage(ev)))
                cost[slot] = value;
        }
    }
    return { usage, cost };
}
/** qoderclicn stream-json：assistant/user 事件含完整 message，按 content 块顺序展开成回合消息。
 *  thinking / tool_use（含 Task 类子代理调用）/ tool_result（带 stdout 与退出码）都会留下，
 *  执行过程不再是黑盒；用量仍只取末尾 result（含 total_cost_usd），回合 usage 不累加防重。 */
function qoderMessages(events) {
    if (!events.some((ev) => {
        const type = String(ev.type ?? "");
        return (type === "assistant" || type === "user") && ev.message && typeof ev.message === "object";
    }))
        return null;
    const out = [];
    const toolNames = new Map();
    for (const ev of events) {
        const type = String(ev.type ?? "");
        if (type === "result" && typeof ev.result === "string" && ev.result.trim()) {
            const last = out[out.length - 1];
            if (!last || last.role !== "assistant" || last.content !== ev.result) {
                out.push({ role: "assistant", content: ev.result });
            }
            continue;
        }
        if ((type !== "assistant" && type !== "user") || !ev.message || typeof ev.message !== "object")
            continue;
        const content = ev.message.content;
        const parts = Array.isArray(content) ? content : typeof content === "string" ? [content] : [];
        for (const part of parts) {
            if (typeof part === "string") {
                if (part.trim())
                    out.push({ role: type === "user" ? "user" : "assistant", content: part });
                continue;
            }
            if (!part || typeof part !== "object")
                continue;
            const block = part;
            if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
                out.push({ role: "thinking", content: block.thinking });
            }
            else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
                out.push({ role: "assistant", content: block.text });
            }
            else if (block.type === "tool_use") {
                const name = String(block.name ?? "tool");
                if (typeof block.id === "string")
                    toolNames.set(block.id, name);
                out.push({ role: "tool", content: `${name}: ${preview(block.input ?? "")}` });
            }
            else if (block.type === "tool_result") {
                const name = (typeof block.tool_use_id === "string" && toolNames.get(block.tool_use_id)) || "tool";
                const tail = ev.tool_use_result && typeof ev.tool_use_result === "object"
                    ? (() => {
                        const done = ev.tool_use_result;
                        return `exit ${String(done.exitCode ?? "?")}: ${preview(done.stdout ?? block.content ?? "")}`;
                    })()
                    : preview(block.content ?? "");
                out.push({ role: "tool", content: `${name} → ${tail}` });
            }
        }
    }
    return out.length ? out : null;
}
/** cline `--json` 流：`content_end` 是整块正文（`content_start` 的增量不重记，避免双份）；
 *  工具调用（入参）与工具结果（输出）都留下，执行过程不再是黑盒。 */
function clineMessages(rawEvents) {
    if (!rawEvents.some((ev) => String(ev.type ?? "") === "agent_event"))
        return null;
    const out = [];
    for (const raw of rawEvents) {
        if (String(raw.type ?? "") !== "agent_event")
            continue;
        const ev = unwrapEvent(raw);
        const type = String(ev.type ?? "");
        const contentType = String(ev.contentType ?? "");
        if (contentType === "tool") {
            const name = String(ev.toolName ?? "tool");
            if (type === "content_start")
                out.push({ role: "tool", content: `${name}: ${preview(ev.input ?? "")}` });
            else if (type === "content_end")
                out.push({ role: "tool", content: `${name} → ${preview(ev.output ?? "")}` });
            continue;
        }
        if (type !== "content_end")
            continue;
        if (contentType === "reasoning" && typeof ev.reasoning === "string" && ev.reasoning.trim()) {
            out.push({ role: "thinking", content: ev.reasoning });
        }
        else if (contentType === "text" && typeof ev.text === "string" && ev.text.trim()) {
            out.push({ role: "assistant", content: ev.text });
        }
    }
    return out.length ? out : null;
}
/**
 * 「逐字增量」流形状签名：逐消息 `usage` 事件 + 带 `total_cost_usd` 的收尾终局事件。
 * 按事件形状识别、不认识具体工具——与本文件其余分支同口径。
 */
function isDeltaUsageStream(events) {
    return events.some((ev) => String(ev.type ?? "") === "end" && ev.total_cost_usd !== undefined)
        && events.some((ev) => String(ev.type ?? "") === "usage" && isTokenUsage(ev.usage));
}
/**
 * 逐字增量流正文：`text` 事件是**逐字增量**（一次一个字），必须按顺序首尾相接。
 * 走通用 `answers.join("\n")` 会得到「我\n先\n看」这种碎行（真机逐字吐字核过）。
 * 非正文的收尾异常行照旧独立成段——不能让拼接结果把它盖掉；工具事件不打断正文（那是同一条回答）。
 */
function deltaTextAnswer(events) {
    if (!isDeltaUsageStream(events))
        return "";
    const parts = [];
    let buffer = "";
    const flush = () => {
        if (buffer) {
            parts.push(buffer);
            buffer = "";
        }
    };
    for (const ev of events) {
        if (String(ev.type ?? "") === "text" && typeof ev.data === "string") {
            buffer += ev.data;
            continue;
        }
        const [kind, text] = classifyStreamEvent(ev);
        if ((kind === "answer" || kind === "result") && text) {
            flush();
            parts.push(text);
        }
    }
    flush();
    return parts.join("\n").trim();
}
/** 逐字增量流的会话消息：思考（逐字拼）、正文、工具调用与工具结果都还原，
 *  执行过程不再是黑盒（与其它流式分支同纪律）。 */
function deltaTextMessages(events) {
    const out = [];
    const names = new Map();
    let text = "";
    let thought = "";
    const flush = () => {
        if (thought.trim()) {
            out.push({ role: "thinking", content: thought });
            thought = "";
        }
        if (text.trim()) {
            out.push({ role: "assistant", content: text });
            text = "";
        }
    };
    for (const ev of events) {
        const type = String(ev.type ?? "");
        if (type === "thought" && typeof ev.data === "string") {
            thought += ev.data;
            continue;
        }
        if (type === "text" && typeof ev.data === "string") {
            text += ev.data;
            continue;
        }
        if (type === "tool_call") {
            flush();
            const id = String(ev.toolCallId ?? "");
            const name = String(ev.toolName ?? "tool");
            if (id)
                names.set(id, name);
            out.push({ role: "tool", content: `${name}: ${preview(ev.rawInput ?? "")}` });
            continue;
        }
        if (type === "tool_call_update" && ev.rawOutput !== undefined && ev.rawOutput !== null) {
            const name = names.get(String(ev.toolCallId ?? "")) ?? String(ev.toolName ?? "tool");
            out.push({ role: "tool", content: `${name} → ${preview(ev.rawOutput)}` });
        }
    }
    flush();
    return out.length ? out : null;
}
/** 按时间顺序抽会话消息（不要把 stream delta 存成 jsonl）。 */
export function chronologicalMessages(events) {
    for (const ev of [...events].reverse()) {
        if (ev.type === "agent_end" && Array.isArray(ev.messages) && ev.messages.length) {
            return ev.messages.filter((item) => !!item && typeof item === "object");
        }
    }
    const fromEnd = [];
    for (const ev of events) {
        if (ev.type === "message_end" && ev.message && typeof ev.message === "object")
            fromEnd.push(ev.message);
    }
    if (fromEnd.length)
        return fromEnd;
    const qoder = qoderMessages(events);
    if (qoder)
        return qoder;
    const cline = clineMessages(events);
    if (cline)
        return cline;
    const deltaMessages = deltaTextMessages(events);
    if (deltaMessages)
        return deltaMessages;
    const out = [];
    let current = null;
    for (const ev of events) {
        const [kind, text] = classifyStreamEvent(ev);
        if (!kind || !text)
            continue;
        const role = { think: "thinking", tool: "tool", answer: "assistant", result: "assistant" }[kind] ?? kind;
        if (current && current.role === role && kind !== "tool") {
            current.content = String(current.content ?? "") + text;
            continue;
        }
        current = { role, content: text };
        out.push(current);
    }
    return out;
}
/**
 * 已知结构事件（**故意不取数据**）：会话头、回合/轮次边界、工具执行进度、hook 进度。
 * 它们只标位置不带度量，计入「未处理」会让信号一直亮着、等于没有信号
 * （踩过：qoder 的 `system`、pi 的 `session`/`agent_start`/`turn_start`… 全被算成未处理）。
 */
const MARKER_TYPES = new Set([
    "session", "agent_start", "agent_settled", "turn_start", "turn_end", "iteration_start",
    "message_start", "system", "init", "user", "entry_appended", "auto_retry_start", "auto_retry_end",
    "hook_started", "hook_progress", "hook_response", "hook_event",
    "tool_execution_start", "tool_execution_update", "tool_execution_end", "step_start", "step_end",
    // 回合收尾：token 与金额由 collectUsage 取，不带正文——计入「未处理」只会让信号一直亮着
    "step_finish", "step-finish",
    // 工具/命令清单：纯位置信息不带度量（正文在 text 事件里、用量在 usage/收尾事件里）
    "available_commands",
    // 用量事件：数据由 collectUsage 取，不带正文——计入「未处理」只会让信号一直亮着
    //（踩过：逐字增量流与 cline 的按轮 usage 都被算成未处理，等于没有信号）
    "usage",
]);
/**
 * 完整性：把流里的事件分成两档——
 * - `unknown`：**真没见过**的事件类型（解析层不认），可能漏采 token/事件 → 要人看；
 * - `markers`：已知结构事件，故意不取数据 → 只报数量，不报警。
 *
 * 「执行过程的每一次输入都要处理」不能靠自觉——新工具或新版 CLI 换了事件形状时，
 * 旧代码会静默跳过，表现为「token 少了点」却查不出原因；这里让漏处理变成看得见的数字。
 */
export function unmappedEventTypes(events) {
    const unknown = new Set();
    const markers = new Set();
    for (const raw of events) {
        const ev = unwrapEvent(raw);
        if (classifyStreamEvent(ev)[0])
            continue; // 已归类 → 处理过了
        const type = String(ev.type ?? "") || "(无 type 字段)";
        if (MARKER_TYPES.has(type))
            markers.add(type);
        else
            unknown.add(type);
    }
    return { unknown: [...unknown].sort(), markers: [...markers].sort() };
}
/** 与 Python `parse_output` 同义：正文 + 用量 + 成本 + 会话消息。 */
export function parseOutput(raw, aggregate = "auto") {
    const answers = [];
    const finals = [];
    let sessionAnswer = "";
    const sessionUsage = {};
    let sessionCost = {};
    const stripped = raw.trim();
    if (stripped.startsWith("{") && stripped.endsWith("}")) {
        try {
            const blob = JSON.parse(stripped);
            if (typeof blob.answer === "string" && blob.answer.trim())
                sessionAnswer = blob.answer.trim();
            walkUsage(blob, sessionUsage);
            // 会话文件把账单金额记在 `cost` 里；不取就等于「有账单」认不出来（踩过）
            sessionCost = parseCostUsage(blob);
        }
        catch {
            /* 不是单个 JSON，按事件流处理 */
        }
    }
    const events = eventsFromRaw(raw);
    for (const ev of events) {
        if (ev.type === "message_end" && ev.message && typeof ev.message === "object") {
            const message = ev.message;
            // 用户消息是提示词，不是回答：短回答（<200 字）时它会被当成「最后一个长 final」选中（踩过）
            if (String(message.role ?? "") === "user")
                continue;
            const piece = assistantContent(message);
            if (piece)
                finals.push(piece);
        }
        const [kind, text] = classifyStreamEvent(ev);
        if ((kind === "answer" || kind === "result") && text) {
            answers.push(text);
            if (kind === "result")
                finals.push(text);
        }
        else if (!kind) {
            const piece = extractText(ev);
            if (piece)
                answers.push(piece);
        }
    }
    const { usage: parsedUsage, cost: eventCost } = collectUsage(events, aggregate);
    let usage = parsedUsage;
    if (Object.keys(usage).length === 0 && Object.keys(sessionUsage).length)
        usage = sessionUsage;
    const cost = Object.keys(eventCost).length === 0 ? sessionCost : eventCost;
    const messages = chronologicalMessages(events);
    const { unknown, markers } = unmappedEventTypes(events);
    if (sessionAnswer)
        return { text: sessionAnswer, usage, cost, messages, unmapped: unknown, markers };
    let answer = "";
    if (finals.length) {
        const long = finals.filter((item) => item.length >= 200);
        answer = (long.length ? long[long.length - 1] : finals[finals.length - 1]).trim();
    }
    if (!answer)
        answer = answers.join("\n").trim();
    // 逐字增量形状：正文按顺序拼接，不按事件换行拼（否则碎成单字行）。
    const deltaText = deltaTextAnswer(events);
    if (deltaText)
        answer = deltaText;
    if (!answer && stripped && !stripped.startsWith('{"type":"session"'))
        answer = stripped;
    return { text: answer, usage, cost, messages, unmapped: unknown, markers };
}
/** 读会话文件（旧版会话把 usage 放顶层）。 */
export function readSession(path) {
    try {
        return parseOutput(readFileSync(path, "utf8"));
    }
    catch {
        return null;
    }
}
