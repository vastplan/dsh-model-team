/**
 * 键名表：**从 Python `invoke_parse.py` 原样导出**（SESSION+TURN 合并、COST 各一份），
 * 不再手抄——这些键名踩过坑（`cacheRead` 驼峰漏过一次，导致用量少一项）。
 */
export const SESSION_USAGE_KEYS = {
    "input": "input",
    "output": "output",
    "cache_read": "cache_read",
    "cache_write": "cache_write",
    "inputTokens": "input",
    "input_tokens": "input",
    "prompt_tokens": "input",
    "outputTokens": "output",
    "output_tokens": "output",
    "completion_tokens": "output",
    "cacheReadTokens": "cache_read",
    "cache_read_tokens": "cache_read",
    "cache_read_input_tokens": "cache_read",
    "cacheWriteTokens": "cache_write",
    "cacheWrite": "cache_write",
    "cache_write_tokens": "cache_write",
    "cache_creation_tokens": "cache_write",
    "cache_creation_input_tokens": "cache_write",
    "reasoningTokens": "reasoning",
    "reasoning_tokens": "reasoning",
    "cacheRead": "cache_read",
    "reasoning": "reasoning",
};
export const COST_KEYS = {
    "input": "input",
    "output": "output",
    "cacheRead": "cache_read",
    "cache_read": "cache_read",
    "cacheWrite": "cache_write",
    "cache_write": "cache_write",
    "total": "total",
};
