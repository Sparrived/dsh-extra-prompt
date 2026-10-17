// Host plugin: MCP server management.
//
// DSH ships the MCP engine and no way to configure it. `@deepseek-ai/dsh-mcp-client`
// is a namespace plugin that connects to exactly one server per instance and is
// meant to be mounted as one config row per server, so today the only way to add
// a server is to hand-write that row into the profile's `cordis.patch.yml`. This
// plugin holds the server list in its own settings namespace and composes one
// `mcp-client` instance per entry, which turns the settings card into the missing
// management surface. It does not speak MCP itself.
//
// Composition is the plain Cordis mechanism, and it is the same path the loader
// itself takes: the loader imports a row's module and hands the resulting object
// to `ctx.plugin`. `ctx.plugin` is withheld only from the dynamic-plugin sandbox
// that `cordis_define` builds, which is not how a profile plugin is loaded.
//
// Three properties of `mcp-client` shape everything below:
//
// - An instance reserves its `serverName` in the scope of the context that
//   composed it. `ctx.plugin` gives the child an extension of this plugin's own
//   context, so every instance lands in one scope and the names must be unique
//   across the whole list, not merely within one entry.
// - The reservation is released by the child fiber's effect disposer, which runs
//   during disposal. Composing the same name again before that has settled is
//   rejected as a duplicate, so a rebuild waits for the old fiber to go quiet.
// - With `failOnStartupError` false an unreachable server only logs and reconnects
//   in the background, but a malformed spec and a `true` flag both reject the
//   composition. One bad entry must not take the other servers down with it, so
//   every composition is caught on its own.

import Schema from '@deepseek-ai/schemastery'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import {
  activeServers,
  normalizeServers,
  specKey,
  specOf,
  validateServers,
} from './model.mjs'

export const name = 'extra-mcp'

/** The composed instances register their tools on `ctx.tools`. */
export const inject = ['tools']

export const Config = Schema.object({
  servers: Schema.array(Schema.object({
    serverName: Schema.string().default(''),
    enabled: Schema.boolean().default(false),
    transport: Schema.union(['stdio', 'streamable-http']).default('stdio'),
    command: Schema.string().default(''),
    args: Schema.array(Schema.string()).default([]),
    env: Schema.dict(Schema.string()).default({}),
    cwd: Schema.string().default(''),
    url: Schema.string().default(''),
    headers: Schema.dict(Schema.string()).default({}),
    toolCallTimeoutMs: Schema.number().default(60000),
    maxInstructionBytes: Schema.number().default(32768),
    failOnStartupError: Schema.boolean().default(false),
    reconnectEnabled: Schema.boolean().default(true),
    reconnectInitialDelayMs: Schema.number().default(500),
    reconnectMaxDelayMs: Schema.number().default(30000),
    reconnectMaxAttempts: Schema.number().default(10),
  })).default([])
    .description('MCP servers to connect, one dsh-mcp-client instance each')
    .volatile(),
})

/**
 * Wait until a disposed fiber has released everything it owned.
 *
 * `fiber.dispose()` returns before the child's effect disposers have run, and
 * `serverName` is released by one of those disposers. Composing the next instance
 * of the same name too early is rejected as a duplicate reservation, so a rebuild
 * resolves the fiber's inertia to completion first. This mirrors `quiesceFiber`
 * in `@deepseek-ai/dsh-scope`.
 *
 * @param fiber - the fiber being replaced.
 * @returns a promise that settles once nothing is left to clean up.
 */
async function quiesce(fiber) {
  await Promise.resolve(fiber.dispose())
  while (fiber.inertia !== undefined) await fiber.inertia
}

/**
 * Manage the live `mcp-client` instances for one settings document.
 *
 * @param ctx - the plugin's host context.
 * @param documentOf - reads the current `servers` field.
 * @returns the reconcile entry point and its disposal.
 */
function instancesOf(ctx, documentOf) {
  /** Live instances by server name: the spec they were composed from, and the fiber. */
  const live = new Map()

  /** Serializes reconciles, so two overlapping runs cannot compose one name twice. */
  let tail = Promise.resolve()

  const dispose = async (serverName) => {
    const entry = live.get(serverName)
    if (entry === undefined) return
    live.delete(serverName)
    await quiesce(entry.fiber)
  }

  const compose = async (server) => {
    try {
      const fiber = await ctx.plugin(McpClient, specOf(server))
      live.set(server.serverName, { key: specKey(server), fiber })
    } catch (error) {
      // A rejected composition is one server's problem. Cordis has already rolled
      // its fiber back, so nothing is left registered under this name.
      ctx.logger.error(
        `extra-mcp: 无法连接 MCP 服务器 “${server.serverName}”：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Bring the live instances in line with the document: drop the removed and
   * disabled, compose the new, and rebuild only those whose connection settings
   * actually changed. A rebuild costs a disconnect and a fresh tool listing, so an
   * entry whose spec serializes the same is left alone.
   */
  const step = async () => {
    const servers = normalizeServers(documentOf())
    const issues = validateServers(servers)
    if (issues.length > 0) {
      // The card refuses to save these; reaching here means the document was
      // edited by hand, so say which entries are being skipped rather than
      // failing to connect them silently.
      ctx.logger.warn(`extra-mcp: 设置中有 ${issues.length} 处问题：${issues.map((issue) => issue.message).join(' ')}`)
    }
    const unusable = new Set(issues
      .filter((issue) => issue.index >= 0)
      .map((issue) => servers[issue.index].serverName))
    const wanted = new Map(activeServers(servers)
      .filter((server) => !unusable.has(server.serverName))
      .map((server) => [server.serverName, server]))

    for (const serverName of [...live.keys()]) {
      const server = wanted.get(serverName)
      if (server === undefined) await dispose(serverName)
      else if (live.get(serverName).key !== specKey(server)) await dispose(serverName)
    }
    for (const [serverName, server] of wanted) {
      if (!live.has(serverName)) await compose(server)
    }
  }

  return {
    reconcile: () => {
      tail = tail.then(step, step)
      return tail
    },
    disposeAll: async () => {
      // Let an in-flight reconcile finish first: it may be mid-composition, and
      // disposing underneath it would leave a fiber nothing tracks.
      await tail.catch(() => {})
      for (const serverName of [...live.keys()]) await dispose(serverName)
    },
  }
}

/**
 * Apply the document, and keep applying it as the settings change.
 *
 * @param ctx - the plugin's host context.
 * @param config - the resolved plugin config.
 */
export function apply(ctx, config) {
  // Read through the config object rather than a captured array, so a volatile
  // update is visible to the next reconcile. Whether MCP runs at all is the
  // profile row's switch: disabling `extra-mcp` in the 「插件」 page disposes the
  // fiber, `disposeAll` below releases every composed instance, and each server
  // keeps its own `enabled` flag for switching one server off inside the list.
  const documentOf = () => config.servers.get()
  const { reconcile, disposeAll } = instancesOf(ctx, documentOf)

  reconcile()
  ctx.effect(() => () => disposeAll())
  ctx.on('loader/volatile-update', (paths) => {
    if (!Array.isArray(paths)) return
    if (!paths.some((path) => path[0] === 'servers')) return
    reconcile()
  })
}
