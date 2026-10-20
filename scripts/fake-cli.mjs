#!/usr/bin/env node
/**
 * 测试用的假 CLI：吐 JSONL 事件，支持 `--sleep N` 与 `--fail`。
 * 不依赖任何真实 CLI，用来验证协议层的启动、解析、取消与超时。
 */
const args = process.argv.slice(2);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : '';
};
const model = valueOf('--model');
const sleep = Number(valueOf('--sleep')) || 0;
const fail = args.includes('--fail');
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

emit({ type: 'thinking', text: '先想一下…' });
emit({ type: 'text', text: '答案：' });
emit({ type: 'text', text: model || 'unknown' });
emit({ type: 'message_end', message: { role: 'assistant', usage: { input_tokens: 11, output_tokens: 7 } } });

if (fail) {
  process.stderr.write('boom\n');
  process.exit(2);
}
if (sleep > 0) await new Promise((resolve) => setTimeout(resolve, sleep));
