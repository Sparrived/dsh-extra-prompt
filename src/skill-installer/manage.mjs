// Reading and removing the Skills this package installed.
//
// `installer.mjs` writes two things: the Skill directory itself, and a managed
// record in the profile's `extra-prompt-managed-skills.json`. Removal therefore
// has to prove both sides still agree before deleting anything — a registry row
// alone must never authorize deleting a directory, because a user may have
// deleted, replaced, or hand-edited what is at that path since it was installed.
//
// The marker inside the Skill directory is that proof: it carries the same
// `installationId` the registry row does, and the id is opaque and per-install.
// A directory whose marker is missing, unreadable, or different is reported as
// not removable with the reason, and left alone.

import { lstat, readFile, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { withFileLock } from '../shared/fs-lock.mjs'
import {
  MANAGED_SKILL_REGISTRY_FILE,
  readManagedSkillRegistry,
  removeManagedSkillRegistration,
} from './managed-registry.mjs'
import { MANAGED_SKILL_MARKER, SKILL_MUTATION_LOCK_KEY } from './installer.mjs'

/** Byte ceiling for the marker file, matching the installer's own write. */
const MAX_MARKER_BYTES = 64 * 1024

/**
 * Resolve one managed record's directory below the user Skills root.
 * @param destRoot - the absolute user Skills directory.
 * @param directoryName - the record's directory name.
 * @returns the absolute install path.
 */
function installPathOf(destRoot, directoryName) {
  const destination = resolve(destRoot, directoryName)
  const prefix = destRoot.endsWith(sep) ? destRoot : `${destRoot}${sep}`
  // The registry validates the name, but the deletion authorization is worth
  // re-deriving here: a path that escaped the root would delete the wrong tree.
  if (!destination.startsWith(prefix)) throw new Error(`Skill 目录越界：${directoryName}`)
  return destination
}

/**
 * Read one Skill directory's managed marker.
 * @param destination - the absolute Skill directory.
 * @returns the parsed marker, or `undefined` when there is none.
 */
async function readMarker(destination) {
  const path = join(destination, MANAGED_SKILL_MARKER)
  const info = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (info === undefined) return undefined
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_MARKER_BYTES) return undefined
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    // An unreadable or malformed marker is exactly the "cannot prove this is ours"
    // case, and the caller reports it as not removable rather than failing the list.
    return undefined
  }
}

/**
 * List the Skills this package installed, with whether each can still be removed.
 *
 * `removable` is false for anything the current install no longer owns, and the
 * `reason` says which of the two proofs failed, so the page can explain it instead
 * of offering a button that would refuse.
 *
 * @param options - the user Skills root and the mounted profile directory.
 * @returns one row per registry record.
 */
export async function listManagedSkills({ destRoot, profileDir }) {
  if (profileDir === undefined) {
    throw new Error(`没有挂载的 profile 目录，无法读取 ${MANAGED_SKILL_REGISTRY_FILE}。`)
  }
  const registry = await readManagedSkillRegistry(profileDir)
  const root = resolve(destRoot)
  return Promise.all(registry.entries.map(async (entry) => {
    const installPath = installPathOf(root, entry.directoryName)
    const info = await lstat(installPath).catch((error) => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    const marker = info?.isDirectory() === true ? await readMarker(installPath) : undefined
    const removable = marker !== undefined && marker.installationId === entry.installationId
    return {
      ...entry,
      installPath,
      removable,
      reason: removable
        ? undefined
        : info === undefined
          ? '目录已不存在，可以清理这条记录。'
          : '目录中的受管标记与记录不一致，为避免删除非本插件安装的内容，这里不会移除它。',
    }
  }))
}

/**
 * Remove one installed Skill and its registry record.
 *
 * The directory is deleted before the record, so an interrupted removal leaves a
 * record whose directory is gone — which `listManagedSkills` reports as a
 * cleanable row — rather than a directory nothing tracks.
 *
 * @param options - the user Skills root, the mounted profile directory, and the installation identity.
 * @returns the removed installation's name and path.
 */
export async function uninstallManagedSkill({ destRoot, profileDir, directoryName, installationId }) {
  if (profileDir === undefined) {
    throw new Error(`没有挂载的 profile 目录，无法读取 ${MANAGED_SKILL_REGISTRY_FILE}。`)
  }
  if (typeof directoryName !== 'string' || typeof installationId !== 'string') {
    throw new Error('卸载需要 directoryName 与 installationId。')
  }
  const registry = await readManagedSkillRegistry(profileDir)
  const entry = registry.entries.find(candidate => candidate.directoryName === directoryName)
  if (entry === undefined) throw new Error(`没有记录名为 ${directoryName} 的受管 Skill。`)
  if (entry.installationId !== installationId) throw new Error('安装标识不匹配，记录可能已被重新安装。')
  const root = resolve(destRoot)
  const installPath = installPathOf(root, entry.directoryName)
  return await withFileLock(join(root, SKILL_MUTATION_LOCK_KEY), async () => {
    const info = await lstat(installPath).catch((error) => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    if (info !== undefined) {
      if (!info.isDirectory()) throw new Error(`${installPath} 不是目录。`)
      const marker = await readMarker(installPath)
      if (marker === undefined || marker.installationId !== entry.installationId) {
        throw new Error('目录中的受管标记与记录不一致，已拒绝删除。')
      }
      // Only a directory proven to be this exact installation is removed; the
      // marker check above is what makes the recursive delete safe.
      await rm(installPath, { recursive: true, force: false })
    }
    await removeManagedSkillRegistration(profileDir, entry.directoryName, entry.installationId)
    return { directoryName: entry.directoryName, skillName: entry.skillName, installPath }
  })
}
