// A dependency-free MCP server over stdio, for checking that this package really
// composes a working `mcp-client` instance.
//
// Nothing in the test suite can prove that: `@deepseek-ai/dsh-mcp-client` resolves
// only under the Host's own resolver, so the end-to-end path — settings document →
// `ctx.plugin` → child process → MCP handshake → registered tool — is checked by
// running this in a profile and reading the log it writes.
//
// It answers the three requests a client needs to discover a tool (`initialize`,
// `tools/list`, `tools/call`) and refuses everything else with the standard
// "method not found", which is how a server without that capability behaves.
//
// Usage, from a profile's `cordis.patch.yml`:
//
//   - id: extra-mcp
//     config:
//       servers:
//         - serverName: probe
//           enabled: true
//           transport: stdio
//           command: <absolute path to node>
//           args: ['<absolute path to this file>']
//
// Then read `mcp-probe.log` next to this file: `initialize` and `tools/list`
// arriving means the instance connected and its tool was published.

import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const LOG = new URL('./mcp-probe.log', import.meta.url)
const PROTOCOL_FALLBACK = '2025-06-18'

/** Record one line, so the run can be inspected after the fact. */
function note(line) {
  appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
}

/** Write one JSON-RPC message as a single line, which is what stdio framing means. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const TOOLS = [{
  name: 'echo',
  description: 'Echo a message back, to prove a tool from this server reached the model.',
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string', description: 'Text to echo back.' } },
    required: ['message'],
    additionalProperties: false,
  },
}]

/**
 * Answer one request.
 * @param message - the decoded JSON-RPC request.
 */
function handle(message) {
  const method = message.method
  note(`request ${method}`)
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: 'extra-prompt-probe', version: '0.0.0' },
      },
    })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    const echo = message.params?.arguments?.message ?? ''
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `probe:${echo}` }] } })
    return
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
    return
  }
  if (message.id === undefined) return
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${method}` } })
}

note('started')
createInterface({ input: process.stdin }).on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed === '') return
  try {
    handle(JSON.parse(trimmed))
  } catch (error) {
    note(`parse failure: ${error instanceof Error ? error.message : String(error)}`)
  }
})
