// Unit tests for the Session Statistics Dashboard model and projections.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionDashboard,
  sessionCost,
  tokenUsageDashboard,
  formatTokens,
  formatExactTokens,
  formatDuration,
  formatTokensPerSecond,
  formatMetricVolume,
  tokenUsagePercent,
  turnOutcome,
  commandOfToolCall,
  eventToolResultError,
  readSessionDashboardFromHost,
  listSessionsFromHost,
  resolveModelWindowTokens,
  sessionContextInsight,
} from '../src/session-dashboard/model.mjs';

test('sessionDashboard: handles empty entries gracefully', () => {
  const result = sessionDashboard([]);
  assert.equal(result.summary.eventCount, 0);
  assert.equal(result.summary.messages, 0);
  assert.equal(result.summary.turns, 0);
  assert.equal(result.summary.steps, 0);
  assert.equal(result.summary.toolCalls, 0);
  assert.equal(result.summary.toolFailures, 0);
  assert.equal(result.turns.length, 0);
  assert.equal(result.token.totals.totalTokens, 0);
  assert.equal(result.cost.toolCalls, 0);
});

test('sessionDashboard: aggregates turns, messages, tools, and token metrics', () => {
  const entries = [
    { event: { seq: 1, time: 1000, type: 'turn/start', data: { turn: 1 } } },
    { event: { seq: 2, time: 1050, type: 'user/message', data: { turn: 1, source: { kind: 'user' }, message: { content: 'hello' } } } },
    { event: { seq: 3, time: 1100, type: 'step/start', data: { turn: 1, step: 1 } } },
    {
      event: {
        seq: 4,
        time: 1500,
        type: 'tool/call',
        data: {
          turn: 1,
          step: 1,
          callId: 'call-1',
          name: 'pwsh',
          arguments: { command: 'git status' },
        },
      },
    },
    {
      event: {
        seq: 5,
        time: 1800,
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          callId: 'call-1',
          name: 'pwsh',
          content: 'On branch main\nnothing to commit',
        },
      },
    },
    { event: { seq: 6, time: 1900, type: 'step/end', data: { turn: 1, step: 1 } } },
    {
      event: {
        seq: 7,
        time: 2000,
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          usage: {
            inputTokens: 1200,
            outputTokens: 300,
            reasoningTokens: 150,
            uncachedInputTokens: 400,
            cacheReadTokens: 800,
            cacheWriteTokens: 0,
          },
        },
      },
    },
    { event: { seq: 8, time: 2100, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
    // Turn 2: with an error and repeated command
    { event: { seq: 9, time: 3000, type: 'turn/start', data: { turn: 2 } } },
    { event: { seq: 10, time: 3020, type: 'user/message', data: { turn: 2, source: { kind: 'user' }, message: { content: 'run again' } } } },
    { event: { seq: 11, time: 3050, type: 'step/start', data: { turn: 2, step: 1 } } },
    {
      event: {
        seq: 12,
        time: 3100,
        type: 'tool/call',
        data: {
          turn: 2,
          step: 1,
          callId: 'call-2',
          name: 'pwsh',
          arguments: JSON.stringify({ command: 'git status' }),
        },
      },
    },
    {
      event: {
        seq: 13,
        time: 3300,
        type: 'tool/result',
        data: {
          turn: 2,
          step: 1,
          callId: 'call-2',
          name: 'pwsh',
          isError: true,
          content: 'fatal: error',
        },
      },
    },
    { event: { seq: 14, time: 3400, type: 'llm/retry', data: { turn: 2, step: 1 } } },
    {
      event: {
        seq: 15,
        time: 3600,
        type: 'assistant/message',
        data: {
          turn: 2,
          step: 1,
          usage: {
            inputTokens: 800,
            outputTokens: 100,
            reasoningTokens: 50,
            uncachedInputTokens: 200,
            cacheReadTokens: 600,
            cacheWriteTokens: 0,
          },
        },
      },
    },
    { event: { seq: 16, time: 3700, type: 'turn/end', data: { turn: 2, reason: { kind: 'error' } } } },
  ];

  const dashboard = sessionDashboard(entries);

  // Summary checks
  assert.equal(dashboard.summary.eventCount, 16);
  assert.equal(dashboard.summary.userMessages, 2);
  assert.equal(dashboard.summary.assistantMessages, 2);
  assert.equal(dashboard.summary.messages, 4);
  assert.equal(dashboard.summary.turns, 2);
  assert.equal(dashboard.summary.toolCalls, 2);
  assert.equal(dashboard.summary.toolFailures, 1);
  assert.equal(dashboard.summary.firstEventTime, 1000);
  assert.equal(dashboard.summary.lastEventTime, 3700);
  assert.equal(dashboard.summary.elapsedMs, 2700);

  // Turns checks
  assert.equal(dashboard.turns.length, 2);
  const turn1 = dashboard.turns[0];
  assert.equal(turn1.turn, 1);
  assert.equal(turn1.toolCalls, 1);
  assert.equal(turn1.toolFailures, 0);
  assert.deepEqual(turn1.signals, ['user', 'tool', 'assistant']);
  assert.equal(turn1.totalTokens, 1500);

  const turn2 = dashboard.turns[1];
  assert.equal(turn2.turn, 2);
  assert.equal(turn2.toolFailures, 1);
  assert.deepEqual(turn2.signals, ['user', 'tool', 'error', 'assistant']);

  // Token checks
  assert.equal(dashboard.token.totals.inputTokens, 2000);
  assert.equal(dashboard.token.totals.outputTokens, 400);
  assert.equal(dashboard.token.totals.reasoningTokens, 200);
  assert.equal(dashboard.token.totals.totalTokens, 2400);
  assert.equal(dashboard.token.totals.cacheReadTokens, 1400);
  assert.equal(dashboard.token.totals.uncachedInputTokens, 600);
  // Cache hit rate: 1400 / (600 + 1400 + 0) = 70%
  assert.equal(Math.round(dashboard.token.totals.cacheHitRate), 70);
  assert.equal(dashboard.token.points.length, 2);

  // Cost & rework checks
  assert.equal(dashboard.cost.toolCalls, 2);
  assert.equal(dashboard.cost.toolFailures, 1);
  assert.equal(dashboard.cost.toolErrorRate, 50);
  assert.equal(dashboard.cost.retries, 1);
  assert.equal(dashboard.cost.retriedSteps, 1);
  assert.equal(dashboard.cost.wastedTurns, 1); // Turn 2 had outcome: 'error'
  assert.equal(dashboard.cost.distinctCommands, 1); // 'git status'
  assert.equal(dashboard.cost.repeatedCommands.length, 1);
  assert.equal(dashboard.cost.repeatedCommands[0].command, 'git status');
  assert.equal(dashboard.cost.repeatedCommands[0].calls, 2);

  // Tool cost table checks
  assert.equal(dashboard.cost.tools.length, 1);
  assert.equal(dashboard.cost.tools[0].name, 'pwsh');
  assert.equal(dashboard.cost.tools[0].calls, 2);
  assert.equal(dashboard.cost.tools[0].errors, 1);
  assert.equal(dashboard.cost.tools[0].durationMs, 500); // 300ms + 200ms
});

test('sessionCost: isolates outcomes, waste, and repeated shell commands', () => {
  const entries = [
    { event: { seq: 1, time: 100, type: 'turn/start', data: { turn: 1 } } },
    { event: { seq: 2, time: 110, type: 'tool/call', data: { name: 'bash', arguments: { command: 'pnpm test' } } } },
    { event: { seq: 3, time: 200, type: 'tool/result', data: { name: 'bash', content: 'test passed' } } },
    { event: { seq: 4, time: 250, type: 'tool/call', data: { name: 'bash', arguments: { command: 'pnpm test' } } } },
    { event: { seq: 5, time: 350, type: 'tool/result', data: { name: 'bash', content: 'test passed again' } } },
    { event: { seq: 6, time: 400, type: 'turn/end', data: { reason: { kind: 'completed' } } } },
  ];
  const cost = sessionCost(entries);
  assert.equal(cost.toolCalls, 2);
  assert.equal(cost.toolFailures, 0);
  assert.equal(cost.repeatedCommands.length, 1);
  assert.equal(cost.repeatedCommands[0].command, 'pnpm test');
  assert.equal(cost.repeatedCommands[0].calls, 2);
  assert.equal(cost.repeatedCommandRate, 50);
});

test('turnOutcome: classifies outcome kinds', () => {
  assert.equal(turnOutcome({ kind: 'completed' }), 'completed');
  assert.equal(turnOutcome({ kind: 'error' }), 'error');
  assert.equal(turnOutcome({ kind: 'aborted' }), 'cancelled');
  assert.equal(turnOutcome({ kind: 'cancelled' }), 'cancelled');
  assert.equal(turnOutcome({ kind: 'max-tokens' }), 'max-tokens');
  assert.equal(turnOutcome({ kind: 'blocked' }), 'blocked');
  assert.equal(turnOutcome({ kind: 'interrupted' }), 'interrupted');
  assert.equal(turnOutcome(undefined), 'completed');
});

test('commandOfToolCall: extracts shell command strings', () => {
  assert.equal(commandOfToolCall('pwsh', { command: 'Get-ChildItem -Path .' }), 'Get-ChildItem -Path .');
  assert.equal(commandOfToolCall('bash', { shellCommand: 'ls   -la' }), 'ls -la');
  assert.equal(commandOfToolCall('read', { file_path: 'foo.txt' }), undefined);
});

test('eventToolResultError: detects various error shapes', () => {
  assert.equal(eventToolResultError({ type: 'tool/result', data: { message: { isError: true } } }), true);
  assert.equal(eventToolResultError({ type: 'tool/result', data: { ok: false } }), true);
  assert.equal(eventToolResultError({ type: 'tool/result', data: { status: 'failed' } }), true);
  assert.equal(eventToolResultError({ type: 'tool/result', data: { ok: true, content: 'done' } }), false);
  assert.equal(eventToolResultError({ type: 'tool/call', data: { isError: true } }), false);
});

test('formatting utilities: produce clean, expected outputs', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(542), '542');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(24500), '24.5k');
  assert.equal(formatTokens(1500000), '1.50M');

  assert.equal(formatExactTokens(12345), '12,345');

  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45000), '45s');
  assert.equal(formatDuration(125000), '2m 05s');
  assert.equal(formatDuration(3665000), '1h 01m');

  assert.equal(formatTokensPerSecond(42.3), '42 tok/s');
  assert.equal(formatTokensPerSecond(0), '—');

  assert.equal(formatMetricVolume(450), '450 chars');
  assert.equal(formatMetricVolume(15400), '15.4k chars');
  assert.equal(formatMetricVolume(1200000), '1.2M chars');

  assert.equal(tokenUsagePercent(50, 100), 50);
  assert.equal(tokenUsagePercent(150, 100), 100);
  assert.equal(tokenUsagePercent(-10, 100), 0);
});

test('readSessionDashboardFromHost: resolves session data via sessionQuery', async () => {
  const fakeObservation = {
    events: [
      { seq: 1, time: 100, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, time: 200, type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 500, outputTokens: 100 } } },
      { seq: 3, time: 250, type: 'turn/end', data: { turn: 1 } },
    ],
    header: { id: 'sess-abc', title: 'Test Session', cwd: 'D:/Code/test' },
    projections: {
      values: {
        sessionStats: { turns: 1, steps: 1 },
      },
    },
    [Symbol.dispose]() {},
  };

  const fakeCtx = {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          observeSession: async () => fakeObservation,
          listSessions: async () => [{ header: { id: 'sess-abc', title: 'Test Session' } }],
        };
      }
      return undefined;
    },
  };

  const data = await readSessionDashboardFromHost(fakeCtx, 'sess-abc');
  assert.equal(data.session.id, 'sess-abc');
  assert.equal(data.session.title, 'Test Session');
  assert.equal(data.summary.eventCount, 3);
  assert.equal(data.token.totals.totalTokens, 600);
  assert.ok(data.context, 'must include context insight');
  assert.equal(data.context.capacity.currentContextTokens, 500);
});

test('listSessionsFromHost: returns distinct sessions', async () => {
  const fakeCtx = {
    get(name) {
      if (name === 'sessions') {
        return {
          values: () => [
            { id: 'sess-1', header: { title: 'Session 1', cwd: '/workspace' } },
          ],
        };
      }
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => [
            { header: { id: 'sess-1', title: 'Session 1 duplicate' } },
            { header: { id: 'sess-2', title: 'Session 2' } },
          ],
        };
      }
      return undefined;
    },
  };

  const list = await listSessionsFromHost(fakeCtx);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'sess-1');
  assert.equal(list[1].id, 'sess-2');
});

test('resolveModelWindowTokens: resolves correct window limits', () => {
  assert.equal(resolveModelWindowTokens('deepseek-v3'), 131072);
  assert.equal(resolveModelWindowTokens('claude-3-5-sonnet'), 200000);
  assert.equal(resolveModelWindowTokens('gemini-1.5-pro'), 1000000);
  assert.equal(resolveModelWindowTokens('gpt-4o'), 128000);
  assert.equal(resolveModelWindowTokens('custom-model', 65536), 65536);
});

test('sessionContextInsight: extracts capacity, composition slices, lifecycle events, and synergy', () => {
  const entries = [
    { event: { seq: 1, time: 1000, type: 'turn/start', data: { turn: 1 } } },
    {
      event: {
        seq: 2,
        time: 1100,
        type: 'user/message',
        data: {
          turn: 1,
          source: { kind: 'extra-prompt-injection' },
          message: { content: 'System injection: obey coding guidelines' },
        },
      },
    },
    {
      event: {
        seq: 3,
        time: 1150,
        type: 'user/message',
        data: {
          turn: 1,
          source: { kind: 'skill' },
          message: { content: '<skill_content>office-docx instructions</skill_content>' },
        },
      },
    },
    {
      event: {
        seq: 4,
        time: 1200,
        type: 'user/message',
        data: {
          turn: 1,
          source: { kind: 'user' },
          message: { content: 'Please create document and run git' },
        },
      },
    },
    {
      event: {
        seq: 5,
        time: 1300,
        type: 'tool/call',
        data: {
          turn: 1,
          step: 1,
          callId: 'call-1',
          name: 'pwsh',
          arguments: { command: 'git status' },
        },
      },
    },
    {
      event: {
        seq: 6,
        time: 1400,
        type: 'tool/call',
        data: {
          turn: 1,
          step: 1,
          callId: 'call-2',
          name: 'mcp_postgres__query',
          arguments: { sql: 'SELECT 1' },
        },
      },
    },
    {
      event: {
        seq: 7,
        time: 1500,
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          callId: 'call-1',
          name: 'pwsh',
          content: 'git status output [truncated]...',
          truncated: true,
        },
      },
    },
    {
      event: {
        seq: 8,
        time: 1600,
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          usage: {
            inputTokens: 52000,
            outputTokens: 1200,
            cacheReadTokens: 40000,
            uncachedInputTokens: 12000,
          },
        },
      },
    },
    // Turn 2 with compaction: inputTokens drops from 52000 to 18000
    { event: { seq: 9, time: 2000, type: 'turn/start', data: { turn: 2 } } },
    {
      event: {
        seq: 10,
        time: 2100,
        type: 'assistant/message',
        data: {
          turn: 2,
          step: 1,
          usage: {
            inputTokens: 18000,
            outputTokens: 800,
            cacheReadTokens: 14000,
            uncachedInputTokens: 4000,
          },
        },
      },
    },
    { event: { seq: 11, time: 2200, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } } },
  ];

  const insight = sessionContextInsight(entries, { model: 'deepseek-v3' });

  // Capacity check
  assert.equal(insight.capacity.model, 'deepseek-v3');
  assert.equal(insight.capacity.maxWindowTokens, 131072);
  assert.equal(insight.capacity.currentContextTokens, 18000);
  assert.equal(insight.capacity.safetyStatus, 'safe');
  assert.ok(insight.capacity.remainingTokens > 100000);

  // Composition check
  assert.ok(Array.isArray(insight.composition.slices));
  assert.ok(insight.composition.slices.length >= 3);
  assert.ok(insight.composition.slices.some((s) => s.key === 'toolSchema'));
  assert.ok(insight.composition.slices.some((s) => s.key === 'injected'));
  assert.ok(insight.composition.slices.some((s) => s.key === 'skills'));

  // Events check: compaction, injection, pruning
  assert.ok(insight.events.length >= 3);
  const compactEvent = insight.events.find((e) => e.kind === 'compact');
  assert.ok(compactEvent, 'must detect compaction event');
  assert.equal(compactEvent.deltaTokens, -34000); // 52000 - 18000

  const injectEvents = insight.events.filter((e) => e.kind === 'inject');
  assert.ok(injectEvents.length >= 2, 'must detect prompt & skill injections');

  const pruneEvent = insight.events.find((e) => e.kind === 'prune');
  assert.ok(pruneEvent, 'must detect prune/truncation event');

  // Synergy check
  assert.equal(insight.synergy.mcpToolsCount, 1);
  assert.equal(insight.synergy.skillsLoadedCount, 1);
  assert.equal(insight.synergy.promptInjectionsCount, 1);
  assert.ok(insight.synergy.rtkSavingsTokens >= 0);
});

