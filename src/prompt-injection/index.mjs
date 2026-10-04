// Host plugin: global prompt injection.
//
// The user writes one piece of standing text in settings and this plugin appends
// it as its own `user/message` before the next step of every session. It is not
// merged into the system prompt, so it stays separately visible in the session
// trajectory and is attributed to this plugin's own source kind.
//
// An empty text appends nothing, so clearing the field also switches injection
// off; the explicit `enabled` switch exists so one consolidated settings card can
// turn every feature of this package on and off the same way. Disabling it is not
// a silent stop: the text already injected is withdrawn through the same clearing
// path, so the model learns the earlier injection no longer applies.
//
// The value is read while each step is assembled, so a change applies to
// already-open sessions; only a real change appends, so unchanged steps never
// re-inject.
//
// The settings namespace is the profile entry id (equal to the exported `name`),
// and the form is derived from the exported `Config` schema: only fields marked
// `.volatile()` can be edited while running, and the loader commits a new value
// into the live fiber in place. That is why this plugin needs neither the
// `settings` service nor an `inject` list.

import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { injectionMessage, isInjectionSource, nextInjection, PROMPT_NAMESPACE } from './model.mjs'

export const name = PROMPT_NAMESPACE

/** Live-editable switch and injected text; `role('textarea')` renders it multi-line. */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true)
    .description('Inject the text below before every Session step')
    .volatile(),
  text: Schema.string().role('textarea').description('Injected before every Session step as its own context message').default('').volatile(),
})

/**
 * Read the injection body this plugin last made visible in one session.
 *
 * Only the current surface is scanned: an injection removed by compaction or
 * substitution is no longer sent to the model and therefore must be re-injected,
 * rather than skipped because it still appears in the log.
 *
 * @param session - the target session.
 * @param plugin - this plugin's `name`, used to recognise its own messages.
 * @returns the last visible injection body, or `null` when none is visible.
 */
function lastInjection(session, plugin) {
  for (const seq of session.surface.nodes.toReversed()) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const source = event.data.source
    if (!isInjectionSource(source, plugin)) continue
    const [block] = event.data.content
    return block?.type === 'text' ? block.text : null
  }
  return null
}

export function apply(ctx, config) {
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    // A disabled plugin wants no injection, which is exactly what an empty body
    // means here: the clearing path withdraws what was already sent, once.
    const wanted = config.enabled.get() ? config.text.get() : ''
    const text = nextInjection(lastInjection(agent.session, name), wanted)
    if (text === undefined) return decision
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage(injectionMessage(text, name))],
    }
  }, { prepend: true })
}
