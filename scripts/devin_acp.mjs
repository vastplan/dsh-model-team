#!/usr/bin/env node
/**
 * devin ACP 客户端：把 `devin acp`（stdio 上的 JSON-RPC）驱动成一次性问答，
 * 流式事件翻成 `invoke_parse` 认识的 NDJSON 打到 stdout。
 *
 * 用法：node devin_acp.mjs --model swe-2-max [--mode ask] -- <prompt>
 *
 * 硬约束：会话固定只读档（默认 `ask`）——set_mode 失败即整场失败，绝不落在 accept-edits；
 * 权限请求一律拒绝；devin 的 stderr 只在失败时回显末尾几行（正常时不能混进事件流）。
 */
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
}
const model = option("--model", "swe-2-max");
const mode = option("--mode", "ask");
const separator = args.indexOf("--");
const prompt = separator >= 0 ? args.slice(separator + 1).join(" ") : "";
if (!prompt.trim()) {
  process.stderr.write("用法：node devin_acp.mjs --model <id> [--mode ask] -- <prompt>\n");
  process.exit(2);
}

const binary = process.env.DEVIN_BIN || "devin";
const child = spawn(binary, ["acp", "--model", model], {
  cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], env: process.env,
});

const errors = [];
child.stderr.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n")) {
    if (line.trim()) errors.push(line);
    if (errors.length > 40) errors.shift();
  }
});

let buffer = "";
let sessionId = "";
let answer = "";
const usage = {};
const cost = {};
let finished = false;
const seenTools = new Set();
const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");

function fail(message) {
  if (finished) return;
  finished = true;
  process.stderr.write(`${message}\n`);
  for (const line of errors.slice(-8)) process.stderr.write(`  devin: ${line}\n`);
  try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
  process.exit(2);
}

/** 金额：devin 目前只报 token；真报了 cost / `*_cost_usd` 就原样带上（有金额必须采集）。 */
function moneyFrom(source) {
  if (!source || typeof source !== "object") return null;
  const record = source;
  const flat = record.total_cost_usd ?? record.totalCostUsd ?? record["cognition.ai/totalCostUsd"];
  if (typeof flat === "number" && Number.isFinite(flat)) return { total: flat };
  if (record.cost && typeof record.cost === "object") return { ...record.cost };
  return null;
}

function handle(message) {
  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    if (message.id === 1) {
      if (message.error) return fail(`ACP initialize 失败：${JSON.stringify(message.error)}`);
      send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
      return;
    }
    if (message.id === 2) {
      if (message.error) return fail(`ACP session/new 失败：${JSON.stringify(message.error)}`);
      sessionId = String(message.result?.sessionId ?? "");
      if (!sessionId) return fail("ACP session/new 没返回 sessionId");
      send({ jsonrpc: "2.0", id: 3, method: "session/set_mode", params: { sessionId, modeId: mode } });
      return;
    }
    if (message.id === 3) {
      if (message.error) return fail(`ACP 切只读档（${mode}）失败：${JSON.stringify(message.error)}`);
      send({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: {
        sessionId, prompt: [{ type: "text", text: prompt }],
      } });
      return;
    }
    if (message.id === 4) {
      if (message.error) return fail(`ACP 会话失败：${JSON.stringify(message.error)}`);
      finished = true;
      const resultUsage = message.result?.usage ?? {};
      const money = moneyFrom(resultUsage) ?? moneyFrom(message.result?._meta) ?? moneyFrom(message.result);
      if (money) Object.assign(cost, money);
      const merged = {
        inputTokens: Number(resultUsage.inputTokens ?? usage.input ?? 0),
        outputTokens: Number(resultUsage.outputTokens ?? usage.output ?? 0),
      };
      if (usage.cacheRead) merged.cacheReadTokens = usage.cacheRead;
      emit({ type: "message_end", message: { role: "assistant", content: answer } });
      emit({ type: "result", result: answer, usage: merged,
             ...(Object.keys(cost).length ? { cost } : {}) });
      try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
      process.exit(0);
    }
    return;
  }
  if (message.method === "session/request_permission") {
    send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } });
    return;
  }
  if (message.method && message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not supported" } });
    return;
  }
  const update = message.params?.update;
  if (message.method !== "session/update" || !update) return;
  if (update.sessionUpdate === "agent_message_chunk" && typeof update.content?.text === "string") {
    answer += update.content.text;
    emit({ type: "message_update", delta: { text: update.content.text } });
    return;
  }
  if (update.sessionUpdate === "agent_thought_chunk" && typeof update.content?.text === "string") {
    emit({ type: "thinking", text: update.content.text });
    return;
  }
  if (update.sessionUpdate === "tool_call") {
    const key = String(update.toolCallId ?? "");
    if (key && !seenTools.has(key)) {
      seenTools.add(key);
      emit({ type: "tool_call", name: String(update.title ?? update.kind ?? "tool") });
    }
    return;
  }
  if (update.sessionUpdate === "usage_update" && update._meta && typeof update._meta === "object") {
    const meta = update._meta;
    usage.input = Math.max(usage.input ?? 0, Number(meta["cognition.ai/inputTokens"] ?? 0));
    usage.output = Math.max(usage.output ?? 0, Number(meta["cognition.ai/outputTokens"] ?? 0));
    usage.cacheRead = Math.max(usage.cacheRead ?? 0, Number(meta["cognition.ai/cachedReadTokens"] ?? 0));
    const money = moneyFrom(meta);
    if (money) Object.assign(cost, money);
  }
}

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    handle(message);
  }
});
child.on("close", (code) => { if (!finished) fail(`devin acp 提前退出（code=${code}）`); });
child.on("error", (error) => fail(`起不了 devin：${String(error?.message ?? error)}`));
process.stdout.on("error", () => {
  try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
  process.exit(1);
});

// 父进程被杀时（runCmd 超时用 SIGKILL）避免 devin 变孤儿：被 reparent 到 1 就收摊。
setInterval(() => {
  if (process.ppid === 1) {
    try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    process.exit(1);
  }
}, 3000).unref();

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "vastplan-model-team", version: "1" },
} });
