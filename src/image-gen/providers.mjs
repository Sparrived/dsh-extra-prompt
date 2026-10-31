// Configured LLM providers, as far as the image tool needs them.
//
// The image tool speaks the same OpenAI-compatible protocol as many LLM gateway
// providers already configured in DSH. Reusing those routes avoids a second copy
// of the same endpoint and credential reference in this plugin's settings.
//
// A provider profile is resolved through the same two Host seams the official
// model settings use:
//
//   `ctx.llm.listConfigurableProviders()` names every provider route and where
//   its profile lives (`settingsNs` + `settingsPath`).
//   `ctx.settings.get(ns)` returns that namespace's resolved value.
//
// The profile shape is adapter-owned, but the two fields this tool needs are
// shared by the pi-ai and DeepSeek adapters: `baseURL` and `apiKeyEnv`. Only the
// reference is read; a credential value never enters this module's output.
//
// Tests drive this file with plain doubles, so it imports no Host package.

/** Trim a value that may be absent or not a string. */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Whether a value is a non-array object. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read a service through the non-injecting context accessor. */
function serviceOf(ctx, name) {
  if (typeof ctx?.get !== 'function') return undefined
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** Follow a settings path to the provider profile inside one namespace. */
function atPath(root, path) {
  let value = root
  for (const segment of path) {
    if (!isRecord(value) || typeof segment !== 'string') return undefined
    value = value[segment]
  }
  return value
}

/** Model ids advertised by a provider profile, for display and future pickers. */
function modelsOf(profile) {
  if (!Array.isArray(profile.models)) return []
  const models = []
  for (const entry of profile.models) {
    if (!isRecord(entry)) continue
    const id = textOf(entry.id)
    if (id === '') continue
    const name = textOf(entry.name) || id
    models.push({ id, name })
  }
  return models
}

/**
 * Turn one provider profile into the detached view this package exposes.
 *
 * `apiKeyEnv` is a credential reference, not a secret: it is the name the Host
 * resolves at request time. A profile without either field is still listed so
 * the settings page can show that the provider is incomplete; selecting it then
 * reports the missing endpoint instead of silently borrowing a manual one.
 *
 * @param provider - provider route key.
 * @param displayName - name from the directory entry or profile.
 * @param profile - resolved provider profile.
 * @param defaults - optional catalog defaults published beside the directory entry.
 * @returns a detached provider view.
 */
function viewOf(provider, displayName, profile, defaults = undefined) {
  // A catalog route often stores only the credential on its profile and leaves
  // the endpoint to the installed catalog. Some Host versions publish that
  // default on the directory entry; use it when the profile has no explicit
  // value, while still preferring the profile the user configured.
  const defaultBaseURL = isRecord(defaults) ? textOf(defaults.defaultBaseURL) : ''
  const nativeAuth = isRecord(defaults?.nativeAuth) ? defaults.nativeAuth : undefined
  const nativeEnv = isRecord(nativeAuth) ? textOf(nativeAuth.env) : ''
  return {
    provider,
    displayName: textOf(profile.displayName) || textOf(displayName) || provider,
    baseURL: textOf(profile.baseURL) || defaultBaseURL,
    apiKeyEnv: textOf(profile.apiKeyEnv) || nativeEnv,
    models: modelsOf(profile),
  }
}

/**
 * List every configured provider profile this Host can name.
 *
 * The configurable-provider directory is authoritative for routes that declare a
 * settings address. The settings descriptor scan is a deliberate fallback for a
 * Host without that directory (and a supplement for routes the directory does not
 * declare): it only inspects `llm-*` namespaces and their `providers` dictionaries,
 * so unrelated settings that happen to contain a `providers` key are ignored.
 *
 * @param ctx - plugin context with optional `llm` and `settings` services.
 * @returns detached provider views in directory order, then settings order.
 */
export function listConfiguredProviders(ctx) {
  const found = new Map()

  const add = (provider, displayName, profile, defaults = undefined) => {
    const id = textOf(provider)
    if (id === '' || found.has(id) || !isRecord(profile)) return
    found.set(id, viewOf(id, displayName, profile, defaults))
  }

  const llm = serviceOf(ctx, 'llm')
  const settings = serviceOf(ctx, 'settings')

  if (typeof llm?.listConfigurableProviders === 'function' && typeof settings?.get === 'function') {
    let entries
    try {
      entries = llm.listConfigurableProviders()
    } catch {
      entries = []
    }
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!isRecord(entry)) continue
      const ns = textOf(entry.settingsNs)
      const path = Array.isArray(entry.settingsPath) ? entry.settingsPath : []
      if (ns === '') continue
      let section
      try {
        section = settings.get(ns)
      } catch {
        section = undefined
      }
      add(entry.provider, entry.displayName, atPath(section, path), entry)
    }
  }

  if (typeof settings?.describe === 'function') {
    let descriptors
    try {
      descriptors = settings.describe()
    } catch {
      descriptors = []
    }
    for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
      if (!isRecord(descriptor) || typeof descriptor.ns !== 'string') continue
      if (!descriptor.ns.startsWith('llm-') || !isRecord(descriptor.value)) continue
      const providers = descriptor.value.providers
      if (!isRecord(providers)) continue
      for (const [provider, profile] of Object.entries(providers)) {
        add(provider, isRecord(profile) ? profile.displayName : undefined, profile)
      }
    }
  }

  return [...found.values()]
}

/**
 * Resolve the endpoint and credential reference used by one `image_gen` call.
 *
 * A selected provider owns both endpoint and credential reference; the manual
 * fields are used only when no provider is selected. An unknown provider is an
 * error rather than a silent fallback: a deleted provider must not send the
 * request to a stale manual endpoint.
 *
 * @param ctx - plugin context.
 * @param options - `provider`, `baseURL`, and `apiKeyEnv` from settings.
 * @returns the effective endpoint, credential reference, and provider metadata.
 */
export function resolveImageEndpoint(ctx, options = {}) {
  const provider = textOf(options.provider)
  const manualBaseURL = textOf(options.baseURL)
  const manualApiKeyEnv = textOf(options.apiKeyEnv)

  if (provider === '') {
    if (manualBaseURL === '') throw new Error('接口地址未配置，请填写 base URL 或选择一个已配置的供应商')
    return { provider: '', displayName: '', baseURL: manualBaseURL, apiKeyEnv: manualApiKeyEnv, models: [] }
  }

  const selected = listConfiguredProviders(ctx).find(entry => entry.provider === provider)
  if (selected === undefined) {
    throw new Error(`找不到已配置的供应商「${provider}」，请先在「设置 → 模型」里配置，或清除供应商选择`)
  }

  if (selected.baseURL === '') {
    throw new Error(`供应商「${provider}」没有配置 base URL，无法确定生图接口地址；请清除供应商选择后手动填写`)
  }

  return {
    provider: selected.provider,
    displayName: selected.displayName,
    baseURL: selected.baseURL,
    apiKeyEnv: selected.apiKeyEnv,
    models: selected.models,
  }
}
