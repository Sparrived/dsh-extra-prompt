// Cross-process serialization and atomic publication for files this plugin owns.
//
// Two platform realities drive this module:
//
// - On Windows `rename` is not atomic against other handles: a scanner, indexer,
//   or sync client holding the destination open fails the swap with
//   EPERM/EACCES/EBUSY. Those locks are short lived, so publication retries
//   briefly instead of surfacing a spurious failure for an operation that would
//   succeed on the next attempt.
// - Two Host processes can share one DSH home (the official desktop application
//   and a `dsh` CLI session), so an in-process queue is not sufficient. The lock
//   is therefore also published as an exclusive lock file carrying an owner pid
//   and a random token, so a crashed owner never wedges the directory forever
//   and a release never removes a lock another process has since acquired.

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

/** Serialization tails, keyed by the canonical lock path. */
const lockTails = new Map()
const LOCK_TIMEOUT_MS = 30_000
const LOCK_STALE_MS = 2 * 60_000

function abortError(signal) {
  const error = signal?.reason instanceof Error ? signal.reason : new Error('操作已取消')
  if (error.code === undefined) error.code = 'cancelled'
  return error
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal)
}

function sleep(ms, signal) {
  return new Promise((resolveSleep, reject) => {
    try {
      throwIfAborted(signal)
    } catch (error) {
      reject(error)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolveSleep()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function awaitWithAbort(promise, signal) {
  throwIfAborted(signal)
  if (signal === undefined) return promise
  return await new Promise((resolvePromise, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then((value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolvePromise(value)
    }, (error) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

/**
 * Publish a fully written temporary file over its destination.
 *
 * @param temp - the written temporary file.
 * @param destination - the path to replace.
 */
export async function replaceFileWithRetry(temp, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, destination)
      return
    } catch (error) {
      if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error
      await sleep(20 * (attempt + 1))
    }
  }
}

/**
 * Resolve a path with its existing ancestors dereferenced, so two spellings of
 * the same directory (a junction, a short name, a differently-cased drive)
 * serialize against one another instead of racing on separate locks.
 */
async function canonicalPath(path) {
  let current = resolve(path)
  const suffix = []
  for (;;) {
    const info = await lstat(current).catch((error) => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    if (info !== undefined) {
      if (info.isSymbolicLink()) throw new Error('目录不能是符号链接或 junction')
      const real = await realpath(current)
      return resolve(real, ...suffix.reverse())
    }
    suffix.push(basename(current))
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
}

async function assertSafeDirectoryAncestors(path, label) {
  let current = resolve(path)
  for (;;) {
    const info = await lstat(current).catch((error) => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    if (info?.isSymbolicLink()) throw new Error(`${label}及其父级不能是符号链接或 junction`)
    if (info !== undefined && !info.isDirectory()) throw new Error(`${label}必须是目录`)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function reclaimStaleLock(lockPath, lockInfo, signal) {
  throwIfAborted(signal)
  if (lockInfo === undefined || Date.now() - lockInfo.mtimeMs <= LOCK_STALE_MS) return false
  let metadata
  try {
    metadata = JSON.parse(await readFile(lockPath, 'utf8'))
  } catch {
    metadata = undefined
  }
  // A live owner is never reclaimed merely because a task runs for a long time.
  // Unknown or malformed locks are reclaimable only after the lease age.
  if (Number.isSafeInteger(metadata?.pid) && processIsAlive(metadata.pid)) return false
  const quarantine = `${lockPath}.stale-${randomUUID()}`
  try {
    await rename(lockPath, quarantine)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  await rm(quarantine, { force: true }).catch(() => undefined)
  return true
}

async function acquireLock(path, signal) {
  throwIfAborted(signal)
  const lockPath = `${resolve(path)}.lock`
  await assertSafeDirectoryAncestors(dirname(lockPath), '锁目录')
  await mkdir(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    throwIfAborted(signal)
    let handle
    let created = false
    const token = randomUUID()
    try {
      handle = await open(lockPath, 'wx', 0o600)
      created = true
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }), 'utf8')
      throwIfAborted(signal)
      let released = false
      return async () => {
        if (released) return
        released = true
        await handle.close().catch(() => undefined)
        let metadata
        try {
          metadata = JSON.parse(await readFile(lockPath, 'utf8'))
        } catch {
          return
        }
        // Only the owner that still holds this token may delete the lock file.
        if (metadata?.token === token) await rm(lockPath, { force: true }).catch(() => undefined)
      }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      if (created) {
        let metadata
        try {
          metadata = JSON.parse(await readFile(lockPath, 'utf8'))
        } catch {
          metadata = undefined
        }
        if (metadata?.token === token) await rm(lockPath, { force: true }).catch(() => undefined)
      }
      if (error?.code !== 'EEXIST') throw error
      const lockInfo = await lstat(lockPath).catch((lockError) => {
        if (lockError?.code === 'ENOENT') return undefined
        throw lockError
      })
      if (lockInfo?.isSymbolicLink()) throw new Error('锁文件不能是符号链接')
      if (await reclaimStaleLock(lockPath, lockInfo, signal)) continue
      if (Date.now() >= deadline) {
        const timeout = new Error('同一个 Skills 目录正在被其他进程修改，请稍后重试')
        timeout.code = 'lock-timeout'
        throw timeout
      }
      await sleep(50, signal)
    }
  }
}

/**
 * Serialize edits that share one path, both within this process and across
 * processes.
 *
 * @param path - the resource being guarded; the lock file is `<path>.lock`.
 * @param task - the critical section.
 * @param signal - optional abort signal.
 */
export async function withFileLock(path, task, signal) {
  throwIfAborted(signal)
  const key = await canonicalPath(path)
  const previous = lockTails.get(key) ?? Promise.resolve()
  let releaseGate
  const gate = new Promise((resolveGate) => { releaseGate = resolveGate })
  const tail = previous.catch(() => undefined).then(() => gate)
  lockTails.set(key, tail)
  let releaseExternal
  try {
    await awaitWithAbort(previous.catch(() => undefined), signal)
    throwIfAborted(signal)
    releaseExternal = await acquireLock(key, signal)
    throwIfAborted(signal)
    return await task()
  } finally {
    await releaseExternal?.()
    releaseGate()
    if (lockTails.get(key) === tail) lockTails.delete(key)
  }
}
