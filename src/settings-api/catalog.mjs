// Pure assembly of the model-visible Skill catalog for the settings page.
//
// The page has to show what the model can actually read, so nothing here decides
// where Skills live. `src/settings-api/index.mjs` asks the Host's own `skills`
// registry (`ctx.skills.list({ cwd })`) once per mounted workspace — the same
// registry the `skill` tool and the per-step `<available_skills>` catalog are
// built from — and hands those summaries to this module. That is what keeps the
// page from drifting from the model: no second directory walk, no second
// frontmatter parser, no second precedence rule. Project `.dsh/skills` and
// `.agents/skills`, user `$DSH_HOME/skills` and `~/.agents/skills`, custom roots,
// bundled roots and plugin runtime Skills all arrive already resolved by the
// Host, with the winning entry per name.
//
// Three jobs are left here, and all three are pure:
//
//   1. merge the per-workspace views into one list, letting the first view that
//      saw a name keep it (workspaces are queried before the cwd-less pass, so a
//      project Skill is reported as the project Skill the model would load);
//   2. re-attach the managed-install record (`skill-installer`'s registry) so the
//      page can offer an uninstall for exactly the entries this package wrote;
//   3. report registry records that no longer have a Skill behind them, so a
//      stale record can still be seen and cleaned instead of vanishing.

/** Ceiling on the entries one page read returns, so a pathological root cannot flood the card. */
export const MAX_CATALOG_ENTRIES = 200

/**
 * Normalize one `ctx.skills.list()` summary into a page-facing catalog entry.
 *
 * `resourceBase` is the provider's own answer for "where does this Skill live":
 * the filesystem provider sets it to the Skill directory, which is exactly the
 * directory the model resolves the body's relative paths against. Other kinds
 * carry no path, and reporting one would be a guess.
 *
 * @param summary - one winning summary from `ctx.skills.list()`.
 * @param workspace - the cwd the summary was listed for, when one was used.
 * @returns the entry the page renders.
 */
export function catalogEntryOf(summary, workspace) {
  const base = summary?.resourceBase
  return {
    skillName: typeof summary?.name === 'string' ? summary.name : '',
    description: typeof summary?.description === 'string' ? summary.description : '',
    ...typeof summary?.whenToUse === 'string' && summary.whenToUse !== ''
      ? { whenToUse: summary.whenToUse }
      : {},
    ...typeof summary?.source === 'string' ? { source: summary.source } : {},
    ...typeof summary?.provider === 'string' ? { provider: summary.provider } : {},
    // The registry resolves both flags for every summary; a summary missing the
    // object comes from a provider contract this page cannot check, so it is
    // reported as "not known to be invocable" rather than silently as callable.
    modelInvocable: summary?.invocation?.modelInvocable === true,
    userInvocable: summary?.invocation?.userInvocable === true,
    ...base !== undefined && base !== null && base.kind === 'directory' && typeof base.path === 'string'
      ? { directory: base.path }
      : {},
    ...typeof workspace === 'string' && workspace !== '' ? { workspace } : {},
  }
}

/**
 * Merge per-workspace catalogs into one list, first view winning a duplicate name.
 *
 * The same name can legitimately be listed under two workspaces (a project Skill
 * that does not exist in the other project) and appear twice for one workspace
 * (a user Skill the workspace does not shadow). Dropping the later copy is what
 * the model's own view does per workspace, and the entry kept is the one whose
 * workspace the model would actually load it from.
 *
 * @param views - `{ cwd, skills }` per query, most specific workspace first.
 * @param limit - maximum entries returned.
 * @returns the merged entries.
 */
export function mergeCatalogViews(views, limit = MAX_CATALOG_ENTRIES) {
  const entries = []
  const seen = new Set()
  for (const view of Array.isArray(views) ? views : []) {
    for (const summary of Array.isArray(view?.skills) ? view.skills : []) {
      const name = typeof summary?.name === 'string' ? summary.name : ''
      if (name === '' || seen.has(name)) continue
      seen.add(name)
      entries.push(catalogEntryOf(summary, view?.cwd))
      if (entries.length >= limit) return entries
    }
  }
  return entries
}

/**
 * Render one managed-registry row for the page.
 *
 * `installationId` travels to the browser because it is the opaque address
 * `skills/remove` demands; it is not a secret, it is the proof of which install
 * the row refers to.
 *
 * @param row - one record from `listManagedSkills()`.
 * @returns the install provenance the page shows.
 */
export function managedInstallOf(row) {
  return {
    directoryName: row?.directoryName,
    installationId: row?.installationId,
    ...typeof row?.source === 'string' ? { source: row.source } : {},
    ...typeof row?.ref === 'string' ? { ref: row.ref } : {},
    ...typeof row?.installPath === 'string' ? { installPath: row.installPath } : {},
    removable: row?.removable === true,
    ...typeof row?.reason === 'string' && row.reason !== '' ? { reason: row.reason } : {},
  }
}

/**
 * Attach each managed record to the catalog entry it describes.
 *
 * The install path is the primary key: it is the directory this package created,
 * and the catalog entry's `directory` is the provider's own answer for the same
 * directory, so an exact match proves the record and the live Skill are the same
 * thing. The Skill name is the fallback, for a provider that reports no
 * directory at all.
 *
 * @param entries - merged catalog entries.
 * @param managed - records from `listManagedSkills()`.
 * @returns the annotated entries plus the records that matched something.
 */
export function attachManagedInstalls(entries, managed) {
  const rows = Array.isArray(managed) ? managed : []
  const byPath = new Map()
  const byName = new Map()
  for (const row of rows) {
    if (typeof row?.installPath === 'string' && !byPath.has(row.installPath)) byPath.set(row.installPath, row)
    if (typeof row?.skillName === 'string' && !byName.has(row.skillName)) byName.set(row.skillName, row)
  }
  const claimed = new Set()
  const skills = (Array.isArray(entries) ? entries : []).map((entry) => {
    const row = (typeof entry.directory === 'string' ? byPath.get(entry.directory) : undefined)
      ?? byName.get(entry.skillName)
    if (row === undefined) return entry
    claimed.add(row)
    return { ...entry, managed: managedInstallOf(row) }
  })
  return { skills, claimed }
}

/**
 * Report managed records with no live Skill behind them.
 *
 * A record whose directory was deleted by hand, or whose `SKILL.md` no longer
 * parses, produces no catalog entry — but it is still a row this package owns,
 * and hiding it would leave the user with an unremovable line in a hidden file.
 * These entries are inert: they carry the record's own reason and no Skill
 * metadata, and the page shows them without pretending a Skill exists.
 *
 * @param managed - records from `listManagedSkills()`.
 * @param claimed - the records `attachManagedInstalls()` matched.
 * @returns one entry per unclaimed record.
 */
export function orphanManagedEntries(managed, claimed) {
  const matched = claimed instanceof Set ? claimed : new Set()
  return (Array.isArray(managed) ? managed : [])
    .filter(row => !matched.has(row))
    .map(row => ({
      skillName: typeof row?.skillName === 'string' ? row.skillName : '',
      description: '',
      orphan: true,
      ...typeof row?.installPath === 'string' ? { directory: row.installPath } : {},
      managed: managedInstallOf(row),
    }))
}

/**
 * Assemble the `skills/list` result the page renders.
 *
 * @param options - catalog views, managed records, and the caveats to pass along.
 * @returns the value of the `skills/list` response.
 */
export function assembleSkillCatalog(options = {}) {
  const views = Array.isArray(options.views) ? options.views : []
  const merged = mergeCatalogViews(views)
  const { skills, claimed } = attachManagedInstalls(merged, options.managed)
  return {
    catalogAvailable: options.catalogAvailable !== false,
    skills: [...skills, ...orphanManagedEntries(options.managed, claimed)],
    workspaces: views
      .filter(view => typeof view?.cwd === 'string' && view.cwd !== '')
      .map(view => ({
        cwd: view.cwd,
        found: Array.isArray(view.skills) ? view.skills.length : 0,
        // The preset whose composition supplied this workspace's roots: the agent
        // preset is what mounts the filesystem provider, so naming it is what makes
        // "these are the model's directories" checkable by the reader.
        ...typeof view.preset === 'string' && view.preset !== '' ? { preset: view.preset } : {},
      })),
    notes: Array.isArray(options.notes) ? options.notes : [],
  }
}
