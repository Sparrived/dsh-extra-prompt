// Host plugin: rtk output compaction for shell tool results.
//
// rtk (https://github.com/rtk-ai/rtk) compresses shell output through
// `rtk pipe -f <filter>`, which reads stdin and writes stdout without ever
// re-running the command. This plugin pipes a tool result's text body through
// rtk before the model sees it, and keeps the exit-status marker verbatim so
// failure semantics survive.
//
// Two properties are load-bearing and must not regress:
//
// - Only `result.isError === false` results are considered, and every failure
//   path (missing rtk, timeout, non-zero exit, empty or lossy output) returns the
//   original decision untouched. A missing or broken rtk must degrade to plain
//   passthrough, never to a broken tool call.
// - Compression is opt-in per command. rtk's content-sniffing default is never
//   used, because a misdetected filter silently discards information.
//
// The listener reads the canonical blocks from `result.content`: a waterfall
// `next()` that accepts without replacing content returns `{ kind: 'accept' }`
// with no `content` property of its own.
//
// Every tunable is a `.volatile()` `Config` field, so the loader commits an edit
// into the live fiber and the next tool result uses it. Resolved executable
// caching is invalidated when `rtkPath` changes, so correcting a path takes
// effect immediately instead of at the next restart.

import Schema from '@deepseek-ai/schemastery'
import { FILTER_RULES, filterForCommand, rebuildTextBlocks, splitTrailingMarkers } from './model.mjs'

export const name = 'extra-rtk-compact'

// `subprocess` is the only spawn seam available to a Host plugin, and the
// timeout race needs the disposer-aware timer service rather than a global
// setTimeout, which would outlive the fiber.
export const inject = ['subprocess', 'timer']

export const Config = Schema.object({
  enabled: Schema.boolean().default(true)
    .description('Pipe shell tool output through rtk before the model sees it')
    .volatile(),
  rtkPath: Schema.string().default('')
    .description('Absolute path to the rtk executable; empty resolves `rtk` from PATH')
    .volatile(),
  minBodyChars: Schema.number().min(0).default(1200)
    .description('Bodies shorter than this are left untouched, to avoid spawning a process for negligible gain')
    .volatile(),
  timeoutMs: Schema.number().min(1).default(20000)
    .description('Kill the filter if it has not finished within this budget')
    .volatile(),
  maxOutputBytes: Schema.number().min(1).default(4 * 1024 * 1024)
    .description('Upper bound for collected filter stdout')
    .volatile(),
  gitStatus: Schema.boolean().default(true).description('Compact `git status` output').volatile(),
  gitDiff: Schema.boolean().default(true).description('Compact `git diff` output').volatile(),
  gitLog: Schema.boolean().default(true).description('Compact `git log` output').volatile(),
  rg: Schema.boolean().default(true).description('Compact `rg` output').volatile(),
  grep: Schema.boolean().default(true).description('Compact `grep` output').volatile(),
})

export function apply(ctx, config) {
  const subprocess = ctx.subprocess

  /** Filter keys the user switched off, recomputed per result so an edit applies at once. */
  const disabledFilters = () => {
    const disabled = new Set()
    for (const rule of FILTER_RULES) {
      if (!config[rule.key].get()) disabled.add(rule.key)
    }
    return disabled
  }

  // PATH resolution is verified once, so a deployment without rtk stays in
  // passthrough instead of re-probing on every call. Editing `rtkPath` drops the
  // cached outcome, which is how a user recovers after installing rtk or
  // correcting a bad path mid-session.
  let executablePromise

  /** Whether the "enabled, but this machine has no rtk" warning has been logged. */
  let warnedMissing = false

  const resolveExecutable = () => {
    if (executablePromise === undefined) {
      const configured = config.rtkPath.get().trim()
      executablePromise = configured === ''
        ? subprocess.resolveExecutable('rtk').then(path => path, () => undefined)
        : Promise.resolve(configured)
      // Without rtk every result passes through untouched, which is
      // indistinguishable from the feature working on already-compact output. Say it
      // once, rather than leaving an operator to wonder why nothing is compressed.
      void executablePromise.then((path) => {
        if (path !== undefined || warnedMissing || !config.enabled.get()) return
        warnedMissing = true
        ctx.logger?.warn?.(
          'rtk-compact 已启用，但本机没有找到 rtk 可执行文件，工具输出将原样通过；'
          + '安装 rtk，或在本功能的设置里指定 rtkPath。刚装完 rtk 时，需要重启一次才会拿到新的 PATH。',
        )
      })
    }
    return executablePromise
  }

  ctx.on('loader/volatile-update', (paths) => {
    if (!Array.isArray(paths)) return
    if (!paths.some((path) => path[0] === 'rtkPath')) return
    executablePromise = undefined
    // A corrected path deserves its own verdict, including a second warning.
    warnedMissing = false
  })

  const runFilter = async (body, filter, cwd) => {
    const executable = await resolveExecutable()
    if (executable === undefined) return undefined

    let handle
    try {
      handle = subprocess.spawn({
        argv: [executable, 'pipe', '-f', filter],
        cwd,
        stdio: {
          stdin: { data: body },
          stdout: { maxBytes: config.maxOutputBytes.get() },
          stderr: { maxBytes: 64 * 1024 },
        },
        graceMs: 2000,
      })
    } catch {
      return undefined
    }

    let timedOut = false
    const settled = handle.done.then(
      outcome => outcome,
      () => undefined,
    )
    const outcome = await Promise.race([
      settled,
      ctx.timeout(config.timeoutMs.get()).then(() => {
        timedOut = true
        return undefined
      }),
    ])
    if (timedOut) {
      try {
        handle.terminate()
      } catch {
        // The process may already be gone; nothing left to release.
      }
      return undefined
    }
    if (outcome === undefined || outcome.exitCode !== 0) return undefined

    const reader = handle.collected?.stdout
    if (reader === undefined) return undefined
    // A lossy read means the collected buffer dropped bytes, so the filter
    // output cannot be trusted as a faithful compression of the input.
    const read = reader.readFrom(0)
    if (read.lossy) return undefined
    if (typeof read.text !== 'string' || read.text.trim() === '') return undefined
    return read.text
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept') return decision
    // Disabled is read per result, like every other tunable, so switching it off
    // takes effect on the next command instead of at the next restart.
    if (!config.enabled.get()) return decision
    if (exec.name !== 'pwsh' && exec.name !== 'bash') return decision
    if (result.isError === true) return decision

    const source = Array.isArray(decision.content) ? decision.content : result.content
    if (!Array.isArray(source)) return decision

    const command = exec.arguments?.command
    if (typeof command !== 'string') return decision
    const filter = filterForCommand(command, disabledFilters())
    if (filter === undefined) return decision

    const blocks = source.slice()
    const before = blocks
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
    const { body, markers } = splitTrailingMarkers(before)
    if (body.length < config.minBodyChars.get()) return decision

    // The spawn seam takes no default working directory. `rtk pipe` only reads
    // stdin, so the caller's own directory is used purely as a valid base; when
    // it cannot be determined the result stays untouched.
    const cwd = typeof exec.arguments?.workdir === 'string' && exec.arguments.workdir !== ''
      ? exec.arguments.workdir
      : exec.agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return decision

    let compressed
    try {
      compressed = await runFilter(body, filter, cwd)
    } catch {
      return decision
    }
    if (compressed === undefined) return decision

    const suffix = markers.length === 0 ? '' : `\n${markers.join('\n')}`
    ctx.logger?.debug?.(
      `rtk-compact ${filter}: ${body.length} -> ${compressed.length} chars for "${command.slice(0, 80)}"`,
    )
    return { kind: 'accept', content: rebuildTextBlocks(blocks, compressed + suffix) }
  })
}
