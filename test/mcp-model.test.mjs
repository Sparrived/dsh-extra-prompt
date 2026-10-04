// Rules for the MCP server manager.
//
// These cover the pure half only. Whether `@deepseek-ai/dsh-mcp-client` accepts
// what `specOf` builds is not provable here — the package resolves only under the
// Host's own resolver — so the spec's key sets are pinned exactly instead, and the
// live composition is checked in a running profile.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULTS,
  MAX_SERVERS,
  activeServers,
  bindingNameAccepted,
  newServer,
  normalizeServer,
  normalizeServers,
  specKey,
  specOf,
  urlAccepted,
  validateServers,
} from '../src/mcp/model.mjs'

/** @returns a valid stdio entry with the given overrides. */
function stdio(overrides = {}) {
  return { serverName: 'demo', transport: 'stdio', command: 'npx', ...overrides }
}

/** @returns a valid Streamable HTTP entry with the given overrides. */
function http(overrides = {}) {
  return { serverName: 'remote', transport: 'streamable-http', url: 'https://mcp.example/mcp', ...overrides }
}

test('fills every field of a bare entry and reads a missing switch as off', () => {
  assert.deepEqual(normalizeServer({}), {
    serverName: '',
    enabled: false,
    transport: 'stdio',
    command: '',
    args: [],
    env: {},
    cwd: '',
    url: '',
    headers: {},
    toolCallTimeoutMs: 60000,
    maxInstructionBytes: 32768,
    failOnStartupError: false,
    reconnectEnabled: true,
    reconnectInitialDelayMs: 500,
    reconnectMaxDelayMs: 30000,
    reconnectMaxAttempts: 10,
  })
})

test('rejects entries that are not objects', () => {
  for (const value of [null, undefined, 'stdio', 7, [], true]) {
    assert.equal(normalizeServer(value), null, String(value))
  }
})

test('drops unusable entries but keeps document order', () => {
  const servers = normalizeServers([stdio({ serverName: 'a' }), null, 'x', stdio({ serverName: 'b' })])
  assert.deepEqual(servers.map((server) => server.serverName), ['a', 'b'])
  assert.deepEqual(normalizeServers(undefined), [])
  assert.deepEqual(normalizeServers({}), [])
})

test('coerces rather than throws on unexpected field types', () => {
  const server = normalizeServer({
    serverName: 42,
    enabled: 'true',
    transport: 'websocket',
    args: ['ok', 7, null],
    env: { GOOD: 'v', BAD: 7 },
    toolCallTimeoutMs: Number.NaN,
    reconnectEnabled: 'no',
  })
  assert.equal(server.serverName, '')
  assert.equal(server.enabled, false, 'only a real boolean enables a server')
  assert.equal(server.transport, 'stdio', 'an unknown transport falls back to stdio')
  assert.deepEqual(server.args, ['ok'], 'only strings survive in an argument list')
  assert.deepEqual(server.env, { GOOD: 'v' })
  assert.equal(server.toolCallTimeoutMs, DEFAULTS.toolCallTimeoutMs)
  assert.equal(server.reconnectEnabled, true, 'only an explicit false disables reconnect')
})

test('builds exactly the mcp-client stdio config, with no field of its own', () => {
  const spec = specOf(normalizeServer(stdio({ args: ['-y', 'server'], env: { TOKEN: 't' }, cwd: '/w' })))
  assert.deepEqual(Object.keys(spec).sort(), [
    'args', 'command', 'cwd', 'env', 'failOnStartupError', 'maxInstructionBytes',
    'reconnect', 'serverName', 'toolCallTimeoutMs', 'transport',
  ])
  assert.equal(spec.transport, 'stdio')
  assert.deepEqual(Object.keys(spec.reconnect).sort(),
    ['enabled', 'initialDelayMs', 'maxAttempts', 'maxDelayMs'])
})

test('builds exactly the mcp-client HTTP config, without stdio fields', () => {
  const spec = specOf(normalizeServer(http({ headers: { Authorization: 'Bearer t' } })))
  assert.deepEqual(Object.keys(spec).sort(), [
    'failOnStartupError', 'headers', 'maxInstructionBytes', 'reconnect',
    'serverName', 'toolCallTimeoutMs', 'transport', 'url',
  ])
  assert.equal(spec.transport, 'streamable-http')
})

test('carries the reconnect settings into the nested spec', () => {
  const spec = specOf(normalizeServer(stdio({
    reconnectEnabled: false,
    reconnectInitialDelayMs: 250,
    reconnectMaxDelayMs: 9000,
    reconnectMaxAttempts: 3,
  })))
  assert.deepEqual(spec.reconnect, {
    enabled: false, initialDelayMs: 250, maxDelayMs: 9000, maxAttempts: 3,
  })
})

test('serializes equal specs equally, and only a connection field changes it', () => {
  const base = normalizeServer(stdio())
  assert.equal(specKey(base), specKey(normalizeServer(stdio())))
  assert.notEqual(specKey(base), specKey(normalizeServer(stdio({ command: 'other' }))))
  // The switch decides whether an instance exists, not how it connects, so
  // flipping it must not look like a settings change and force a reconnect.
  assert.equal(specKey(base), specKey(normalizeServer(stdio({ enabled: true }))))
})

test('selects only the enabled servers, in document order', () => {
  const servers = normalizeServers([
    stdio({ serverName: 'a', enabled: true }),
    stdio({ serverName: 'b', enabled: false }),
    stdio({ serverName: 'c', enabled: true }),
  ])
  assert.deepEqual(activeServers(servers).map((server) => server.serverName), ['a', 'c'])
})

test('accepts binding names per kind', () => {
  assert.equal(bindingNameAccepted('GITHUB_TOKEN', 'env'), true)
  assert.equal(bindingNameAccepted('_x1', 'env'), true)
  assert.equal(bindingNameAccepted('1BAD', 'env'), false)
  assert.equal(bindingNameAccepted('HAS SPACE', 'env'), false)
  assert.equal(bindingNameAccepted('Authorization', 'header'), true)
  assert.equal(bindingNameAccepted('X-Api-Key', 'header'), true)
  assert.equal(bindingNameAccepted('Bad Header', 'header'), false)
  assert.equal(bindingNameAccepted('Bad:Header', 'header'), false)
})

test('accepts only absolute http(s) URLs with no embedded credentials', () => {
  assert.equal(urlAccepted('https://mcp.example/mcp'), true)
  assert.equal(urlAccepted('http://127.0.0.1:8080/mcp'), true)
  assert.equal(urlAccepted('ftp://mcp.example/mcp'), false)
  assert.equal(urlAccepted('mcp.example/mcp'), false)
  assert.equal(urlAccepted('/local/path'), false)
  assert.equal(urlAccepted('https://user:secret@mcp.example/mcp'), false,
    'userinfo would be sent on every request, hidden from the card')
})

test('finds nothing wrong with a well-formed document', () => {
  assert.deepEqual(validateServers(normalizeServers([
    stdio({ serverName: 'local', enabled: true, env: { TOKEN: 't' } }),
    http({ serverName: 'remote', enabled: false, headers: { Authorization: 'Bearer t' } }),
  ])), [])
  assert.deepEqual(validateServers([]), [])
})

test('reports the server name rules', () => {
  const [bad] = validateServers(normalizeServers([stdio({ serverName: 'bad name!' })]))
  assert.equal(bad.field, 'serverName')
  assert.equal(bad.index, 0)
  assert.deepEqual(validateServers(normalizeServers([stdio({ serverName: 'a'.repeat(33) })]))
    .map((issue) => issue.field), ['serverName'])
  const duplicate = validateServers(normalizeServers([
    stdio({ serverName: 'same' }), stdio({ serverName: 'same' }),
  ]))
  assert.deepEqual(duplicate.map((issue) => [issue.index, issue.field]), [[1, 'serverName']])
})

test('requires the field each transport actually needs', () => {
  assert.deepEqual(validateServers(normalizeServers([stdio({ command: '  ' })]))
    .map((issue) => issue.field), ['command'])
  assert.deepEqual(validateServers(normalizeServers([http({ url: '' })]))
    .map((issue) => issue.field), ['url'])
  assert.deepEqual(validateServers(normalizeServers([http({ url: 'ftp://x/y' })]))
    .map((issue) => issue.field), ['url'])
  // A missing stdio command never becomes a missing HTTP URL: the two transports
  // own different fields, and the validator must not ask for the other one's.
  assert.deepEqual(validateServers(normalizeServers([stdio({ command: 'npx' })])), [])
  assert.deepEqual(validateServers(normalizeServers([http({})])), [])
})

test('reports invalid binding names against the transport that owns them', () => {
  assert.deepEqual(validateServers(normalizeServers([stdio({ env: { 'BAD NAME': 'x' } })]))
    .map((issue) => issue.field), ['env'])
  assert.deepEqual(validateServers(normalizeServers([http({ headers: { 'BAD NAME': 'x' } })]))
    .map((issue) => issue.field), ['headers'])
})

test('bounds the numbers mcp-client declares bare', () => {
  const fields = (overrides) => validateServers(normalizeServers([stdio(overrides)]))
    .map((issue) => issue.field)
  assert.deepEqual(fields({ toolCallTimeoutMs: 99 }), ['toolCallTimeoutMs'])
  assert.deepEqual(fields({ toolCallTimeoutMs: 300001 }), ['toolCallTimeoutMs'])
  assert.deepEqual(fields({ toolCallTimeoutMs: 100 }), [])
  assert.deepEqual(fields({ maxInstructionBytes: 0 }), ['maxInstructionBytes'])
  assert.deepEqual(fields({ maxInstructionBytes: 1.5 }), ['maxInstructionBytes'])
  assert.deepEqual(fields({ reconnectMaxAttempts: 0 }), ['reconnectMaxAttempts'])
  assert.deepEqual(fields({ reconnectMaxAttempts: 101 }), ['reconnectMaxAttempts'])
  assert.deepEqual(fields({ reconnectInitialDelayMs: 0 }), ['reconnectInitialDelayMs'])
  assert.deepEqual(fields({ reconnectMaxDelayMs: 300001 }), ['reconnectMaxDelayMs'])
  assert.deepEqual(fields({ reconnectInitialDelayMs: 5000, reconnectMaxDelayMs: 100 }),
    ['reconnectInitialDelayMs'])
})

test('does not police reconnect numbers while reconnect is off', () => {
  assert.deepEqual(validateServers(normalizeServers([stdio({
    reconnectEnabled: false,
    reconnectInitialDelayMs: 0,
    reconnectMaxDelayMs: 0,
    reconnectMaxAttempts: 0,
  })])), [])
})

test('caps the document at a reviewable number of servers', () => {
  const many = Array.from({ length: MAX_SERVERS + 1 }, (unused, index) => stdio({ serverName: `s${index}` }))
  const issues = validateServers(normalizeServers(many))
  assert.equal(issues.length, 1)
  assert.equal(issues[0].field, 'servers')
  assert.equal(issues[0].index, -1, 'a document-level issue names no single server')
  assert.deepEqual(validateServers(normalizeServers(
    many.slice(0, MAX_SERVERS),
  )), [])
})

test('a new server starts switched off', () => {
  const server = newServer('github')
  assert.equal(server.serverName, 'github')
  assert.equal(server.enabled, false, 'saving the card must not start a child process')
  assert.equal(server.transport, 'stdio')
  assert.equal(server.toolCallTimeoutMs, DEFAULTS.toolCallTimeoutMs)
})
