// Host plugin: subagent model routing guidance.
//
// This plugin owns only the 「when to use」 layer: the user writes one note per
// selectable route, and the plugin injects that text into every session's system
// prompt and projects it onto provider catalogs that support
// `models[].description`. The allow-list (which routes are selectable at all) is
// still enforced by the official `subagent-model-selection-settings` row and is
// written by the provider settings surface; this plugin never writes policy.
//
// The feature's on/off switch is the profile row's own: disabling
// `extra-subagent-routing` in the 「插件」 page disposes the fiber, which takes the
// routing section with it. The catalog notes this plugin wrote are not part of
// the fiber, so the disposer takes them back explicitly — otherwise
// `list_subagent_models` would keep advertising a note for a feature that is off.
//
// The settings namespace is the profile entry id (equal to the exported `name`),
// and the form is derived from the exported `Config` schema: only fields marked
// `.volatile()` can be edited while running, and the loader commits a new value
// into the live fiber in place and emits an instance-local
// `loader/volatile-update`; this plugin reacts to that event to re-project the
// catalog, replacing the removed `settings.register().watch()` path.

import Schema from '@deepseek-ai/schemastery'
import {
  ROUTING_NAMESPACE,
  SECTION_NAME,
  SECTION_ORDER,
  isRecord,
  modelsWithNotes,
  modelsWithoutNotes,
  notesByProvider,
  renderGuidance,
  supportsModelDescription,
  valueAtPath,
} from './model.mjs'

export const name = ROUTING_NAMESPACE

export const inject = ['settings', 'systemPrompt']

/** Live-editable route notes; each field commits independently. */
export const Config = Schema.object({
  routes: Schema.array(Schema.object({
    provider: Schema.string().required().description('Provider id, e.g. deepseek-official'),
    model: Schema.string().required().description('Model id as advertised by list_subagent_models'),
    note: Schema.string().default('').description('When to delegate to this route'),
  })).default([]).description('Routes the delegating agent may choose, with a usage note for each').volatile(),
  guidance: Schema.string().role('textarea').default('').description('Replaces the generated routing section entirely when non-empty').volatile(),
})

export function apply(ctx, config) {
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: () => renderGuidance(config.routes.get(), config.guidance.get()),
  })

  /** A failed projection must not fail the settings commit that triggered it. */
  const project = (enabled) => projectModelNotes(ctx, config.routes.get(), enabled).catch((error) => {
    ctx.logger?.warn?.(`subagent routing: model description projection failed: ${error?.message ?? error}`)
  })

  ctx.on('loader/volatile-update', (paths) => {
    // A pure guidance-text change does not reach the catalog; a route edit does.
    if (!Array.isArray(paths)) return
    if (!paths.some((path) => path[0] === 'routes')) return
    return project(true)
  })

  // Disposal is what switching the row off does, so it is also where the notes
  // have to come back: the section is gone with the fiber, and a stale note would
  // otherwise outlive the feature in every provider catalog that carries one.
  ctx.effect(() => () => {
    void project(false)
  })
}

/**
 * Write each route's note into its provider catalog's `description`.
 *
 * Only namespaces registered in `ctx.llm.listConfigurableProviders()` whose own
 * schema declares `models[].description` are touched: that field is the only
 * description source `list_subagent_models` reads, and backends that cannot
 * carry it (for example llm-pi-ai) are covered by the system-prompt section
 * instead. An empty note never touches the catalog, and an entry already holding
 * the target text is not rewritten.
 *
 * @param ctx - plugin context.
 * @param routes - this plugin's current `routes` value.
 * @param enabled - whether the notes belong in the catalog; the caller passes
 *   `false` from its disposer, which is what switching the row off runs.
 */
async function projectModelNotes(ctx, routes, enabled) {
  const grouped = notesByProvider(routes)
  if (grouped.size === 0) return
  const llm = ctx.get('llm')
  if (typeof llm?.listConfigurableProviders !== 'function') return
  const directory = llm.listConfigurableProviders()
  const descriptors = ctx.settings.describe()
  for (const [provider, notes] of grouped) {
    const entry = directory.find((candidate) => candidate?.provider === provider)
    if (entry === undefined || typeof entry.settingsNs !== 'string') continue
    const descriptor = descriptors.find((candidate) => candidate?.ns === entry.settingsNs)
    if (descriptor === undefined || !supportsModelDescription(descriptor.schema)) continue
    const settingsPath = Array.isArray(entry.settingsPath) ? [...entry.settingsPath] : []
    const profile = valueAtPath(descriptor.value, settingsPath)
    const models = isRecord(profile) && Array.isArray(profile.models) ? profile.models : []
    const applied = enabled ? modelsWithNotes(models, notes) : modelsWithoutNotes(models, notes)
    if (!applied.changed) continue
    // Write the whole array: the settings path operations do not address array
    // indices, and the catalog's resolved value already carries schema defaults,
    // so only one entry's description actually changes.
    await ctx.settings.mutate(entry.settingsNs, [{
      op: 'set',
      path: [...settingsPath, 'models'],
      value: applied.models,
    }])
  }
}
