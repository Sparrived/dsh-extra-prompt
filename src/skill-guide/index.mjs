// Host plugin: Skill authoring guidance.
//
// This plugin contributes exactly one runtime skill, `skill-create`, which
// explains how to write a reusable Skill: the frontmatter contract, the
// recommended body structure, and a pre-publication checklist. The body is
// inlined in this package, so it needs no extra files, is withdrawn with the
// Cordis fiber, and produces no disk side effects.
//
// Workspace-level `.dsh/skills/` discovery is NOT this plugin's job: the
// official `@deepseek-ai/dsh-skill-filesystem` already resolves the project root
// from the cwd and scans `.dsh/skills` and `.agents/skills`, mounted by an agent
// preset. This plugin only adds the authoring-guidance layer upstream lacks.
//
// `enabled` and `customGuide` are `.volatile()`, so the loader commits them into
// the live fiber. A change re-registers the skill: `ctx.skills.register()`
// returns its own disposer, and disposing then re-registering is the supported
// way to republish a runtime skill under edited content.

import Schema from '@deepseek-ai/schemastery'
import { guideRegistration } from './guide.mjs'

export const name = 'extra-skill-guide'

export const inject = ['skills']

export const Config = Schema.object({
  enabled: Schema.boolean().default(true)
    .description('Provide the built-in skill-create authoring guide to every session')
    .volatile(),
  customGuide: Schema.string().role('textarea').default('')
    .description('Replaces the built-in guide body when non-empty')
    .volatile(),
})

export function apply(ctx, config) {
  /** Disposer of the currently registered skill, when one is registered. */
  let disposeRegistered

  /**
   * Bring the registry in line with the current configuration. Registration is
   * idempotent by construction: the previous registration is always withdrawn
   * before a new one is attempted.
   */
  const sync = () => {
    disposeRegistered?.()
    disposeRegistered = undefined
    if (!config.enabled.get()) return
    disposeRegistered = ctx.skills.register(guideRegistration(config.customGuide.get()))
  }

  sync()
  ctx.effect(() => () => {
    disposeRegistered?.()
    disposeRegistered = undefined
  })
  ctx.on('loader/volatile-update', (paths) => {
    if (!Array.isArray(paths)) return
    if (!paths.some((path) => path[0] === 'enabled' || path[0] === 'customGuide')) return
    sync()
  })
}
