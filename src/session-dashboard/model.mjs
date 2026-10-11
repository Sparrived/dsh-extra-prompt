// Pure projections and metrics calculation for the Session Statistics Dashboard.
//
// Extracted and enhanced from Deeptop:
// Computes session summary, turn activity, token usage breakdowns, timing metrics,
// and cost attribution (tool errors, retries, wasted turns, repeated commands).
//
// Pure JavaScript: zero external dependencies, testable under plain `node --test`.

/**
 * Extract a finite number or undefined.
 * @param {unknown} value
 * @returns {number | undefined}
 */
export function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Extract an object or undefined.
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
export function recordValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined;
}

/**
 * Turn coordinate of an event or message.
 * @param {any} entry
 * @returns {number | undefined}
 */
export function eventTurn(entry) {
  const event = entry?.event || entry;
  const data = recordValue(event?.data) ?? {};
  const message = recordValue(data.message);
  return numberValue(data.turn) ?? numberValue(message?.turn);
}

/**
 * Step coordinate of an event or message.
 * @param {any} entry
 * @returns {number | undefined}
 */
export function eventStep(entry) {
  const event = entry?.event || entry;
  const data = recordValue(event?.data) ?? {};
  const message = recordValue(data.message);
  return numberValue(data.step) ?? numberValue(message?.step);
}

/**
 * Whether a message was an injected prompt/context rather than a direct user prompt.
 * @param {any} event
 * @returns {boolean}
 */
export function isInjectedMessage(event) {
  const data = recordValue(event?.data) ?? {};
  const message = recordValue(data.message);
  const source = recordValue(data.source) ?? recordValue(message?.source);
  const kind = typeof source?.kind === 'string' ? source.kind.trim().toLowerCase() : undefined;
  return source !== undefined && kind !== 'user';
}

/**
 * Extract tool name from a tool/call or tool/result event.
 * @param {any} event
 * @returns {string}
 */
export function eventToolName(event) {
  const data = recordValue(event?.data) ?? {};
  const name = typeof data.name === 'string' ? data.name : typeof data.tool === 'string' ? data.tool : undefined;
  return name && name.trim() ? name.trim() : 'tool';
}

/**
 * Extract tool callId.
 * @param {any} event
 * @returns {string | undefined}
 */
export function eventToolCallId(event) {
  const data = recordValue(event?.data) ?? {};
  if (typeof data.callId === 'string' && data.callId) return data.callId;
  const message = recordValue(data.message);
  if (typeof message?.toolCallId === 'string' && message.toolCallId) return message.toolCallId;
  const source = recordValue(message?.source);
  if (typeof source?.callId === 'string' && source.callId) return source.callId;
  const content = Array.isArray(message?.content) ? message.content[0] : undefined;
  if (content && typeof content === 'object' && typeof content.toolCallId === 'string') {
    return content.toolCallId;
  }
  return undefined;
}

/**
 * Check whether a tool/result represents an error/failure.
 * @param {any} event
 * @returns {boolean}
 */
export function eventToolResultError(event) {
  if (!event || event.type !== 'tool/result') return false;
  const data = recordValue(event.data) ?? {};
  const message = recordValue(data.message);
  if (message?.isError === true) return true;

  const content = Array.isArray(message?.content) ? message.content[0] : undefined;
  if (content && typeof content === 'object' && content.isError === true) return true;

  const candidates = [data, recordValue(data.result), recordValue(data.output), recordValue(data.value)].filter(Boolean);
  return candidates.some((val) => {
    if (!val) return false;
    const status = String(val.status ?? val.state ?? '').toLowerCase();
    return val.isError === true
      || val.ok === false
      || val.success === false
      || val.error !== undefined
      || val.exception !== undefined
      || ['error', 'failed', 'failure', 'cancelled', 'canceled', 'rejected'].includes(status);
  });
}

/**
 * Parse tool arguments into an object or string.
 * @param {unknown} args
 * @returns {Record<string, unknown> | undefined}
 */
export function parseToolArgs(args) {
  if (!args) return undefined;
  if (typeof args === 'object' && !Array.isArray(args)) return /** @type {Record<string, unknown>} */ (args);
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return undefined;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // ignore
    }
  }
  return undefined;
}

/**
 * Normalize shell command string for repetition detection.
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizeCommand(value) {
  if (typeof value !== 'string') return undefined;
  const collapsed = value.replace(/\s+/gu, ' ').trim();
  return collapsed || undefined;
}

/**
 * Extract shell command string from tool call arguments.
 * @param {string} toolName
 * @param {Record<string, unknown> | undefined} args
 * @returns {string | undefined}
 */
export function commandOfToolCall(toolName, args) {
  if (!args) return undefined;
  const normalized = toolName.trim().toLowerCase();
  const isShell = normalized === 'pwsh'
    || normalized === 'bash'
    || normalized === 'shell'
    || normalized === 'exec'
    || normalized.startsWith('terminal_');
  if (!isShell) return undefined;
  return normalizeCommand(args.command) ?? normalizeCommand(args.shellCommand);
}

/**
 * Map turn/end reason to stable outcome string.
 * @param {unknown} reason
 * @returns {'completed' | 'error' | 'cancelled' | 'max-tokens' | 'blocked' | 'interrupted' | 'open'}
 */
export function turnOutcome(reason) {
  const record = recordValue(reason);
  const kind = typeof record?.kind === 'string' ? record.kind : undefined;
  switch (kind) {
    case 'error': return 'error';
    case 'aborted':
    case 'cancelled': return 'cancelled';
    case 'max-tokens': return 'max-tokens';
    case 'blocked': return 'blocked';
    case 'interrupted': return 'interrupted';
    case 'completed': return 'completed';
    default: return 'completed';
  }
}

/**
 * Extract text length from a tool result entry for volume estimation.
 * @param {any} entry
 * @returns {number}
 */
export function toolResultChars(entry) {
  const event = entry?.event || entry;
  const data = recordValue(event?.data) ?? {};
  const message = recordValue(data.message);
  const blocks = Array.isArray(message?.content) ? message.content : [];
  let text = '';
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') text += block.text;
    const nested = Array.isArray(block.content) ? block.content : [];
    for (const inner of nested) {
      if (inner && typeof inner === 'object' && typeof inner.text === 'string') text += inner.text;
    }
  }
  if (text) return text.length;
  if (typeof data.content === 'string') return data.content.length;
  if (typeof data.result === 'string') return data.result.length;
  return 0;
}

/**
 * Session wall-clock running time from first event to last event.
 * @param {any[]} entries
 * @param {number} [now]
 * @returns {number}
 */
export function sessionElapsedMs(entries, now) {
  let first;
  let last;
  for (const item of entries) {
    const event = item?.event || item;
    const time = numberValue(event?.time);
    if (time === undefined) continue;
    if (first === undefined || time < first) first = time;
    if (last === undefined || time > last) last = time;
  }
  if (first === undefined || last === undefined) return 0;
  const end = now !== undefined && Number.isFinite(now) && now > last ? now : last;
  return Math.max(0, end - first);
}

/**
 * Format milliseconds into human duration: 42s, 3m 12s, 1h 05m.
 * @param {number | undefined} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return `${m}m ${String(remS).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${String(remM).padStart(2, '0')}m`;
}

/**
 * Format numbers with compact suffixes (12.3k, 1.2M) or comma separation.
 * @param {number | undefined} count
 * @returns {string}
 */
export function formatTokens(count) {
  if (count === undefined || !Number.isFinite(count)) return '0';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(Math.round(count));
}

/**
 * Format exact integer with commas (e.g. 12,345).
 * @param {number | undefined} count
 * @returns {string}
 */
export function formatExactTokens(count) {
  if (count === undefined || !Number.isFinite(count)) return '0';
  return Math.round(count).toLocaleString('en-US');
}

/**
 * Format tokens per second speed.
 * @param {number | undefined} tps
 * @returns {string}
 */
export function formatTokensPerSecond(tps) {
  if (tps === undefined || !Number.isFinite(tps) || tps <= 0) return '—';
  return `${Math.round(tps)} tok/s`;
}

/**
 * Format volume in characters or bytes.
 * @param {number | undefined} chars
 * @returns {string}
 */
export function formatMetricVolume(chars) {
  if (chars === undefined || !Number.isFinite(chars) || chars <= 0) return '0 chars';
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)}M chars`;
  if (chars >= 1_000) return `${(chars / 1_000).toFixed(1)}k chars`;
  return `${chars} chars`;
}

/**
 * Percentage calculation clamped between 0 and 100.
 * @param {number} value
 * @param {number} max
 * @returns {number}
 */
export function tokenUsagePercent(value, max) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, (value / max) * 100));
}

/**
 * Extract per-assistant-message token metrics from ordered history.
 * @param {any[]} entries
 * @returns {Map<number, Record<string, number>>}
 */
export function assistantMessageStats(entries) {
  const steps = new Map();
  const result = new Map();
  let fallbackIndex = 0;

  for (const item of entries) {
    const event = item?.event || item;
    const data = recordValue(event?.data) ?? {};
    const message = recordValue(data.message);
    const turn = numberValue(data.turn) ?? numberValue(message?.turn);
    const step = numberValue(data.step) ?? numberValue(message?.step);
    const keyText = turn !== undefined && step !== undefined ? `${turn}/${step}` : `fallback/${fallbackIndex}`;

    let state = steps.get(keyText);
    if (!state) {
      state = { usage: {} };
      steps.set(keyText, state);
    }

    if (event.type === 'step/start') {
      state.stepStartTime = event.time;
    }
    if (event.type === 'assistant/message') {
      const usage = recordValue(data.usage) ?? recordValue(message?.usage) ?? {};
      const inputTokens = numberValue(usage.inputTokens) ?? numberValue(usage.input_tokens) ?? 0;
      const outputTokens = numberValue(usage.outputTokens) ?? numberValue(usage.output_tokens) ?? 0;
      const reasoningTokens = numberValue(usage.reasoningTokens) ?? numberValue(usage.reasoning_tokens) ?? 0;
      const uncachedInputTokens = numberValue(usage.uncachedInputTokens) ?? numberValue(usage.uncached_input_tokens) ?? 0;
      const cacheReadTokens = numberValue(usage.cacheReadTokens) ?? numberValue(usage.cache_read_tokens) ?? 0;
      const cacheWriteTokens = numberValue(usage.cacheWriteTokens) ?? numberValue(usage.cache_write_tokens) ?? 0;

      const denominator = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
      const cacheHitRate = denominator > 0 ? (cacheReadTokens / denominator) * 100 : 0;

      const stats = {
        inputTokens,
        outputTokens,
        reasoningTokens,
        totalTokens: inputTokens + outputTokens,
        uncachedInputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        cacheHitRate,
      };

      if (state.stepStartTime !== undefined && event.time !== undefined) {
        stats.runMs = Math.max(0, event.time - state.stepStartTime);
      }
      result.set(event.seq, stats);
      fallbackIndex += 1;
    }
  }
  return result;
}

/**
 * Aggregate token usage across the session into totals and timeline points.
 * @param {any[]} entries
 * @param {Record<string, any>} [stats]
 * @returns {Record<string, any>}
 */
export function tokenUsageDashboard(entries, stats = {}) {
  const ordered = [...entries].sort((a, b) => ((a.event?.seq ?? a.seq ?? 0) - (b.event?.seq ?? b.seq ?? 0)));
  const msgStats = assistantMessageStats(ordered);
  const points = [];
  let responseIndex = 0;

  for (const item of ordered) {
    const event = item?.event || item;
    if (event.type !== 'assistant/message') continue;
    const perMsg = msgStats.get(event.seq) ?? {};
    responseIndex += 1;
    const turn = eventTurn(item);
    const step = eventStep(item);
    points.push({
      key: String(event.seq),
      label: turn !== undefined && step !== undefined ? `第 ${turn} 轮 · 步 ${step}` : `回复 ${responseIndex}`,
      time: event.time,
      turn,
      step,
      inputTokens: perMsg.inputTokens ?? 0,
      outputTokens: perMsg.outputTokens ?? 0,
      reasoningTokens: perMsg.reasoningTokens ?? 0,
      totalTokens: perMsg.totalTokens ?? 0,
      uncachedInputTokens: perMsg.uncachedInputTokens ?? 0,
      cacheReadTokens: perMsg.cacheReadTokens ?? 0,
      cacheWriteTokens: perMsg.cacheWriteTokens ?? 0,
      cacheHitRate: perMsg.cacheHitRate ?? 0,
      runMs: perMsg.runMs,
    });
  }

  // Calculate totals from points or projection stats
  const pointsSum = points.reduce((acc, p) => ({
    inputTokens: acc.inputTokens + p.inputTokens,
    outputTokens: acc.outputTokens + p.outputTokens,
    reasoningTokens: acc.reasoningTokens + p.reasoningTokens,
    uncachedInputTokens: acc.uncachedInputTokens + p.uncachedInputTokens,
    cacheReadTokens: acc.cacheReadTokens + p.cacheReadTokens,
    cacheWriteTokens: acc.cacheWriteTokens + p.cacheWriteTokens,
  }), {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });

  const inputTokens = stats.inputTokens ?? pointsSum.inputTokens;
  const outputTokens = stats.outputTokens ?? pointsSum.outputTokens;
  const reasoningTokens = stats.reasoningTokens ?? pointsSum.reasoningTokens;
  const uncachedInputTokens = stats.uncachedInputTokens ?? pointsSum.uncachedInputTokens;
  const cacheReadTokens = stats.cacheReadTokens ?? pointsSum.cacheReadTokens;
  const cacheWriteTokens = stats.cacheWriteTokens ?? pointsSum.cacheWriteTokens;
  const totalTokens = stats.totalTokens ?? (inputTokens + outputTokens);

  const denom = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
  const cacheHitRate = denom > 0 ? (cacheReadTokens / denom) * 100 : 0;

  return {
    totals: {
      inputTokens,
      outputTokens,
      reasoningTokens,
      totalTokens,
      uncachedInputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheHitRate,
    },
    points,
  };
}

/**
 * Attribute tool costs, failures, retries, repeated shell commands, and turn outcomes.
 * @param {any[]} entries
 * @returns {Record<string, any>}
 */
export function sessionCost(entries) {
  const ordered = [...entries].sort((a, b) => ((a.event?.seq ?? a.seq ?? 0) - (b.event?.seq ?? b.seq ?? 0)));
  const tools = new Map();
  const turns = new Map();
  const commands = new Map();
  const pendingCalls = new Map();

  let retries = 0;
  let retriedSteps = 0;
  const retriedStepKeys = new Set();
  let toolCalls = 0;
  let toolFailures = 0;
  let resultChars = 0;
  let fallbackTurn = 0;
  let currentTurnKey;

  const ensureTool = (name) => {
    let t = tools.get(name);
    if (!t) {
      t = { name, calls: 0, errors: 0, resultChars: 0, durationMs: 0 };
      tools.set(name, t);
    }
    return t;
  };

  const ensureTurn = (key, turnNumber, startedAt) => {
    let t = turns.get(key);
    if (!t) {
      t = {
        key,
        turn: turnNumber,
        startedAt,
        steps: 0,
        toolCalls: 0,
        toolFailures: 0,
        retries: 0,
        outcome: 'open',
      };
      turns.set(key, t);
    } else if (startedAt !== undefined && (t.startedAt === undefined || startedAt < t.startedAt)) {
      t.startedAt = startedAt;
    }
    return t;
  };

  for (const item of ordered) {
    const event = item?.event || item;
    const data = recordValue(event.data) ?? {};
    const time = numberValue(event.time);
    const turnNumber = eventTurn(item);
    const stepNumber = eventStep(item);
    const key = currentTurnKey ?? (turnNumber !== undefined ? `turn:${turnNumber}` : `fallback:${fallbackTurn}`);

    if (event.type === 'turn/start') {
      fallbackTurn += 1;
      currentTurnKey = turnNumber !== undefined ? `turn:${turnNumber}` : `fallback:${fallbackTurn}`;
      ensureTurn(currentTurnKey, turnNumber, time);
      continue;
    }

    if (event.type === 'tool/call') {
      toolCalls += 1;
      const name = eventToolName(event);
      const tool = ensureTool(name);
      tool.calls += 1;
      const callId = eventToolCallId(event);
      const args = parseToolArgs(data.arguments);
      const cmd = commandOfToolCall(name, args);
      if (cmd) {
        commands.set(cmd, { command: cmd, calls: (commands.get(cmd)?.calls ?? 0) + 1 });
      }
      if (callId) {
        pendingCalls.set(callId, { name, startedAt: time });
      }
      const turn = ensureTurn(key, turnNumber, time);
      turn.toolCalls += 1;
      continue;
    }

    if (event.type === 'step/start') {
      ensureTurn(key, turnNumber, time).steps += 1;
      continue;
    }

    if (event.type === 'tool/result') {
      const callId = eventToolCallId(event);
      const paired = callId ? pendingCalls.get(callId) : undefined;
      const name = paired?.name ?? eventToolName(event);
      const tool = ensureTool(name);
      const chars = toolResultChars(item);
      tool.resultChars += chars;
      resultChars += chars;

      if (paired?.startedAt !== undefined && time !== undefined && time >= paired.startedAt) {
        tool.durationMs += (time - paired.startedAt);
      }
      if (callId) pendingCalls.delete(callId);

      if (eventToolResultError(event)) {
        tool.errors += 1;
        toolFailures += 1;
        ensureTurn(key, turnNumber, time).toolFailures += 1;
      }
      continue;
    }

    if (event.type === 'llm/retry-started' || event.type === 'llm/retry') {
      retries += 1;
      ensureTurn(key, turnNumber, time).retries += 1;
      if (turnNumber !== undefined && stepNumber !== undefined) {
        const coord = `${turnNumber}/${stepNumber}`;
        if (!retriedStepKeys.has(coord)) {
          retriedStepKeys.add(coord);
          retriedSteps += 1;
        }
      }
      continue;
    }

    if (event.type === 'turn/end') {
      const outcome = turnOutcome(data.reason);
      const turn = ensureTurn(key, turnNumber, time);
      turn.outcome = outcome;
      if (time !== undefined) turn.endedAt = time;
      currentTurnKey = undefined;
      continue;
    }
  }

  const toolRows = [...tools.values()]
    .map((t) => ({
      name: t.name,
      calls: t.calls,
      errors: t.errors,
      errorRate: t.calls > 0 ? (t.errors / t.calls) * 100 : 0,
      resultChars: t.resultChars,
      durationMs: t.durationMs,
    }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  const turnRows = [...turns.values()]
    .map((t) => ({
      key: t.key,
      turn: t.turn,
      steps: t.steps,
      toolCalls: t.toolCalls,
      toolFailures: t.toolFailures,
      retries: t.retries,
      outcome: t.outcome,
      durationMs: t.startedAt !== undefined && t.endedAt !== undefined && t.endedAt >= t.startedAt
        ? t.endedAt - t.startedAt
        : undefined,
    }))
    .sort((a, b) => (a.turn ?? 9999) - (b.turn ?? 9999));

  const repeatedCommands = [...commands.values()]
    .filter((c) => c.calls > 1)
    .sort((a, b) => b.calls - a.calls || a.command.localeCompare(b.command));
  const repeatedCommandCalls = repeatedCommands.reduce((sum, c) => sum + c.calls, 0);
  const failedTurns = turnRows.filter((t) => t.outcome === 'error');

  return {
    tools: toolRows,
    turns: turnRows,
    toolCalls,
    toolFailures,
    toolErrorRate: toolCalls > 0 ? (toolFailures / toolCalls) * 100 : 0,
    retries,
    retriedSteps,
    resultChars,
    wastedTurns: failedTurns.length,
    wastedSteps: failedTurns.reduce((sum, t) => sum + t.steps, 0),
    wastedToolCalls: failedTurns.reduce((sum, t) => sum + t.toolCalls, 0),
    distinctCommands: commands.size,
    repeatedCommands,
    repeatedCommandCalls,
    repeatedCommandRate: repeatedCommandCalls > 0
      ? ((repeatedCommandCalls - repeatedCommands.length) / repeatedCommandCalls) * 100
      : 0,
  };
}

/**
 * Map model name or config to standard context window size in tokens.
 * @param {string | undefined} modelName
 * @param {number | undefined} [customWindow]
 * @returns {number}
 */
export function resolveModelWindowTokens(modelName, customWindow) {
  if (customWindow !== undefined && Number.isFinite(customWindow) && customWindow > 0) {
    return Math.round(customWindow);
  }
  const norm = String(modelName || '').toLowerCase().trim();
  if (norm.includes('claude-3') || norm.includes('claude-3-5') || norm.includes('claude-3.5') || norm.includes('claude-sonnet') || norm.includes('claude-opus')) {
    return 200_000;
  }
  if (norm.includes('gemini')) {
    return 1_000_000;
  }
  if (norm.includes('gpt-4o') || norm.includes('o1') || norm.includes('o3') || norm.includes('gpt-4-turbo')) {
    return 128_000;
  }
  if (norm.includes('deepseek') || norm.includes('qwen') || norm.includes('glm') || norm.includes('yi')) {
    return 131_072;
  }
  return 131_072;
}

/**
 * Deep context window insight, composition breakdown, lifecycle events, and synergy metrics.
 * @param {any[]} entries
 * @param {Record<string, any>} [stats]
 * @param {{ header?: any; projections?: any; now?: number }} [options]
 * @returns {Record<string, any>}
 */
export function sessionContextInsight(entries, stats = {}, options = {}) {
  const ordered = [...entries].sort((a, b) => ((a.event?.seq ?? a.seq ?? 0) - (b.event?.seq ?? b.seq ?? 0)));
  const header = options.header || {};
  let detectedModel = options.model
    || header.modelConfig?.model
    || header.model
    || header.agentConfig?.model
    || stats.model
    || stats.modelId
    || options.projections?.values?.modelSelection?.lastUsed?.model
    || options.projections?.values?.modelSelection?.next?.model;

  for (const item of ordered) {
    const event = item?.event || item;
    if (event.type === 'request/header') {
      const m = event.data?.header?.config?.model;
      if (m) detectedModel = m;
    }
    if (event.type === 'model/selection') {
      const m = event.data?.model;
      if (m) detectedModel = m;
    }
    if (event.type === 'assistant/message') {
      const data = recordValue(event.data) ?? {};
      const m = data.model || data.usage?.model;
      if (m) detectedModel = m;
    }
  }

  const modelName = detectedModel || '当前模型';
  const maxWindowTokens = resolveModelWindowTokens(modelName, stats.contextWindow ?? stats.maxTokens);

  let latestInputTokens = 0;
  let userChars = 0;
  let assistantChars = 0;
  let toolResultCharsSum = 0;
  let injectedChars = 0;
  let skillChars = 0;
  let promptInjectionCount = 0;
  let skillCount = 0;
  const distinctTools = new Set();
  const mcpTools = new Set();
  const events = [];
  const historyTrend = [];

  let previousInputTokens = 0;

  for (const item of ordered) {
    const event = item?.event || item;
    const data = recordValue(event.data) ?? {};
    const message = recordValue(data.message);
    const turn = eventTurn(item);
    const step = eventStep(item);
    const time = numberValue(event.time);

    // Track tools
    if (event.type === 'tool/call') {
      const toolName = eventToolName(event);
      distinctTools.add(toolName);
      if (toolName.startsWith('mcp_') || toolName.startsWith('mcp:') || toolName.includes('__mcp')) {
        mcpTools.add(toolName);
      }
    }

    // Track tool results & pruning
    if (event.type === 'tool/result') {
      const chars = toolResultChars(item);
      toolResultCharsSum += chars;
      const toolName = eventToolName(event);
      const isTruncated = data.truncated === true
        || (typeof data.content === 'string' && data.content.includes('[truncated]'))
        || (typeof message?.content === 'string' && message.content.includes('[truncated]'))
        || chars > 16000;
      if (isTruncated) {
        events.push({
          seq: event.seq,
          turn,
          step,
          time,
          kind: 'prune',
          title: `工具 [${toolName}] 输出剪枝`,
          badge: '✂ 剪枝',
          deltaTokens: -Math.round((chars * 0.4) / 3.5),
          details: `截断超长返回 (${formatMetricVolume(chars)})，避免冲垮上下文`,
        });
      }
    }

    // Track user / injected messages
    if (event.type === 'user/message') {
      const content = typeof message?.content === 'string'
        ? message.content
        : Array.isArray(message?.content)
          ? message.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
          : typeof data.content === 'string' ? data.content : '';
      const chars = content.length;

      if (isInjectedMessage(event)) {
        const source = recordValue(data.source) ?? recordValue(message?.source);
        const sourceKind = typeof source?.kind === 'string' ? source.kind.toLowerCase() : '';
        const isSkill = sourceKind === 'skill' || content.includes('<skill_content>') || content.includes('skills/');

        if (isSkill) {
          skillChars += chars;
          skillCount += 1;
          events.push({
            seq: event.seq,
            turn,
            step,
            time,
            kind: 'inject',
            title: '技能定义注入 (Skill)',
            badge: '💉 技能',
            deltaTokens: Math.max(1, Math.round(chars / 3.5)),
            details: `加载外部技能规范 (~${formatTokens(Math.round(chars / 3.5))} Tokens)`,
          });
        } else {
          injectedChars += chars;
          promptInjectionCount += 1;
          events.push({
            seq: event.seq,
            turn,
            step,
            time,
            kind: 'inject',
            title: '额外提示词规则注入',
            badge: '💉 注入',
            deltaTokens: Math.max(1, Math.round(chars / 3.5)),
            details: `注入提示词/环境上下文 (~${formatTokens(Math.round(chars / 3.5))} Tokens)`,
          });
        }
      } else {
        userChars += chars;
      }
    }

    // Track compaction explicit events
    if (event.type === 'context/compact' || event.type === 'session/compact' || event.type === 'compact') {
      const before = numberValue(data.beforeTokens) ?? previousInputTokens;
      const after = numberValue(data.afterTokens) ?? 0;
      const reclaimed = Math.max(0, before - after);
      events.push({
        seq: event.seq,
        turn,
        step,
        time,
        kind: 'compact',
        title: `第 ${turn ?? '?'} 轮 上下文自动压缩`,
        badge: '✂ 压缩',
        deltaTokens: -reclaimed,
        details: reclaimed > 0 ? `释放了 ${formatTokens(reclaimed)} Tokens` : '历史消息浓缩为记忆摘要',
      });
    }

    // Track assistant message & inputTokens evolution
    if (event.type === 'assistant/message') {
      const usage = recordValue(data.usage) ?? recordValue(message?.usage) ?? {};
      const inputTokens = numberValue(usage.inputTokens) ?? numberValue(usage.input_tokens) ?? 0;
      const outputTokens = numberValue(usage.outputTokens) ?? numberValue(usage.output_tokens) ?? 0;
      const reasoningTokens = numberValue(usage.reasoningTokens) ?? numberValue(usage.reasoning_tokens) ?? 0;
      const cacheReadTokens = numberValue(usage.cacheReadTokens) ?? numberValue(usage.cache_read_tokens) ?? 0;
      const uncachedInputTokens = numberValue(usage.uncachedInputTokens) ?? numberValue(usage.uncached_input_tokens) ?? 0;
      const cacheWriteTokens = numberValue(usage.cacheWriteTokens) ?? numberValue(usage.cache_write_tokens) ?? 0;
      const denom = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
      const cacheHitRate = denom > 0 ? (cacheReadTokens / denom) * 100 : 0;

      const content = typeof message?.content === 'string'
        ? message.content
        : Array.isArray(message?.content)
          ? message.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
          : '';
      assistantChars += content.length;

      // Detect heuristic compaction between assistant messages
      const stepMarkers = [];
      if (previousInputTokens >= 4000 && inputTokens < previousInputTokens && (previousInputTokens - inputTokens) >= 1500) {
        const reclaimed = previousInputTokens - inputTokens;
        const ratio = Math.round((reclaimed / previousInputTokens) * 100);
        stepMarkers.push('compact');
        events.push({
          seq: event.seq,
          turn,
          step,
          time,
          kind: 'compact',
          title: `第 ${turn ?? '?'} 轮 上下文自动压缩`,
          badge: '✂ 压缩',
          deltaTokens: -reclaimed,
          details: `触发上下文压缩，释放了 ${formatTokens(reclaimed)} Tokens (-${ratio}%)`,
        });
      }

      if (inputTokens > 0) {
        latestInputTokens = inputTokens;
      }

      const delta = previousInputTokens > 0 ? inputTokens - previousInputTokens : inputTokens;
      historyTrend.push({
        turn,
        step,
        time,
        contextTokens: inputTokens,
        outputTokens,
        reasoningTokens,
        deltaTokens: delta,
        cacheHitRate,
        markers: stepMarkers,
      });

      previousInputTokens = inputTokens;
    }
  }

  // Calculate current context tokens
  const estimatedInitial = Math.round((userChars + injectedChars + skillChars) / 3.5) + (distinctTools.size * 180) + 1800;
  const currentContextTokens = latestInputTokens > 0
    ? latestInputTokens
    : (ordered.length > 0 ? Math.min(maxWindowTokens, estimatedInitial) : 0);

  const usagePercent = tokenUsagePercent(currentContextTokens, maxWindowTokens);
  const remainingTokens = Math.max(0, maxWindowTokens - currentContextTokens);
  const safetyStatus = usagePercent >= 85 ? 'critical' : usagePercent >= 70 ? 'warning' : 'safe';

  // Calculate context composition slices
  const compEvents = events.filter((e) => e.kind === 'compact');
  const hasCompaction = compEvents.length > 0;

  // 1. Tool schemas
  const mcpToolCount = mcpTools.size;
  const nativeToolCount = Math.max(0, distinctTools.size - mcpToolCount);
  const toolSchemaTokens = currentContextTokens > 0 ? (nativeToolCount * 180 + mcpToolCount * 260) : 0;

  // 2. Injected tokens
  const injectedTokens = Math.round(injectedChars / 3.5);
  const skillTokens = Math.round(skillChars / 3.5);

  // 3. System base prompt
  const systemTokens = currentContextTokens > 0 ? Math.min(2200, Math.max(800, Math.round(currentContextTokens * 0.08))) : 0;

  // 4. Compacted summary
  const compactedTokens = hasCompaction ? Math.min(3000, Math.max(800, Math.round(currentContextTokens * 0.15))) : 0;

  // 5. Dialogue & Tool results
  const allocatedBase = systemTokens + toolSchemaTokens + injectedTokens + skillTokens + compactedTokens;
  const remainingForDialogue = Math.max(0, currentContextTokens - allocatedBase);

  const estUserTokens = Math.round(userChars / 3.5);
  const estAssistantTokens = Math.round(assistantChars / 3.5);
  const estToolResultTokens = Math.round(toolResultCharsSum / 3.5);
  const estDynamicSum = Math.max(1, estUserTokens + estAssistantTokens + estToolResultTokens);

  const dialogueTokens = currentContextTokens > 0
    ? Math.round(remainingForDialogue * ((estUserTokens + estAssistantTokens) / estDynamicSum))
    : 0;
  const toolResultTokens = currentContextTokens > 0
    ? Math.max(0, remainingForDialogue - dialogueTokens)
    : 0;

  const rawSlices = [
    {
      key: 'system',
      label: '系统预设指令',
      tokens: systemTokens,
      color: 'var(--dsw-alias-brand-primary, rgb(99, 102, 241))',
      desc: '宿主环境与工作区基础引导规范 (System Prompt)',
    },
    {
      key: 'toolSchema',
      label: '工具与MCP定义',
      tokens: toolSchemaTokens,
      color: 'var(--dsw-alias-state-info-primary, rgb(14, 165, 233))',
      desc: `${distinctTools.size} 个工具的参数 JSON Schema 定义与接口描述${mcpToolCount > 0 ? ` (含 ${mcpToolCount} 个 MCP 外部工具)` : ''}`,
    },
    {
      key: 'injected',
      label: '额外提示词注入',
      tokens: injectedTokens,
      color: 'var(--dsw-alias-state-purple-label, rgb(168, 85, 247))',
      desc: '来自 dsh-extra-prompt 动态注入的全局规则与上下文快照',
    },
    {
      key: 'skills',
      label: '已加载技能 (Skills)',
      tokens: skillTokens,
      color: 'var(--dsw-alias-state-teal-label, rgb(20, 184, 166))',
      desc: '工作区或用户目录按需激活的专项技能内容与操作指南',
    },
    {
      key: 'compacted',
      label: '压缩记忆摘要',
      tokens: compactedTokens,
      color: 'var(--dsw-alias-state-amber-label, rgb(217, 119, 6))',
      desc: '历史轮次触发自动压缩后浓缩而成的会话记忆',
    },
    {
      key: 'dialogue',
      label: '对话交互历史',
      tokens: dialogueTokens,
      color: 'var(--dsw-alias-state-warn-label, rgb(249, 115, 22))',
      desc: '多轮人机交互提问与回答历史',
    },
    {
      key: 'toolResults',
      label: '工具执行输出载荷',
      tokens: toolResultTokens,
      color: 'var(--dsw-alias-state-pink-label, rgb(236, 72, 153))',
      desc: '终端执行、文件读取、正则搜索等产生的数据流',
    },
  ];

  const totalSlicesTokens = Math.max(1, rawSlices.reduce((sum, s) => sum + s.tokens, 0));
  const slices = rawSlices
    .filter((s) => s.tokens > 0)
    .map((s) => ({
      ...s,
      percent: Math.round((s.tokens / totalSlicesTokens) * 100),
    }));

  // Synergy metrics: RTK saves ~60% of output volume on shell commands
  const rtkSavingsTokens = Math.round((toolResultCharsSum * 0.45) / 3.5);

  return {
    capacity: {
      model: modelName,
      maxWindowTokens,
      currentContextTokens,
      usagePercent,
      remainingTokens,
      safetyStatus,
    },
    composition: {
      slices,
      totalEstimate: currentContextTokens,
      systemTokens,
      toolSchemaTokens,
      injectedTokens,
      skillTokens,
      compactedTokens,
      dialogueTokens,
      toolResultTokens,
    },
    events: events.sort((a, b) => (b.time ?? 0) - (a.time ?? 0)),
    synergy: {
      rtkSavingsTokens,
      mcpToolsCount: mcpTools.size,
      mcpSchemaTokens: mcpTools.size * 260,
      promptInjectionsCount: promptInjectionCount,
      promptInjectionTokens: injectedTokens,
      skillsLoadedCount: skillCount,
    },
    historyTrend,
  };
}

/**
 * Top-level dashboard aggregation function.
 * @param {any[]} entries
 * @param {Record<string, any>} [stats]
 * @param {string} [locale]
 * @param {{ elapsedMs?: number; now?: number; running?: boolean }} [options]
 * @returns {Record<string, any>}
 */
export function sessionDashboard(entries, stats = {}, locale = 'zh', options = {}) {
  const ordered = [...entries].sort((a, b) => ((a.event?.seq ?? a.seq ?? 0) - (b.event?.seq ?? b.seq ?? 0)));
  const token = tokenUsageDashboard(ordered, stats);
  const turns = new Map();
  const turnKeyByAssistantSeq = new Map();
  let currentTurnKey;
  let fallbackTurn = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let toolFailures = 0;
  let loadedSteps = 0;
  let firstEventTime;
  let lastEventTime;

  const ensureTurn = (entry, explicitTurn) => {
    const event = entry?.event || entry;
    const time = numberValue(event?.time) ?? 0;
    if (explicitTurn !== undefined) currentTurnKey = `turn:${explicitTurn}`;
    if (!currentTurnKey) {
      fallbackTurn += 1;
      currentTurnKey = `fallback:${fallbackTurn}`;
    }
    let existing = turns.get(currentTurnKey);
    if (existing) {
      existing.time = Math.min(existing.time, time);
      existing.lastEventAt = Math.max(existing.lastEventAt, time);
      return existing;
    }
    const index = explicitTurn ?? turns.size + 1;
    existing = {
      key: currentTurnKey,
      label: `第 ${index} 轮`,
      time,
      turn: explicitTurn,
      userMessages: 0,
      assistantMessages: 0,
      steps: 0,
      toolCalls: 0,
      toolFailures: 0,
      totalTokens: 0,
      signals: [],
      lastEventAt: time,
    };
    turns.set(currentTurnKey, existing);
    return existing;
  };

  for (const item of ordered) {
    const event = item?.event || item;
    const time = numberValue(event.time);
    if (time !== undefined) {
      firstEventTime = firstEventTime === undefined ? time : Math.min(firstEventTime, time);
      lastEventTime = lastEventTime === undefined ? time : Math.max(lastEventTime, time);
    }
    const turnNumber = eventTurn(item);

    if (event.type === 'turn/start') {
      if (turnNumber === undefined) {
        fallbackTurn += 1;
        currentTurnKey = `fallback:${fallbackTurn}`;
      } else {
        currentTurnKey = `turn:${turnNumber}`;
      }
      const turn = ensureTurn(item, turnNumber);
      turn.startedAt = time;
      continue;
    }

    const relevant = event.type === 'user/message'
      || event.type === 'assistant/message'
      || event.type === 'step/end'
      || event.type === 'tool/call'
      || event.type === 'tool/result'
      || event.type === 'turn/end';
    if (!relevant) continue;

    const turn = ensureTurn(item, turnNumber);

    if (event.type === 'user/message' && !isInjectedMessage(event)) {
      userMessages += 1;
      turn.userMessages += 1;
      turn.signals.push('user');
    } else if (event.type === 'assistant/message') {
      assistantMessages += 1;
      turn.assistantMessages += 1;
      turnKeyByAssistantSeq.set(String(event.seq), turn.key);
      turn.signals.push('assistant');
    } else if (event.type === 'step/end') {
      loadedSteps += 1;
      turn.steps += 1;
    } else if (event.type === 'tool/call') {
      toolCalls += 1;
      turn.toolCalls += 1;
      turn.signals.push('tool');
    } else if (event.type === 'tool/result') {
      toolResults += 1;
      if (eventToolResultError(event)) {
        toolFailures += 1;
        turn.toolFailures += 1;
        turn.signals.push('error');
      }
    } else if (event.type === 'turn/end') {
      turn.endedAt = time;
      currentTurnKey = undefined;
    }
  }

  for (const point of token.points) {
    const turnKey = turnKeyByAssistantSeq.get(point.key);
    if (turnKey && turns.has(turnKey)) {
      turns.get(turnKey).totalTokens += point.totalTokens;
    }
  }

  const now = options.running && options.now !== undefined && Number.isFinite(options.now) ? options.now : undefined;
  const turnPoints = [...turns.values()].map((turn) => {
    const end = turn.endedAt ?? (turn.key === currentTurnKey ? now : undefined) ?? turn.lastEventAt;
    const durationMs = turn.startedAt !== undefined && end >= turn.startedAt ? end - turn.startedAt : undefined;
    const { startedAt: _s, endedAt: _e, lastEventAt: _l, ...rest } = turn;
    return { ...rest, durationMs };
  });

  const cost = sessionCost(ordered);
  const context = sessionContextInsight(ordered, stats, options);

  return {
    summary: {
      eventCount: ordered.length,
      userMessages,
      assistantMessages,
      messages: userMessages + assistantMessages,
      turns: Math.max(stats.turns ?? 0, turnPoints.length),
      steps: Math.max(stats.steps ?? 0, loadedSteps),
      toolCalls,
      toolResults,
      toolFailures,
      firstEventTime,
      lastEventTime,
      elapsedMs: options.elapsedMs ?? sessionElapsedMs(ordered, now),
    },
    turns: turnPoints,
    token,
    cost,
    context,
  };
}

/**
 * Host helper: query list of sessions and read dashboard data.
 * @param {any} ctx - Cordis context
 * @param {string} [requestedSessionId]
 * @returns {Promise<{ session: any; summary: any; turns: any[]; token: any; cost: any; stats: any }>}
 */
export async function readSessionDashboardFromHost(ctx, requestedSessionId) {
  let sessionId = requestedSessionId;
  let attachedSession;

  // 1. Try finding attached session or default active session
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
  if (!sessionId && sessions && typeof sessions.values === 'function') {
    const active = [...sessions.values()][0];
    if (active) {
      sessionId = active.id;
      attachedSession = active;
    }
  }

  // 2. Query sessionQuery if available
  const sessionQuery = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined;
  if (!sessionId && sessionQuery && typeof sessionQuery.listSessions === 'function') {
    try {
      const records = await sessionQuery.listSessions();
      if (Array.isArray(records) && records.length > 0) {
        sessionId = records[0].header?.id || records[0].id;
      }
    } catch {
      // ignore
    }
  }

  if (!sessionId) {
    throw new Error('没有可用的会话');
  }

  let events = [];
  let header = attachedSession?.header ?? { id: sessionId, title: 'Session ' + sessionId.slice(0, 8) };
  let projections = {};

  if (sessionQuery && typeof sessionQuery.observeSession === 'function') {
    try {
      const observation = await sessionQuery.observeSession(sessionId, { projectionMode: 'all' });
      if (observation) {
        events = Array.isArray(observation.events) ? [...observation.events] : [];
        if (observation.header) header = observation.header;
        if (observation.projections) projections = observation.projections;
        if (typeof observation[Symbol.dispose] === 'function') {
          observation[Symbol.dispose]();
        }
      }
    } catch {
      // fallback
    }
  }

  if (events.length === 0 && sessions && typeof sessions.get === 'function') {
    const live = sessions.get(sessionId);
    if (live) {
      header = live.header ?? header;
      if (typeof live.snapshotEvents === 'function') {
        events = live.snapshotEvents();
      }
    }
  }

  const sessionStats = projections?.values?.sessionStats ?? {};
  const tokenUsage = projections?.values?.tokenUsage ?? {};
  const mergedStats = { ...sessionStats, ...tokenUsage };

  const projModel = projections?.values?.modelSelection?.lastUsed?.model
    || projections?.values?.modelSelection?.next?.model;
  const sessionModel = projModel
    || header.model
    || header.modelConfig?.model
    || mergedStats.model
    || mergedStats.modelId
    || undefined;

  const data = sessionDashboard(events, mergedStats, 'zh', {
    header,
    projections,
    model: sessionModel,
  });

  const projectedTitle = projections?.values?.title;
  let sessionTitle = (typeof projectedTitle === 'string' && projectedTitle.trim() !== '') ? projectedTitle.trim() : null;
  if (!sessionTitle && header.title && !header.title.startsWith('Session ') && !header.title.startsWith('会话 ') && !header.title.startsWith('session-')) {
    sessionTitle = header.title.trim();
  }
  if (!sessionTitle && events.length > 0) {
    const firstUserMsg = events.find((e) => e.kind === 'message' && e.message?.role === 'user');
    if (firstUserMsg && typeof firstUserMsg.message?.content === 'string') {
      const line = firstUserMsg.message.content.trim().split('\n')[0].trim();
      if (line) sessionTitle = line.slice(0, 40);
    }
  }
  if (!sessionTitle) {
    const shortId = String(sessionId).replace(/^session-/, '').slice(0, 8);
    sessionTitle = shortId ? ('会话 ' + shortId) : '未命名会话';
  }

  return {
    session: {
      id: sessionId,
      title: sessionTitle,
      model: sessionModel || data.context?.capacity?.model,
      cwd: header.cwd || '',
      createdAt: header.createdAt || header.time,
      updatedAt: header.updatedAt || data.summary.lastEventTime,
    },
    summary: data.summary,
    turns: data.turns,
    token: data.token,
    cost: data.cost,
    stats: mergedStats,
    context: data.context,
  };
}

/**
 * Host helper: list available sessions.
 * @param {any} ctx
 * @returns {Promise<Array<{ id: string; title: string; updatedAt?: number; cwd?: string }>>}
 */
export async function listSessionsFromHost(ctx) {
  const result = [];
  const seen = new Set();

  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
  const sessionQuery = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined;

  if (sessions && typeof sessions.values === 'function') {
    for (const session of sessions.values()) {
      if (!session?.id || seen.has(session.id)) continue;
      seen.add(session.id);
      const title = session.displayTitle || session.title || session.header?.title;
      result.push({
        id: session.id,
        title: title || ('会话 ' + session.id.replace(/^session-/, '').slice(0, 8)),
        cwd: session.header?.cwd || '',
        updatedAt: session.header?.updatedAt || session.header?.time,
      });
    }
  }

  if (sessionQuery && typeof sessionQuery.listSessions === 'function') {
    try {
      const records = await sessionQuery.listSessions();
      if (Array.isArray(records)) {
        for (const rec of records) {
          const id = rec.header?.id || rec.id;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const title = rec.displayTitle || rec.title || rec.header?.title || rec.metadata?.title;
          result.push({
            id,
            title: title || ('会话 ' + String(id).replace(/^session-/, '').slice(0, 8)),
            cwd: rec.header?.cwd || rec.cwd || '',
            updatedAt: rec.header?.updatedAt || rec.header?.time || rec.updatedAt,
          });
        }
      }
    } catch {
      // ignore
    }
  }

  if (sessionQuery && typeof sessionQuery.observeSession === 'function') {
    const candidates = result.slice(0, 30).filter((s) => s.title.startsWith('会话 ') && s.title.length <= 15);
    await Promise.all(candidates.map(async (item) => {
      try {
        const obs = await sessionQuery.observeSession(item.id, { projectionMode: 'all' });
        if (obs) {
          const t = obs.projections?.values?.title;
          if (typeof t === 'string' && t.trim() !== '') {
            item.title = t.trim();
          } else if (Array.isArray(obs.events) && obs.events.length > 0) {
            const firstUser = obs.events.find((e) => e.kind === 'message' && e.message?.role === 'user');
            if (firstUser && typeof firstUser.message?.content === 'string') {
              const line = firstUser.message.content.trim().split('\n')[0].trim();
              if (line) item.title = line.slice(0, 40);
            }
          }
          if (typeof obs[Symbol.dispose] === 'function') {
            obs[Symbol.dispose]();
          }
        }
      } catch {
        // keep fallback
      }
    }));
  }

  return result;
}

