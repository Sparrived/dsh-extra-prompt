// Resolution of the running Host's DSH home and profile directory.
//
// `profileContext` is published by the launcher before any profile entry mounts
// and its `dir` is the directory whose `cordis.patch.yml` and profile-scoped
// state the running Host actually composes. That record always wins, so a write
// lands in the profile the application booted rather than in a path this plugin
// re-derives.

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Directory under the harness home holding every profile. */
const PROFILES_DIR = 'profiles'

function normalizeAbsolutePath(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : resolve(trimmed)
}

/**
 * Resolve the harness home the running DSH process owns.
 *
 * `dshHomePath` is the accessor app-boot provides on the root context before any
 * profile entry mounts, so a mounted context resolves the same home every
 * official plugin uses (`dshHome` config, then `$DSH_HOME`, then `~/.dsh`).
 *
 * @param ctx - Cordis plugin context, or a plain object for standalone callers.
 * @returns the absolute harness home.
 */
export function resolveDshHome(ctx) {
  if (typeof ctx?.get === 'function') {
    const homePath = ctx.get('dshHomePath')
    if (typeof homePath === 'function') {
      const home = normalizeAbsolutePath(homePath())
      if (home !== undefined) return home
    }
    const configured = normalizeAbsolutePath(ctx.get('dshHome'))
    if (configured !== undefined) return configured
  }
  return normalizeAbsolutePath(process.env.DSH_HOME) ?? resolve(homedir(), '.dsh')
}

/**
 * Resolve the profile directory the running Host composes.
 *
 * @param ctx - Cordis plugin context, or a plain object for standalone callers.
 * @returns the absolute profile directory, or `undefined` when no mounted
 *   profile names one. Callers must treat that as "no profile-scoped state
 *   available" rather than guessing a directory.
 */
export function resolveDshProfileDir(ctx) {
  const profile = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined
  const mounted = normalizeAbsolutePath(profile?.dir)
  if (mounted !== undefined) return mounted
  return undefined
}

/**
 * The directory under one harness home holding a named profile.
 * @param home - the absolute harness home.
 * @param name - the profile name.
 * @returns the absolute profile directory.
 */
export function profileDirectory(home, name) {
  return join(home, PROFILES_DIR, name)
}
