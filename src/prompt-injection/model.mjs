// Pure text rules shared by the prompt-injection Host plugin and its tests.

/**
 * DSH settings namespace holding the injected text. The namespace is the
 * profile entry id, which is also this plugin's exported `name` and the
 * `source.kind` of every message it writes, so one identifier ties together the
 * settings form, the plugin row, and the session-trajectory attribution.
 */
export const PROMPT_NAMESPACE = 'extra-prompt-injection'

/**
 * Appended when injection is switched off.
 *
 * Injected content is durable session history: clearing the setting only stops
 * future appends and cannot rewrite an injection the model has already read. This
 * message tells the model that no injection is in effect, so clearing the field
 * takes effect instead of leaving stale instructions standing.
 */
export const CLEARED_INJECTION = 'Global prompt injection: none. Any earlier global prompt injection no longer applies.'

/** The block every injection is delivered in. */
const REMINDER_OPEN = '<system-reminder>'
const REMINDER_CLOSE = '</system-reminder>'

/**
 * Reduce a configured or already-delivered text to the body the user wrote.
 *
 * Settings may carry either a bare body or text wrapped in a `<system-reminder>`
 * block by hand (the only form earlier versions knew). Stripping one outer block
 * makes both forms compare equal, so automatic wrapping neither double-wraps an
 * old setting nor re-injects on every step because the delivered text carries
 * tags the setting does not.
 *
 * @param value - a configured text or the text of an already-injected message.
 * @returns the trimmed body without one outer reminder block.
 */
export function injectionBody(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text.startsWith(REMINDER_OPEN) || !text.endsWith(REMINDER_CLOSE)) return text
  return text.slice(REMINDER_OPEN.length, -REMINDER_CLOSE.length).trim()
}

/**
 * Wrap an injection body in the `<system-reminder>` block.
 *
 * A body that already carries the block is reduced first, so the block is added
 * exactly once even for settings written before wrapping became automatic. The
 * blank lines match the layout the previous hand-written configuration used.
 *
 * @param value - the configured text, with or without a hand-written block.
 * @returns the deliverable text; empty when there is no body to inject.
 */
export function systemReminderBlock(value) {
  const body = injectionBody(value)
  if (body === '') return ''
  return `${REMINDER_OPEN}\n\n${body}\n\n${REMINDER_CLOSE}`
}

/**
 * Compute the body to append for one step.
 *
 * The body becomes a `user/message` inside a `<system-reminder>` block and never
 * passes through system prompt template interpolation, so a `{{name}}` the user
 * wrote survives as written; only surrounding whitespace is trimmed.
 *
 * @param previous - the last injection text this plugin wrote into the session,
 *   or `null` when it has not injected yet.
 * @param value - the namespace's `text` field.
 * @returns the body to append; `undefined` means this step needs no injection.
 */
export function nextInjection(previous, value) {
  const text = injectionBody(value)
  // CLEARED_INJECTION *is* "no injection", so clearing twice does not append the
  // notice repeatedly. `injectionBody` also unwraps the delivered notice, which
  // is how a previous clear is recognised after automatic wrapping.
  const previousBody = previous == null ? '' : injectionBody(previous)
  const injected = previousBody === CLEARED_INJECTION ? '' : previousBody
  if (text === injected) return undefined
  return text === '' ? CLEARED_INJECTION : text
}

/**
 * Whether a message source was written by this plugin.
 *
 * Session format v4 no longer carries a shared `plugin` source kind: every
 * producer declares its own kind, and this plugin writes `extra-prompt-injection`.
 * Older logs wrapped the source in `plugin`, which the v3→v4 migration rewrites
 * to `plugin:<kind>`; both spellings must be recognised, or an already-injected
 * older session cannot be read back and clearing the setting would fail to
 * append the invalidation notice.
 *
 * @param source - the message's `source` record.
 * @param plugin - this plugin's `name`.
 * @returns whether the source belongs to this plugin.
 */
export function isInjectionSource(source, plugin) {
  if (source === null || typeof source !== 'object') return false
  return source.kind === plugin || source.kind === `plugin:${plugin}`
}

/**
 * Build the `user/message` payload to append.
 *
 * `source.kind` is this plugin's own producer kind and `form`/`sections` mirror
 * DSH's own runtime snapshots, so a client can render the message as a context
 * injection row instead of a user utterance. Both the model-visible content and
 * the section text carry the automatic `<system-reminder>` block, so the
 * trajectory shows the same text the model reads.
 *
 * @param text - the body from `nextInjection`.
 * @param plugin - the plugin's `name`.
 * @returns the content and source handed to `createUserMessage`.
 */
export function injectionMessage(text, plugin) {
  const block = systemReminderBlock(text)
  return {
    content: [{ type: 'text', text: block }],
    source: { kind: plugin, form: 'snapshot', sections: [{ name: plugin, text: block }] },
  }
}
