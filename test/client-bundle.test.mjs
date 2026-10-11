// Structural verification of the hand-written browser half.
//
// lib/client.js is authored by hand (the upstream `clientBundle()` tsdown preset
// is unpublished), so nothing would otherwise check that it loads, registers
// under the right module id, registers into the right slot, renders the fields it
// claims to, and writes exactly what the user staged. This harness runs the real
// artifact in a `node:vm` context with a minimal React and a stand-in for the
// host's settings kit, then walks the element tree it produces.
//
// What it deliberately does NOT cover: real React semantics, the host atoms' own
// rendering and styling, or the live round trip through the `settings` Remote.
// Those need a browser.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

import { normalizeServers, validateServers } from '../src/mcp/model.mjs'

const BUNDLE = new URL('../lib/client.js', import.meta.url)
const MANIFEST = new URL('../package.json', import.meta.url)
const PATCH = new URL('../cordis.patch.yml', import.meta.url)

/** The baseline externals the browser half is allowed to require. */
const BASELINE = ['react', '@deepseek-ai/dsh-client-ui-primitives']

/**
 * Every icon of the host's set this bundle is allowed to name, pinned.
 *
 * The bundle reads its glyphs from `@deepseek-ai/dsh-client-ui-primitives`
 * rather than drawing them, so these names are a dependency on the host: an icon
 * that gets renamed upstream stops resolving, and the page silently draws its
 * fallback outline instead. Pinning the list here means adding or renaming one
 * has to be re-read against the host's own export list rather than discovered as
 * a slightly-wrong-looking glyph.
 *
 * Verified against both clients this package targets — the vendored 0.1.7-rc.2
 * checkout (`packages/client/ui-primitives/src/icons/index.tsx`) and the
 * installed 0.2.0-rc.2 bundle, which share the `…OutlineRegular` surface and the
 * `{ size, className }` props.
 */
const HOST_ICON_NAMES = [
  'IconApiOutlineRegular',
  'IconArchiveOffOutlineRegular',
  'IconBranchOutlineRegular',
  'IconCheckCircleOutlineRegular',
  'IconChevronDownOutlineRegular',
  'IconChevronRightOutlineRegular',
  'IconClockOutlineRegular',
  'IconCompactOutlineRegular',
  'IconContextInjectionOutlineRegular',
  'IconFlatListOutlineRegular',
  'IconFolderOpenOutlineRegular',
  'IconRefreshOutlineRegular',
  'IconSkillOutlineRegular',
  'IconSlidersTwoOutlineRegular',
]

/**
 * Anything a font would draw as an emoji or as a text glyph standing in for art.
 *
 * The symbol ranges are the interesting half — U+2190–21FF arrows, U+2300–23FF
 * technical marks, U+25A0–27BF geometric shapes and dingbats, U+2B00–2BFF — and
 * they are exactly what a plain "emoji" check misses. Every glyph this page used
 * to draw as a font character lives there rather than in the emoji blocks:
 * U+1F4AC/U+1F489/U+1F9E9 and friends for the cards, U+2702 for compaction,
 * U+25B8/U+25BE for the advanced-settings disclosure, U+21BB for refresh, and
 * U+2713 for the no-rework notice.
 */
const PICTURE_GLYPH = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{24FF}\u{25A0}-\u{27BF}\u{2900}-\u{297F}\u{2B00}-\u{2BFF}\u{3030}\u{303D}\u{3297}\u{3299}\u{FE0F}\u{20E3}]/u

/** The namespaces the page is expected to edit, in page order. */
const NAMESPACES = [
  'extra-prompt-injection',
  'extra-subagent-routing',
  'extra-skill-installer',
  'extra-rtk-compact',
  'extra-mcp',
]

/**
 * The official allow-list namespace the routing card cross-checks. It is not one
 * of the page's own: the page reads it and must never write it.
 */
const OFFICIAL_NAMESPACE = 'subagent-model-selection-settings'

/**
 * The rtk card's note for a machine without rtk, spelled out rather than imported:
 * the test asserts the copy the user reads, so a reworded note has to be re-read
 * here.
 */
const RTK_MISSING_NOTICE = '本机没有找到 rtk 可执行文件，工具输出会原样通过；'
  + '装上 rtk（仓库见上方）或在本功能里指定 rtkPath 后才会压缩。'
  + '刚装完 rtk 时，DSH 要重启一次才会拿到新的 PATH。'

/** The note shown when the binary is there, spelled out for the same reason. */
const RTK_FOUND_PREFIX = '已找到 rtk：'

/**
 * The shared form frame's "this row is not mounted" copy, spelled out for the same
 * reason: it is what tells the user to go back to the 「插件」 page.
 */
const UNAVAILABLE_LABEL = '这一行没有挂载：在「插件」页打开它的开关后，这里才能编辑。'

/** The upstream address each card offers, pinned so a reworded link is re-read. */
const RTK_REPO = 'https://github.com/rtk-ai/rtk'

// --- a minimal React ---------------------------------------------------------

/** Flatten and drop the children React ignores (null/undefined/booleans). */
function flatten(items, out = []) {
  for (const item of items) {
    if (Array.isArray(item)) flatten(item, out)
    else if (item !== null && item !== undefined && typeof item !== 'boolean') out.push(item)
  }
  return out
}

function h(type, props, ...children) {
  const merged = Object.assign({}, props === null || props === undefined ? {} : props)
  const flat = flatten(children)
  if (flat.length > 0) merged.children = flat
  return { type, props: merged };
}

/**
 * A React stand-in with per-render-position hook cells.
 *
 * Cells are keyed by tree path so the five `Panel` instances — which share one
 * component function — keep separate state, and so the same path re-reads the
 * same cell on a later render pass. `useEffect` really runs (with a dependency
 * guard and cleanup), because `useForm` refreshes its snapshot and subscribes
 * to the ConfigForm from inside an effect: a no-op effect would freeze every
 * panel on its first-render values and the write assertions would be vacuous.
 */
let cells = new Map()
let pendingEffects = []
let stateDirty = false
/** Render position of the hook currently being called. */
let scope = null

function createReact() {
  cells = new Map()
  pendingEffects = []
  stateDirty = false
  scope = null
  return { createElement: h, useState, useEffect, useRef }
}

/**
 * A ref cell, held the way the others are so a later pass re-reads the same object.
 *
 * The managed-Skill card keeps its "still mounted" flag here: its removal request can
 * settle after the user switched tabs, and the flag is what stops the write.
 */
function useRef(initial) {
  const key = scope.path + '#' + (scope.index++)
  let cell = cells.get(key)
  if (cell === undefined) {
    cell = { value: { current: initial } }
    cells.set(key, cell)
  }
  return cell.value
}

function useState(initial) {
  const key = scope.path + '#' + (scope.index++)
  let cell = cells.get(key)
  if (cell === undefined) {
    cell = { value: typeof initial === 'function' ? initial() : initial }
    cells.set(key, cell)
  }
  return [cell.value, function (next) {
    const value = typeof next === 'function' ? next(cell.value) : next
    if (Object.is(value, cell.value)) return
    cell.value = value
    stateDirty = true
  }]
}

function sameDeps(previous, next) {
  if (previous === undefined || next === undefined) return false
  if (previous.length !== next.length) return false
  return previous.every((item, index) => Object.is(item, next[index]))
}

/** Run the effect after the pass, the way React commits effects after paint. */
function useEffect(callback, deps) {
  const key = scope.path + '#' + (scope.index++)
  const cell = cells.get(key)
  if (cell !== undefined && sameDeps(cell.deps, deps)) return
  pendingEffects.push(function () {
    if (cell !== undefined && typeof cell.cleanup === 'function') cell.cleanup()
    const cleanup = callback()
    cells.set(key, { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined })
  })
}

/**
 * A stable id per component function, so hook cells can be keyed by component as
 * well as by position.
 *
 * A position alone is not enough: the page renders a different component at the
 * same position in different tabs (a feature card and the Skill manager are both
 * the first child of a panel), and React would remount — new state — where a
 * path-only key would hand the second component the first one's cells.
 */
const componentIds = new WeakMap()
let nextComponentId = 0

function componentIdOf(type) {
  let id = componentIds.get(type)
  if (id === undefined) {
    id = 'c' + (nextComponentId++)
    componentIds.set(type, id)
  }
  return id
}

/** Render an element tree to host elements, invoking function components. */
function render(element, path) {
  if (element === null || element === undefined || typeof element !== 'object') return element
  if (Array.isArray(element)) return element.map((item, index) => render(item, path + '.' + index))
  // A `memo`/`forwardRef`/`lazy` component is an object carrying `$$typeof`, not a
  // function; React renders its inner type, so the harness unwraps it the same way
  // rather than mistaking it for a host element.
  if (element.type !== null && typeof element.type === 'object' && element.type.$$typeof !== undefined) {
    return render({ type: element.type.type, props: element.props }, path)
  }
  if (typeof element.type === 'function') {
    const previous = scope
    scope = { path: path + '@' + componentIdOf(element.type), index: 0 }
    try {
      return render(element.type(element.props), path)
    } finally {
      scope = previous
    }
  }
  // A host element still has to have its children rendered: nested function
  // components (the five panels, every field control) are invoked from here.
  const children = element.props.children
  if (children === undefined) return element
  return { type: element.type, props: Object.assign({}, element.props, { children: render(children, path) }) }
}

/** Every node in a rendered tree satisfying `predicate`, in document order. */
function findAll(node, predicate, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  findAll(node.props.children, predicate, out)
  return out
}

/** The concatenated text of a node's subtree. */
function textOf(node) {
  const out = []
  const walk = (value) => {
    if (typeof value === 'string' || typeof value === 'number') out.push(String(value))
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value !== null && typeof value === 'object') walk(value.props.children)
  }
  walk(node)
  return out.join('')
}

/**
 * Every host icon drawn inside a node, by name, in document order.
 *
 * The icon doubles mark themselves with `data-icon`; the page's own fallback
 * outline carries no marker, so `undefined` entries here mean the page drew a
 * glyph the host does not export.
 */
function iconsOf(node) {
  return findAll(node, item => item.type === 'svg').map(item => item.props['data-icon'])
}

/** The card of one namespace, addressed by its marker rather than by its copy. */
function sectionOf(tree, ns) {
  const section = findAll(tree, node => node.type === 'section' && node.props['data-namespace'] === ns)[0]
  assert.ok(section, `no settings card for namespace "${ns}"`)
  return section
}

/**
 * A named control inside one panel.
 *
 * Every panel renders its own save control, so a bare `[0]` would always address
 * the first card; scope the search to the section carrying the namespace marker
 * instead.
 */
function panelControl(tree, ns, predicate) {
  return findAll(sectionOf(tree, ns), predicate)[0]
}

// --- the host settings kit ---------------------------------------------------

/**
 * A stand-in for the atoms `lib/client.js` requires from
 * `@deepseek-ai/dsh-client-ui-primitives`. The real ones are React components
 * with the host's own CSS modules; what this suite checks is that the page hands
 * them the right props, so the doubles reproduce their prop contracts — including
 * the save control's disabled rule (`!dirty || invalid || saving`), the value
 * field's numeric keypad hint, and the button's separate `icon` slot — and
 * nothing more.
 *
 * The icon set is doubled too, with the real contract: a decorative 16x16
 * `currentColor` outline that contributes no text. Each carries a `data-icon`
 * marker so a test can assert which glyph a given spot drew, and
 * `options.missingIcon` drops one to exercise the page's fallback path.
 */
function createKit(options = {}) {
  const icons = {}
  for (const name of HOST_ICON_NAMES) {
    icons[name] = (props) => h('svg', {
      'data-icon': name,
      'aria-hidden': 'true',
      width: props.size,
      height: props.size,
      viewBox: '0 0 16 16',
    })
  }
  if (options.missingIcon !== undefined) delete icons[options.missingIcon]
  // A host that wraps its icons in `memo`/`forwardRef` hands the page an object
  // carrying `$$typeof` rather than a bare function. Modelled here so the page's
  // resolver can be held to accepting it.
  if (options.wrapIcon !== undefined) {
    icons[options.wrapIcon] = { $$typeof: Symbol.for('react.memo'), type: icons[options.wrapIcon] }
  }

  const Tag = (props) => h('span', { className: 'tag' }, props.children)
  const Button = (props) => h('button', {
    type: 'button',
    disabled: props.disabled === true,
    onClick: props.onClick,
  }, [
    // The real atom renders `{icon != null && <span className={css.icon}>{icon}</span>}`
    // ahead of its children, so a leading-icon assertion has to look where the
    // host puts it.
    props.icon === undefined || props.icon === null
      ? null
      : h('span', { key: 'icon', className: 'icon' }, props.icon),
    props.children,
  ])
  const Switch = (props) => h('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': props.checked === true,
    'aria-label': props.label,
    disabled: props.disabled === true,
    onClick: () => { props.onChange(!(props.checked === true)) },
  })
  const SettingsValueField = (props) => {
    const nodes = [h('div', { key: 'head' }, [
      h('label', { key: 'label', htmlFor: props.id }, props.label),
      props.overridden
        ? h('span', { key: 'badges' }, [
          h(Tag, { key: 'tag', tone: 'neutral' }, props.overriddenLabel),
          h('button', {
            key: 'reset', type: 'button', disabled: props.disabled, onClick: props.onReset,
          }, props.resetLabel),
        ])
        : null,
    ].filter(item => item !== null))]
    nodes.push(h('input', Object.assign({
      key: 'input',
      id: props.id,
      type: 'text',
      value: props.text,
      placeholder: props.placeholder === undefined ? '' : props.placeholder,
      disabled: props.disabled,
      onChange: (event) => { props.onEdit(event.target.value) },
    }, props.numeric === true ? { inputMode: 'numeric' } : {})))
    if (props.invalid) nodes.push(h('p', { key: 'invalid' }, props.invalidLabel))
    else if (props.hint) nodes.push(h('p', { key: 'hint' }, props.hint))
    return h('div', { className: 'value-field' }, nodes)
  }
  const SettingsForm = (props) => {
    if (!props.state.available) return h('p', { role: 'status' }, props.labels.unavailable)
    const footer = h('div', { key: 'footer' }, [
      props.state.failed ? h('p', { key: 'failed', role: 'status' }, props.labels.saveFailed) : null,
      h('button', {
        key: 'save',
        type: 'button',
        disabled: !props.state.dirty || props.state.invalid || props.state.saving,
        onClick: props.onSave,
      }, props.state.saving ? props.labels.saving : props.labels.save),
    ].filter(item => item !== null))
    return h('div', { className: 'settings-form' }, [
      props.state.writable ? null : h('p', { key: 'ro', role: 'status' }, props.labels.readOnly),
      props.children === undefined ? null : props.children,
      footer,
    ].filter(item => item !== null))
  }
  // The real SegmentedControl is a tablist whose owner holds the selection: each
  // option is a tab, a click reports its value, and the owner renders that tab's
  // panel. The double keeps the tab markers so tests can click tabs as a user
  // would, and only reports a change for a tab that is not already selected.
  const SegmentedControl = (props) => h('div', {
    role: 'tablist',
    'data-tabs': props.id,
    'aria-label': props.label,
  }, props.options.map(option => h('button', {
    key: option.value,
    type: 'button',
    role: 'tab',
    'data-tab': option.value,
    'aria-selected': option.value === props.value,
    disabled: props.disabled === true || option.disabled === true,
    onClick: () => { if (option.value !== props.value) props.onChange(option.value) },
  }, option.label)))
  return { SettingsForm, SettingsValueField, Switch, Tag, Button, SegmentedControl, ...icons }
}

// --- the loader + service doubles -------------------------------------------

/** A `document` double, so the stylesheet path runs and can be inspected. */
function makeDocument(dom) {
  const appended = []
  const head = { appendChild: (element) => { appended.push(element) } }
  return {
    appended,
    document: {
      head,
      getElementById: (id) => appended.find(element => element.id === id) ?? null,
      createElement: (tag) => ({ tag, id: '', textContent: '' }),
      querySelector: (selector) => (dom && typeof dom.querySelector === 'function' ? dom.querySelector(selector) : null),
      querySelectorAll: (selector) => (dom && typeof dom.querySelectorAll === 'function' ? dom.querySelectorAll(selector) : []),
    },
  }
}

/**
 * Scripted answers for the page's `/api/extra-prompt` calls, by operation name.
 *
 * An answer is the exact JSON body the Host would return. A missing entry rejects
 * the request, so a test that forgot to script an operation fails loudly instead of
 * reading an empty list it never asked for.
 */
let apiAnswers = new Map()
/** The settings-route requests the page issued, in order. */
let apiRequests = []

/** The browser `fetch` double: records the request and answers from the script. */
function settingsFetch(url, init) {
  const body = JSON.parse(init.body)
  apiRequests.push({ url, method: init.method, credentials: init.credentials, body })
  const answer = apiAnswers.get(body.op)
  if (answer === undefined) {
    return Promise.reject(new Error(`no scripted answer for the "${body.op}" operation`))
  }
  const value = typeof answer === 'function' ? answer(body) : answer
  return Promise.resolve({ json: () => Promise.resolve(value) })
}

/** Load the real artifact and return its registration. */
async function loadBundle(options = {}) {
  const source = await readFile(BUNDLE, 'utf8')
  const registrations = []
  const requested = []
  const kit = createKit(options)
  const React = createReact()
  const { document, appended } = makeDocument(options.dom)
  apiAnswers = new Map()
  apiRequests = []
  const sandbox = {
    document,
    // The page runs in a browser, so the standard host globals are present there.
    // `URL` is not a JS intrinsic, and the MCP card uses it to reject a URL that
    // embeds credentials.
    URL,
    // The managed-Skill card reads the Host over the settings route; the double
    // records every request so a test can assert the exact operation it sent.
    fetch: settingsFetch,
    window: { __ModuleLoader__: { load: (registration) => { registrations.push(registration) } } },
    require: (specifier) => {
      requested.push(specifier)
      if (specifier === 'react') return React
      if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return kit
      throw new Error(`the browser half must not require "${specifier}"`)
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })
  assert.equal(registrations.length, 1, 'the bundle must register exactly one factory')
  const plugin = registrations[0].factory(sandbox.require)
  return { registration: registrations[0], plugin, requested, appended }
}

/**
 * A ConfigForm double recording writes and notifying its subscriber.
 *
 * It also keeps the two layers the page reads apart: `base` is what a cleared
 * field reverts to, and `user` is the raw override layer whose mere presence
 * marks a field customized. A write moves the key in `value` and adds or removes
 * it from `user`, the way the Host document does.
 */
function makeForm(initial, options = {}) {
  const state = {
    status: options.status === undefined ? 'ready' : options.status,
    writable: options.writable === undefined ? true : options.writable,
    base: options.base === undefined ? {} : options.base,
    user: options.user,
    value: initial,
    revision: 1,
  }
  const calls = []
  const listeners = new Set()
  const publish = () => { listeners.forEach((listener) => { listener() }) }
  return {
    calls,
    getSnapshot: () => ({
      status: state.status,
      value: state.value,
      base: state.base,
      user: state.user,
      writable: state.writable,
      revision: state.revision,
    }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    async set(field, value) {
      calls.push({ op: 'set', field, value })
      state.value = Object.assign({}, state.value, { [field]: value })
      state.user = Object.assign({}, state.user === null || typeof state.user !== 'object' ? {} : state.user, { [field]: value })
      state.revision += 1
      publish()
      return true
    },
    async unset(field) {
      calls.push({ op: 'unset', field })
      const next = Object.assign({}, state.value)
      delete next[field]
      state.value = next
      if (state.user !== null && typeof state.user === 'object') {
        const layer = Object.assign({}, state.user)
        delete layer[field]
        state.user = layer
      }
      state.revision += 1
      publish()
      return true
    },
  }
}

/** A client context double exposing only the two injected services. */
function makeContext(values, options = {}) {
  const forms = {}
  for (const ns of NAMESPACES) {
    forms[ns] = makeForm(values[ns] === undefined ? {} : values[ns], options[ns] === undefined ? {} : options[ns])
  }
  // The delegation policy the routing card reads but must never write. Served by
  // default; a test that wants "nothing to compare against" asks for it.
  const officialForm = makeForm(
    values[OFFICIAL_NAMESPACE] === undefined ? {} : values[OFFICIAL_NAMESPACE],
    options[OFFICIAL_NAMESPACE] === undefined ? {} : options[OFFICIAL_NAMESPACE],
  )
  const awaited = []
  const registered = []
  const context = {
    configForms: { get: (ns) => (ns === OFFICIAL_NAMESPACE ? officialForm : forms[ns]) },
    slots: {
      inject: (name, callback) => { awaited.push({ name, callback }); return () => {} },
      register: (slotOptions, component) => { registered.push({ slotOptions, component }); return () => {} },
    },
  }
  return { context, forms, officialForm, awaited, registered }
}

/**
 * Boot the page: load, apply, resolve the injection, and register.
 *
 * @param values - committed settings value per namespace.
 * @param options - form status/writability/base/user overrides per namespace.
 * @param settings - `declare: false` leaves the `slots.inject` wait unresolved.
 */
async function boot(values, options, settings, bundleOptions) {
  const { registration, plugin, requested, appended } = await loadBundle(bundleOptions)
  const harness = makeContext(values === undefined ? {} : values, options)
  plugin.apply(harness.context)
  if (settings === undefined || settings.declare !== false) {
    for (const entry of harness.awaited) entry.callback()
  }
  return { registration, plugin, requested, appended, ...harness }
}

/**
 * The tab each namespace lives under, mirroring `TABS` in `lib/client.js`.
 *
 * The page renders one tab's cards at a time, so a test that reads a namespace's
 * fields has to select its tab first. Every group is always in the bar: which
 * rows are mounted is the 「插件」 page's business, not this page's.
 */
const TAB_OF = {
  'extra-prompt-injection': 'prompt',
  'extra-subagent-routing': 'routing',
  'extra-skill-installer': 'skill',
  'extra-rtk-compact': 'rtk',
  'extra-mcp': 'mcp',
}

/** Every tab button the page currently shows, in bar order. */
const tabsOf = (tree) => findAll(tree, node => node.props['data-tab'] !== undefined)

/**
 * Render the page and return its tree.
 *
 * Mirrors React's commit order: render, then run the effects that pass
 * scheduled, then render once more if an effect's `setState` landed (that is
 * how a panel picks up the snapshot `useForm`'s effect publishes). The loop is
 * bounded because the effect's dependency guard stops it re-scheduling.
 *
 * `at` names the namespace whose card the caller is about to read (or a raw tab
 * id); its tab is clicked first, exactly as a user would. Selecting is
 * idempotent — an already-selected tab is not clicked — so a call is
 * deterministic no matter which tab an earlier call left selected.
 */
function renderPage(registered, at) {
  const entry = registered.find(item => item.slotOptions.id === 'extra-prompt')
  assert.ok(entry, 'the page must register a settings.section entry with id "extra-prompt"')
  const commit = () => {
    let tree = null
    for (let pass = 0; pass < 8; pass++) {
      pendingEffects = []
      stateDirty = false
      tree = render(entry.component({ close: () => {} }), '0')
      const scheduled = pendingEffects
      pendingEffects = []
      if (scheduled.length === 0) break
      for (const task of scheduled) task()
      if (!stateDirty) break
    }
    return tree
  }
  let tree = commit()
  if (at === undefined) return tree
  const tabId = TAB_OF[at] ?? at
  const tab = tabsOf(tree).find(node => node.props['data-tab'] === tabId)
  if (tab !== undefined && tab.props['aria-selected'] !== true) {
    tab.props.onClick()
    tree = commit()
  }
  return tree
}

/** Let the promise chain inside a save handler settle. */
const settle = () => new Promise((resolve) => { setImmediate(resolve) })

/**
 * Render the conversation dashboard tab and return its tree.
 *
 * The same commit loop as `renderPage`, for the package's other slot: the
 * dashboard's fetch effect has to run and its `setState` has to land before a
 * later render carries the data.
 */
function renderConversationDashboard(registered, props) {
  const entry = registered.find(item => item.slotOptions.name === 'conversation.view' && item.slotOptions.id === 'dashboard')
  assert.ok(entry, 'the package must register the conversation dashboard tab')
  let tree = null
  for (let pass = 0; pass < 8; pass++) {
    pendingEffects = []
    stateDirty = false
    tree = render(entry.component(props), '0')
    const scheduled = pendingEffects
    pendingEffects = []
    if (scheduled.length === 0) break
    for (const task of scheduled) task()
    if (!stateDirty) break
  }
  return tree
}

/**
 * Strip the `vm` realm's prototypes so values built inside the sandbox compare
 * equal to plain literals — `deepStrictEqual` otherwise rejects them as
 * "same structure but not reference-equal".
 */
const plain = (value) => JSON.parse(JSON.stringify(value))

/** The save control of one card, if that card is editable at all. */
const saveOf = (registered, ns) => panelControl(
  renderPage(registered, ns),
  ns,
  node => node.type === 'button' && (textOf(node) === '保存' || textOf(node) === '保存中…'),
)

/** Every switch the page currently renders. */
const switchesOf = (tree) => findAll(tree, node => node.props.role === 'switch')

// --- tests -------------------------------------------------------------------

test('registers one factory under the package name, requiring only baseline externals', async () => {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  const { registration, plugin, requested } = await boot()
  // The module table — and therefore the /plugins/<id>/client.js route — is keyed
  // by package name, so a mismatch makes the browser refuse the bundle.
  assert.equal(registration.id, manifest.name)
  // Requiring anything outside the shell's baseline would need a module-table
  // request this package does not declare, and the factory's `require` is
  // synchronous: it would throw on the spot.
  assert.deepEqual(requested, BASELINE)
  assert.deepEqual(plain(plugin.inject), ['slots', 'configForms'])
})

test('labels the page with the package name and version, and names where the switches are', async () => {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  const { registered } = await boot()
  const intro = findAll(renderPage(registered), node => node.props.className === 'dsh-extra-intro')[0]
  // The artifact is hand-written with no build step, so this label is the only
  // place the version is duplicated; keep it honest.
  assert.ok(textOf(intro).startsWith(`${manifest.name} ${manifest.version}`))
  // The one thing this page cannot show: a feature is switched on and off on the
  // 「插件」 page, one row each.
  assert.ok(textOf(intro).includes('「插件」页'))
})

test('waits for the settings.section and conversation.view declarations instead of racing them', async () => {
  const { awaited, registered } = await boot({}, {}, { declare: false })
  // A bare `slots.register` into an undeclared slot throws; `slots.inject` is the
  // only correct way to contribute to a slot another package declares.
  assert.deepEqual(awaited.map(entry => entry.name), ['settings.section', 'conversation.view'])
  assert.equal(registered.length, 0, 'nothing may register before the declaration arrives')
  awaited[0].callback()
  assert.equal(registered.length, 1)
  assert.deepEqual(plain(registered[0].slotOptions), {
    name: 'settings.section',
    id: 'extra-prompt',
    order: 30,
    label: '提示词与技能',
  })
  awaited[1].callback()
  assert.equal(registered.length, 2)
  assert.deepEqual(plain(registered[1].slotOptions), {
    name: 'conversation.view',
    id: 'dashboard',
    order: 20,
    label: '看板',
  })
})

test('styles itself through design tokens only', async () => {
  const { appended } = await boot()
  assert.equal(appended.length, 1, 'the stylesheet is injected exactly once')
  assert.equal(appended[0].tag, 'style')
  assert.equal(appended[0].id, 'dsh-extra-prompt-styles')
  // Theme-facing values must resolve through the host's aliases: a literal colour
  // would keep rendering the light-mode value under the dark theme.
  assert.ok(appended[0].textContent.includes('--dsw-alias-'))
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(appended[0].textContent), false, 'no literal colours')
})

/**
 * The card each settings namespace draws under its title.
 *
 * Spelled out rather than derived: which glyph a card wears is a judgement about
 * what the card means, so a changed icon should have to be re-read here.
 */
const CARD_ICON_OF = {
  'extra-prompt-injection': 'IconContextInjectionOutlineRegular',
  'extra-subagent-routing': 'IconBranchOutlineRegular',
  'extra-skill-installer': 'IconSkillOutlineRegular',
  'extra-rtk-compact': 'IconCompactOutlineRegular',
  'extra-mcp': 'IconApiOutlineRegular',
}

test('names only host icons from the pinned set, and actually draws them', async () => {
  const { plugin, registered } = await boot()
  const named = Object.values(plain(plugin.HOST_ICON_NAMES))
  // Pinned, because these names are a dependency on the host's own export list:
  // a name it does not have is not an error anywhere until it is rendered, and
  // the page then quietly draws a neutral outline instead of the intended glyph.
  assert.deepEqual([...named].sort(), HOST_ICON_NAMES)
  assert.equal(new Set(named).size, named.length, 'no icon may be named twice')

  // The page heading and every feature card carry a host icon — none of them is
  // left empty, which is what a key missing from HOST_ICON_NAMES would look like.
  const heading = findAll(renderPage(registered), node => node.props.className === 'dsh-extra-heading')[0]
  assert.deepEqual(iconsOf(heading), ['IconSlidersTwoOutlineRegular'])
  // Sizes come from the host's own precedent rather than from eyeballing: 16px is
  // the size the host uses for a card/section glyph, and the grid is its 16x16 box.
  const headingIcon = findAll(heading, node => node.type === 'svg')[0]
  assert.equal(headingIcon.props.width, 16)
  assert.equal(headingIcon.props.height, 16)
  assert.equal(headingIcon.props.viewBox, '0 0 16 16')
  assert.equal(headingIcon.props['aria-hidden'], 'true')

  for (const [ns, icon] of Object.entries(CARD_ICON_OF)) {
    const title = findAll(renderPage(registered, ns), node => node.props.className === 'dsh-extra-title')[0]
    assert.ok(title, `no card title for "${ns}"`)
    assert.deepEqual(iconsOf(title), [icon], `the "${ns}" card must draw its own icon`)
    assert.equal(findAll(title, node => node.type === 'svg')[0].props.width, 16, `card icons are title-scale`)
    // The title is a text node plus a decorative glyph, so the name is still the
    // accessible label rather than an image.
    assert.ok(textOf(title).trim().length > 0, 'the card title keeps its text')
  }
})

test('renders no picture glyphs, in its source or on the page', async () => {
  // The artifact and the Host-side model that feeds it: neither may carry a
  // symbol standing in for art. The model is here because it used to prefix its
  // own badges with one.
  for (const url of [BUNDLE, new URL('../src/session-dashboard/model.mjs', import.meta.url)]) {
    const source = await readFile(url, 'utf8')
    // A narrow allow-list of the punctuation the copy legitimately uses is not
    // needed: nothing in either file is meant to be outside ASCII, CJK, and the
    // handful of typographic marks the ranges above exclude.
    const found = [...new Set(source.match(new RegExp(PICTURE_GLYPH, 'gu')) ?? [])]
    assert.deepEqual(found, [], `${url.pathname} must draw no picture glyph`)
  }

  const { registered } = await boot()
  // Every group's cards, then the dashboard with data that reaches each spot that
  // used to hold a glyph (meta tags, refresh control, synergy tiles, the
  // no-rework notice, and one lifecycle event of every kind).
  for (const ns of Object.keys(CARD_ICON_OF)) {
    assert.deepEqual(textOf(renderPage(registered, ns)).match(new RegExp(PICTURE_GLYPH, 'gu')) ?? [], [])
  }
  assert.deepEqual(
    textOf(renderPage(registered, 'skill')).match(new RegExp(PICTURE_GLYPH, 'gu')) ?? [],
    [],
    'the Skill manager card is not a namespace and must be checked too',
  )

  apiAnswers.set('dashboard/data', {
    ok: true,
    value: {
      session: { id: 'sess-glyphs', title: '图标回归', cwd: 'D:/Code/icons' },
      summary: {
        eventCount: 3, messages: 2, userMessages: 1, assistantMessages: 1, turns: 2, steps: 2,
        toolCalls: 1, toolResults: 1, toolFailures: 0,
        firstEventTime: 1710000000000, lastEventTime: 1710000060000, elapsedMs: 60000,
      },
      stats: { llmMs: 40000, toolMs: 10000, ttftMs: 900, decodeMs: 38000, decodeTokens: 1500 },
      token: {
        totals: {
          inputTokens: 4000, outputTokens: 1500, reasoningTokens: 600, totalTokens: 5500,
          uncachedInputTokens: 1000, cacheReadTokens: 3000, cacheWriteTokens: 0, cacheHitRate: 75,
        },
        points: [],
      },
      // No repeated commands, so the notice that used to end in U+2713 renders.
      cost: {
        toolCalls: 1, toolFailures: 0, toolErrorRate: 0, retries: 0, retriedSteps: 0,
        wastedTurns: 0, wastedSteps: 0, wastedToolCalls: 0, distinctCommands: 3,
        repeatedCommands: [], repeatedCommandCalls: 0, repeatedCommandRate: 0,
        tools: [], turns: [],
      },
      turns: [],
      context: {
        events: [
          { seq: 1, turn: 1, step: 1, kind: 'inject', badge: '注入', title: '额外提示词规则注入', details: '注入提示词', deltaTokens: 120 },
          { seq: 2, turn: 1, step: 1, kind: 'prune', badge: '剪枝', title: '工具 [read] 输出剪枝', details: '截断超长返回', deltaTokens: -800 },
          { seq: 3, turn: 2, step: 1, kind: 'compact', badge: '压缩', title: '第 2 轮 上下文自动压缩', details: '释放了 1.2k Tokens', deltaTokens: -1200 },
        ],
      },
    },
  })
  renderConversationDashboard(registered, { sessionId: 'sess-glyphs' })
  await settle()
  await settle()
  const dashboard = renderConversationDashboard(registered, { sessionId: 'sess-glyphs' })
  assert.deepEqual(textOf(dashboard).match(new RegExp(PICTURE_GLYPH, 'gu')) ?? [], [])

  // ...and the glyphs came back as icons: the meta tags, the refresh control, the
  // four synergy tiles, the no-rework notice, and the three lifecycle kinds.
  const drawn = iconsOf(dashboard)
  assert.ok(drawn.includes('IconFolderOpenOutlineRegular'), 'the cwd tag draws a folder')
  assert.ok(drawn.includes('IconFlatListOutlineRegular'), 'the event-count tag draws a list')
  assert.ok(drawn.includes('IconClockOutlineRegular'), 'the duration tag draws a clock')
  assert.ok(drawn.includes('IconRefreshOutlineRegular'), 'the refresh control draws a refresh icon')
  assert.ok(drawn.includes('IconCheckCircleOutlineRegular'), 'the no-rework notice draws a check')
  assert.ok(drawn.includes('IconCompactOutlineRegular'), 'rtk tiles and compact events draw the compact icon')
  assert.ok(drawn.includes('IconApiOutlineRegular'), 'the MCP tile draws the MCP icon')
  assert.ok(drawn.includes('IconContextInjectionOutlineRegular'), 'the prompt tile draws the injection icon')
  assert.ok(drawn.includes('IconSkillOutlineRegular'), 'the skills tile draws the skill icon')
  assert.ok(drawn.includes('IconArchiveOffOutlineRegular'), 'a prune event draws the prune icon')

  // Sizes follow the host's own usage: 12px for inline meta and control glyphs
  // (its `IconClockOutlineRegular size={12}`, `IconRefreshOutlineRegular size={12}`,
  // `IconCheckOutlineRegular size={12}`), and 10px inside the event badges, which
  // are the tightest spot on the page — the host's own smallest chip glyphs are
  // `IconCloseOutlineRegular size={10}`.
  const firstWith = (name) => findAll(dashboard, node => node.type === 'svg' && node.props['data-icon'] === name)[0]
  assert.equal(firstWith('IconFolderOpenOutlineRegular').props.width, 12)
  assert.equal(firstWith('IconFlatListOutlineRegular').props.width, 12)
  assert.equal(firstWith('IconClockOutlineRegular').props.width, 12)
  assert.equal(firstWith('IconRefreshOutlineRegular').props.width, 12)
  assert.equal(firstWith('IconCheckCircleOutlineRegular').props.width, 12)

  const pruneBadge = findAll(dashboard, node => typeof node.props.className === 'string'
    && node.props.className.includes('dsh-dash-event-badge')
    && node.props.className.includes('dsh-badge-prune'))[0]
  assert.ok(pruneBadge, 'the prune event row must render')
  const pruneBadgeIcon = findAll(pruneBadge, node => node.type === 'svg')[0]
  assert.equal(pruneBadgeIcon.props['data-icon'], 'IconArchiveOffOutlineRegular')
  assert.equal(pruneBadgeIcon.props.width, 10)

  // The badge keeps its own word for what happened, so the model stays readable
  // without the glyph it no longer ships.
  assert.ok(textOf(dashboard).includes('剪枝'))
  assert.ok(textOf(dashboard).includes('压缩'))
})

test('drops a picture glyph that arrives inside an event badge over the wire', async () => {
  // The event badge is the one piece of this page's text that comes from the wire,
  // and the row already draws an icon for `kind` beside it. So a producer still
  // sending the old `'<scissors> 压缩'` would put a font glyph *and* an icon on one
  // row — exactly the double-drawing this page no longer does. The renderer is the
  // last place that can refuse it, so it refuses it here. Built from codepoints so
  // this file stays free of the glyphs it is defending against.
  const SCISSORS = String.fromCodePoint(0x2702)
  const SYRINGE = String.fromCodePoint(0x1F489)

  const { registered } = await boot()
  apiAnswers.set('dashboard/data', {
    ok: true,
    value: {
      session: { id: 'sess-stale-badge', title: '旧徽章' },
      summary: { eventCount: 3, turns: 2, steps: 2, elapsedMs: 60000 },
      stats: {},
      token: { totals: { inputTokens: 4000, outputTokens: 1500, totalTokens: 5500 }, points: [] },
      cost: {
        toolCalls: 1, toolFailures: 0, distinctCommands: 0, repeatedCommands: [],
        repeatedCommandCalls: 0, repeatedCommandRate: 0, tools: [], turns: [],
      },
      turns: [],
      context: {
        events: [
          { seq: 1, turn: 1, step: 1, kind: 'compact', badge: SCISSORS + ' 压缩', title: '压缩', details: '释放了 1.2k Tokens', deltaTokens: -1200 },
          { seq: 2, turn: 1, step: 1, kind: 'prune', badge: SCISSORS + ' 剪枝', title: '剪枝', details: '截断超长返回', deltaTokens: -800 },
          { seq: 3, turn: 2, step: 1, kind: 'inject', badge: SYRINGE + ' 注入', title: '注入', details: '注入提示词', deltaTokens: 120 },
        ],
      },
    },
  })
  renderConversationDashboard(registered, { sessionId: 'sess-stale-badge' })
  await settle()
  await settle()
  const dashboard = renderConversationDashboard(registered, { sessionId: 'sess-stale-badge' })

  const text = textOf(dashboard)
  assert.deepEqual(text.match(new RegExp(PICTURE_GLYPH, 'gu')) ?? [], [],
    'a stale badge glyph must never reach the page')
  // The label survives the strip, so the row still says what happened...
  for (const label of ['压缩', '剪枝', '注入']) assert.ok(text.includes(label), `the "${label}" badge keeps its label`)
  // ...and the icon is still the one that carries the meaning.
  const drawn = iconsOf(dashboard)
  assert.ok(drawn.includes('IconCompactOutlineRegular'))
  assert.ok(drawn.includes('IconArchiveOffOutlineRegular'))
  assert.ok(drawn.includes('IconContextInjectionOutlineRegular'))
})

test('degrades one missing host icon to a neutral outline instead of failing the page', async () => {
  const { registered } = await boot({}, {}, {}, { missingIcon: 'IconSkillOutlineRegular' })
  const title = findAll(renderPage(registered, 'extra-skill-installer'), node => node.props.className === 'dsh-extra-title')[0]
  assert.ok(title, 'the card still renders without its host icon')

  const drawn = findAll(title, node => node.type === 'svg')
  assert.equal(drawn.length, 1, 'the card still draws exactly one glyph')
  // The fallback is drawn, not borrowed: no host marker, the host's own 16x16
  // box and `currentColor` stroke. A missing component handed to `createElement`
  // would instead have thrown "Element type is invalid" and taken the whole
  // settings section down.
  assert.equal(drawn[0].props['data-icon'], undefined)
  assert.equal(drawn[0].props.viewBox, '0 0 16 16')
  assert.equal(drawn[0].props.fill, 'none')
  assert.ok(textOf(title).includes('Skill 安装'), 'the card keeps its title')
})

test('accepts a host icon wrapped in memo/forwardRef rather than falling back', async () => {
  const { registered } = await boot({}, {}, {}, { wrapIcon: 'IconCompactOutlineRegular' })
  const title = findAll(renderPage(registered, 'extra-rtk-compact'), node => node.props.className === 'dsh-extra-title')[0]
  // A wrapper object is still a component type. Treating it as missing would
  // downgrade every icon to the fallback the day the host memoises them, which
  // looks like a broken theme rather than a broken lookup.
  assert.deepEqual(iconsOf(title), ['IconCompactOutlineRegular'])
})

test('the page edits exactly the namespaces the shipped rows mount', async () => {
  const patch = await readFile(PATCH, 'utf8')
  const rowNames = [...patch.matchAll(/^\s*name:\s*'(dsh-extra-prompt(?:\/[^']*)?)'/gm)].map(match => match[1])
  // Every settings row is named after the namespace it configures, so the page's
  // list and the patch's rows have to agree field for field. Three rows are
  // deliberately nameless: the bare row carries this browser half, the settings
  // page's data channel exists to answer the page rather than to hold settings, and
  // the Tavily search row only registers a tool.
  assert.deepEqual(rowNames, ['dsh-extra-prompt']
    .concat(NAMESPACES.map(ns => 'dsh-extra-prompt/' + ns.slice('extra-'.length)))
    .concat(['dsh-extra-prompt/settings-api', 'dsh-extra-prompt/web-search-tavily']))
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  for (const ns of NAMESPACES) {
    assert.ok(manifest.exports['./' + ns.slice('extra-'.length)], `${ns} needs an exports subpath`)
  }
  const probe = await boot()
  assert.deepEqual(Object.keys(probe.forms), NAMESPACES)
})

test('renders every declared field for every namespace', async () => {
  const { registered } = await boot({
    'extra-rtk-compact': { rtkPath: '', minBodyChars: 1200, timeoutMs: 20000, maxOutputBytes: 4194304, gitStatus: true, gitDiff: true, gitLog: true, rg: true, grep: true },
    'extra-subagent-routing': { routes: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro', note: '疑难推理' }], guidance: '' },
  })

  // The page holds no switch of its own: every feature is a row, switched on the
  // 「插件」 page, and this page only ever configures what is mounted.
  const page = renderPage(registered)
  assert.equal(findAll(page, node => node.props['data-namespace'] === 'enable').length, 0)

  // Five groups: prompt / routing / skill (two namespaces) / rtk / mcp. The
  // statistics dashboard has no settings group: it lives in the conversation view.
  assert.deepEqual(tabsOf(page).map(node => node.props['data-tab']), ['prompt', 'routing', 'skill', 'rtk', 'mcp'])
  assert.deepEqual(tabsOf(page).map(node => textOf(node)), ['提示词', '子代理路由', '技能', '输出压缩', 'MCP'])

  // Only the active group's cards are in the tree.
  assert.equal(findAll(page, node => node.props['data-namespace'] === 'extra-rtk-compact').length, 0)

  // The prompt group: one long-text field.
  const prompt = renderPage(registered, 'extra-prompt-injection')
  assert.equal(findAll(prompt, node => node.type === 'textarea').length, 1)

  // The routing group: one editable row plus the add control.
  const routing = renderPage(registered, 'extra-subagent-routing')
  assert.equal(findAll(routing, node => node.props['aria-label'] === 'provider').length, 1)
  assert.ok(textOf(routing).includes('添加一条路由'))

  // The skill group holds its one feature's card: a text field for the default ref
  // and the page's one enum. The feature's own switch is its row, not a field here.
  const skill = renderPage(registered, 'extra-skill-installer')
  assert.equal(findAll(skill, node => node.props['data-namespace'] === 'extra-skill-installer').length, 1)
  assert.equal(findAll(skill, node => node.type === 'textarea').length, 0)
  // The installer card owns the page's one enum.
  const selects = findAll(skill, node => node.type === 'select')
  assert.equal(selects.length, 1)
  assert.deepEqual(selects[0].props.children.map(option => option.props.value), ['auto', 'download', 'git'])
  assert.equal(switchesOf(skill).length, 0)

  // The rtk group: one text input (rtkPath), three numeric fields, five filter
  // switches, and no enum of its own.
  const rtk = renderPage(registered, 'extra-rtk-compact')
  assert.equal(findAll(rtk, node => node.type === 'input' && node.props.inputMode !== 'numeric').length, 1)
  const numeric = findAll(rtk, node => node.type === 'input' && node.props.inputMode === 'numeric')
  assert.equal(numeric.length, 3)
  assert.deepEqual(numeric.map(node => node.props.value), ['1200', '20000', '4194304'])
  const switches = switchesOf(rtk)
  assert.equal(switches.length, 5, 'the five rtk filter switches; the feature switch is the row')
  assert.ok(switches.every(node => node.props['aria-checked'] === true))
  assert.equal(findAll(rtk, node => node.type === 'select').length, 0)

  // The MCP group: an empty list until a server is added, and adding one is the
  // only thing the empty state offers.
  const mcp = renderPage(registered, 'extra-mcp')
  assert.equal(findAll(mcp, node => node.props['data-namespace'] === 'extra-mcp').length, 1)
  assert.ok(textOf(mcp).includes('还没有配置任何 MCP 服务器。'))
  assert.ok(textOf(mcp).includes('添加服务器'))
  assert.equal(findAll(mcp, node => node.props.className === 'dsh-extra-server').length, 0)
})

test('the MCP card edits one entry per server and refuses a list it cannot run', async () => {
  const entry = {
    serverName: 'github',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: 'token' },
    cwd: '',
    url: '',
    headers: {},
    toolCallTimeoutMs: 60000,
    maxInstructionBytes: 32768,
    failOnStartupError: false,
    reconnectEnabled: true,
    reconnectInitialDelayMs: 500,
    reconnectMaxDelayMs: 30000,
    reconnectMaxAttempts: 10,
  }
  const { registered, forms } = await boot({ 'extra-mcp': { enabled: true, servers: [entry] } })
  const at = () => renderPage(registered, 'extra-mcp')
  const labelled = (tree, label) => findAll(tree, node => node.props['aria-label'] === label)
  const cards = (tree) => findAll(tree, node => node.props.className === 'dsh-extra-server')

  assert.equal(cards(at()).length, 1)
  assert.equal(labelled(at(), '服务器名')[0].props.value, 'github')
  assert.equal(labelled(at(), '环境变量 名称')[0].props.value, 'GITHUB_TOKEN')
  assert.equal(labelled(at(), '环境变量 值')[0].props.value, 'token')
  // A stdio entry has no HTTP endpoint, and the card says so by not rendering one.
  assert.equal(labelled(at(), 'url').length, 0)
  assert.equal(switchesOf(at())[0].props['aria-checked'], true, 'the entry carries its own switch')

  // Switching the transport swaps which fields exist at all. The new URL is
  // empty, so the card blocks the save until it is filled in rather than writing
  // a server that cannot connect.
  labelled(at(), '传输方式')[0].props.onChange({ target: { value: 'streamable-http' } })
  assert.equal(labelled(at(), 'command').length, 0)
  assert.equal(labelled(at(), 'url').length, 1)
  assert.equal(saveOf(registered, 'extra-mcp').props.disabled, true, 'a missing URL blocks the save')
  labelled(at(), 'url')[0].props.onChange({ target: { value: 'https://mcp.example/mcp' } })
  assert.equal(saveOf(registered, 'extra-mcp').props.disabled, false)

  // A second entry whose name repeats the first is refused: the name is also the
  // tool namespace, so the Host would reject the composition.
  findAll(at(), node => node.type === 'button' && textOf(node) === '添加服务器')[0].props.onClick()
  assert.equal(cards(at()).length, 2)
  labelled(at(), '服务器名')[1].props.onChange({ target: { value: 'github' } })
  assert.equal(saveOf(registered, 'extra-mcp').props.disabled, true, 'a duplicate name blocks the save')
  assert.ok(textOf(at()).includes('重复'))
  labelled(at(), '服务器名')[1].props.onChange({ target: { value: 'github-2' } })
  // The duplicate is gone, but an entry the user just added is still incomplete:
  // it starts switched off with no command, and the card says so.
  assert.equal(saveOf(registered, 'extra-mcp').props.disabled, true, 'a new entry still needs a command')
  assert.ok(textOf(at()).includes('stdio 服务器必须填写启动命令。'))
  // Only the second entry is stdio now, so it owns the list's one command field.
  assert.equal(labelled(at(), 'command').length, 1)
  labelled(at(), 'command')[0].props.onChange({ target: { value: 'npx' } })
  assert.equal(saveOf(registered, 'extra-mcp').props.disabled, false)

  // Removing the second entry leaves the first untouched.
  findAll(at(), node => node.type === 'button' && textOf(node) === '删除')[1].props.onClick()
  assert.equal(cards(at()).length, 1)
  assert.equal(labelled(at(), '服务器名')[0].props.value, 'github')

  // Saving writes the whole list, and only once the card is clean.
  saveOf(registered, 'extra-mcp').props.onClick()
  await settle()
  const writes = forms['extra-mcp'].calls.filter(call => call.field === 'servers')
  assert.equal(writes.length, 1, 'the list is one field, written once')
  assert.equal(writes[0].op, 'set')
  assert.equal(writes[0].value.length, 1)
  assert.equal(writes[0].value[0].serverName, 'github')
  assert.equal(writes[0].value[0].transport, 'streamable-http')
  assert.equal(writes[0].value[0].url, 'https://mcp.example/mcp')
  assert.equal(saveOf(registered, 'extra-mcp').props.disabled, true, 'the draft is dropped once accepted')
})

test('the MCP card says each problem once, beside the control that has it', async () => {
  const { registered } = await boot({
    'extra-mcp': {
      enabled: true,
      servers: [{ serverName: 'bad name', enabled: false, transport: 'stdio', command: '', env: {} }],
    },
  })
  const tree = renderPage(registered, 'extra-mcp')
  const card = findAll(tree, node => node.props.className === 'dsh-extra-server')[0]
  const text = textOf(card)

  // Every message is stated exactly once. The card used to repeat the whole issue
  // list under the entry as well, which doubled the red text without adding anything.
  const occurrences = (needle) => text.split(needle).length - 1
  const NAME_ISSUE = '名称只能包含字母、数字、下划线和连字符，长度 1–32。'
  const COMMAND_ISSUE = 'stdio 服务器必须填写启动命令。'
  assert.equal(occurrences(NAME_ISSUE), 1)
  assert.equal(occurrences(COMMAND_ISSUE), 1)

  // The name has no field wrapper of its own, so its message sits directly under the
  // head — and before the body, next to the input it is about.
  const invalid = findAll(card, node => typeof node.props.className === 'string'
    && node.props.className.split(' ').includes('dsh-extra-invalid'))
  assert.deepEqual(invalid.map(node => textOf(node)), [NAME_ISSUE, COMMAND_ISSUE])
  assert.equal(
    findAll(card, node => node.props['aria-label'] === '服务器名')[0].props['aria-invalid'],
    true,
  )
})

test('the MCP card pairs only like controls, and reads as a labelled list', async () => {
  const { registered } = await boot({
    'extra-mcp': {
      enabled: true,
      servers: [{ serverName: 'github', enabled: true, transport: 'stdio', command: 'npx', env: {} }],
    },
  })
  const tree = renderPage(registered, 'extra-mcp')
  const card = findAll(tree, node => node.props.className === 'dsh-extra-server')[0]
  const labelled = (node, label) => findAll(node, item => item.props['aria-label'] === label)

  // Two single-line inputs share a line; the textarea and the bindings editor span
  // the card rather than sitting beside a control of a different height.
  const rows = findAll(card, node => node.props.className === 'dsh-extra-serverRow')
  assert.equal(rows.length, 1)
  assert.equal(labelled(rows[0], 'command').length, 1)
  assert.equal(labelled(rows[0], 'cwd').length, 1)
  assert.equal(findAll(card, node => node.type === 'textarea').length, 1)
  assert.equal(rows[0].props.children.length, 2)

  // The bindings editor is a labelled block: its name and its "add" control share
  // one head line, and the plaintext note reads as a hint rather than as content.
  const heads = findAll(card, node => node.props.className === 'dsh-extra-bindingsHead')
  assert.equal(heads.length, 1)
  assert.ok(textOf(heads[0]).includes('环境变量'))
  assert.deepEqual(findAll(heads[0], node => node.type === 'button').map(node => textOf(node)), ['添加一行'])
  assert.ok(textOf(card).includes('没有条目。'))
  assert.ok(textOf(card).includes('值以明文保存在 profile 的 cordis.patch.yml 中。'))

  // The field's own explanation comes before the editor, not under its add button.
  const section = sectionOf(tree, 'extra-mcp')
  const sectionText = textOf(section)
  const help = sectionText.indexOf('只有已启用的服务器会被连接')
  assert.ok(help >= 0)
  assert.ok(help < sectionText.indexOf('添加服务器'))

  // A transport is named by one word on the head row; what it means is the option's
  // tooltip, which is what kept the row from wrapping.
  const select = findAll(card, node => node.type === 'select')[0]
  assert.equal(textOf(select), 'stdio' + 'streamable-http')
  assert.deepEqual(select.props.children.map(node => node.props.title), [
    '在 Host 本机启动子进程，不经过 Agent 沙箱',
    '连接远程 HTTP 端点',
  ])
})

test('groups the cards behind a tablist and follows the selection', async () => {
  const { registered } = await boot()
  const page = renderPage(registered)
  const tabs = tabsOf(page)
  // The statistics dashboard has no settings group: it is the conversation tab
  // now, so nothing on this page may offer it.
  assert.ok(!textOf(page).includes('统计看板'))
  // The selected tab names the panel it controls, and the panel names it back.
  assert.deepEqual(tabs.map(node => node.props['aria-selected']), [true, false, false, false, false])
  const panel = findAll(page, node => node.props.role === 'tabpanel')[0]
  assert.equal(panel.props.id, 'extra-prompt-tabs-prompt-panel')
  assert.equal(panel.props['aria-labelledby'], 'extra-prompt-tabs-prompt')

  // Switching moves the selection and swaps the panel's contents.
  tabs[3].props.onClick()
  const rtk = renderPage(registered)
  assert.deepEqual(tabsOf(rtk).map(node => node.props['aria-selected']), [false, false, false, true, false])
  assert.equal(findAll(rtk, node => node.props.role === 'tabpanel')[0].props.id, 'extra-prompt-tabs-rtk-panel')
  assert.equal(findAll(rtk, node => node.props['data-namespace'] === 'extra-rtk-compact').length, 1)
  assert.equal(findAll(rtk, node => node.props['data-namespace'] === 'extra-prompt-injection').length, 0)
})

test('every group keeps its tab, whatever its row is doing', async () => {
  // The rtk row is not mounted. Its card says so, and the group keeps its tab: the
  // page's shape follows the package, not the profile.
  const { registered } = await boot({}, { 'extra-rtk-compact': { status: 'unavailable' } })
  const rtk = renderPage(registered, 'extra-rtk-compact')
  assert.deepEqual(tabsOf(rtk).map(node => node.props['data-tab']), ['prompt', 'routing', 'skill', 'rtk', 'mcp'])
  assert.deepEqual(tabsOf(rtk).map(node => node.props['aria-selected']), [false, false, false, true, false])
  assert.ok(textOf(rtk).includes(UNAVAILABLE_LABEL))
  // The tab next door renders its fields as usual: one unmounted row is not the
  // whole page.
  const prompt = renderPage(registered, 'extra-prompt-injection')
  assert.equal(findAll(prompt, node => node.type === 'textarea').length, 1)
})

test('with every row switched off, every card says so and nothing is written', async () => {
  const off = { status: 'unavailable' }
  const { registered, forms } = await boot({}, {
    'extra-prompt-injection': off,
    'extra-subagent-routing': off,
    'extra-skill-installer': off,
    'extra-rtk-compact': off,
    'extra-mcp': off,
  })
  const tree = renderPage(registered)
  // The default group's card reports the row rather than rendering dead controls.
  assert.ok(textOf(tree).includes(UNAVAILABLE_LABEL))
  assert.equal(saveOf(registered, 'extra-prompt-injection'), undefined)
  // The bar still carries every group...
  assert.deepEqual(tabsOf(tree).map(node => node.props['data-tab']), ['prompt', 'routing', 'skill', 'rtk', 'mcp'])
  // ...and the 技能 group still carries the Skill manager, which is not a row.
  const skill = renderPage(registered, 'extra-skill-installer')
  assert.equal(findAll(skill, node => node.props['data-namespace'] === 'extra-managed-skills').length, 1)
  // No page-level switch survived to write an `enabled` field for anyone.
  NAMESPACES.forEach(ns => assert.deepEqual(forms[ns].calls, []))
})

test('the Skill card lists what the model can read and only offers what the Host owns', async () => {
  // The catalog card belongs to no row: installed Skills are registry state, so it
  // is there whatever the skill-installer row happens to be doing.
  const { registered } = await boot()
  apiAnswers.set('skills/list', {
    ok: true,
    value: {
      catalogAvailable: true,
      workspaces: [{ cwd: 'D:\\Code\\demo', found: 2, preset: 'standard' }],
      notes: [],
      skills: [
        {
          skillName: 'taste-skill',
          description: 'Taste rules for this machine.',
          source: 'user-dsh',
          provider: 'filesystem',
          modelInvocable: true,
          userInvocable: true,
          directory: 'C:\\dsh\\skills\\taste-skill',
          managed: {
            directoryName: 'taste-skill',
            installationId: 'aa11',
            source: 'https://github.com/acme/skills',
            ref: 'main',
            installPath: 'C:\\dsh\\skills\\taste-skill',
            removable: true,
          },
        },
        {
          skillName: 'hand-edited',
          description: 'A directory whose marker no longer matches.',
          source: 'user-dsh',
          provider: 'filesystem',
          modelInvocable: true,
          userInvocable: true,
          directory: 'C:\\dsh\\skills\\hand-edited',
          managed: {
            directoryName: 'hand-edited',
            installationId: 'bb22',
            source: 'https://github.com/acme/other',
            ref: 'dev',
            installPath: 'C:\\dsh\\skills\\hand-edited',
            removable: false,
            reason: '目录中的受管标记与记录不一致，为避免删除非本插件安装的内容，这里不会移除它。',
          },
        },
        {
          // A workspace Skill the Host resolved for this project, plus one the model
          // may not use: both are readable, and the card says which is which.
          skillName: 'api-review',
          description: 'Review API changes.',
          source: 'project-dsh',
          provider: 'filesystem',
          modelInvocable: true,
          userInvocable: true,
          directory: 'D:\\Code\\demo\\.dsh\\skills\\api-review',
          workspace: 'D:\\Code\\demo',
        },
        {
          skillName: 'private-notes',
          description: 'Only the human may invoke this one.',
          source: 'project-agents',
          provider: 'filesystem',
          modelInvocable: false,
          userInvocable: true,
          directory: 'D:\\Code\\demo\\.agents\\skills\\private-notes',
          workspace: 'D:\\Code\\demo',
        },
      ],
    },
  })

  renderPage(registered, 'extra-skill-installer')
  await settle()
  const card = sectionOf(renderPage(registered, 'extra-skill-installer'), 'extra-managed-skills')

  // Reading is one POST to this package's own route, carrying the session cookie
  // Connection authenticates, and it asks for nothing else. The page's other
  // question — whether this machine has rtk — is a separate operation.
  assert.deepEqual(apiRequests.filter(call => call.body.op === 'skills/list'), [{
    url: '/api/extra-prompt',
    method: 'POST',
    credentials: 'same-origin',
    body: { op: 'skills/list' },
  }])
  const text = textOf(card)
  assert.ok(text.includes('taste-skill'))
  assert.ok(text.includes('https://github.com/acme/skills @ main'))
  // Where it came from and where it lives: the workspace and preset the Host read
  // through, the registry bucket, and the directory the model resolves against.
  assert.ok(text.includes('已挂载工作区：D:\\Code\\demo（standard 预设）'))
  assert.ok(text.includes('工作区 .dsh/skills（project-dsh）'))
  assert.ok(text.includes('D:\\Code\\demo\\.dsh\\skills\\api-review'))
  assert.ok(text.includes('模型不可见（disable-model-invocation）'))

  // The Host's verdict decides the row: only the installation it can still prove is
  // offered for removal, and the other one explains itself instead.
  const buttons = findAll(card, node => node.type === 'button')
  assert.equal(buttons.length, 1)
  assert.equal(textOf(buttons[0]), '卸载')
  assert.ok(text.includes('为避免删除非本插件安装的内容'))

  apiAnswers.set('skills/remove', { ok: true, value: { removed: { directoryName: 'taste-skill' } } })
  buttons[0].props.onClick()
  await settle()
  renderPage(registered, 'extra-skill-installer')

  // Removal is addressed by the opaque installation identity, never by name alone,
  // and the list is re-read from the Host afterwards rather than spliced locally.
  assert.deepEqual(plain(apiRequests.filter(call => call.body.op.startsWith('skills/')).map(call => call.body)), [
    { op: 'skills/list' },
    { op: 'skills/remove', directoryName: 'taste-skill', installationId: 'aa11' },
    { op: 'skills/list' },
  ])
})

test('the Skill card reports a refused removal instead of hiding it', async () => {
  const { registered } = await boot()
  apiAnswers.set('skills/list', {
    ok: true,
    value: {
      catalogAvailable: true,
      workspaces: [],
      notes: ['没有挂载的 profile 目录，无法读取 extra-prompt-managed-skills.json。'],
      skills: [{
        skillName: 'taste-skill',
        description: '',
        source: 'user-dsh',
        provider: 'filesystem',
        modelInvocable: true,
        userInvocable: true,
        directory: 'C:\\dsh\\skills\\taste-skill',
        managed: {
          directoryName: 'taste-skill',
          installationId: 'aa11',
          source: 'https://github.com/acme/skills',
          ref: 'main',
          installPath: 'C:\\dsh\\skills\\taste-skill',
          removable: true,
        },
      }],
    },
  })
  apiAnswers.set('skills/remove', {
    ok: false,
    error: { code: 'extra-prompt/skill-not-removed', message: '目录中的受管标记与记录不一致，已拒绝删除。' },
  })

  renderPage(registered, 'extra-skill-installer')
  await settle()
  const button = () => findAll(sectionOf(renderPage(registered, 'extra-skill-installer'), 'extra-managed-skills'),
    node => node.type === 'button')[0]
  button().props.onClick()
  await settle()

  const card = sectionOf(renderPage(registered, 'extra-skill-installer'), 'extra-managed-skills')
  // The Host's own message reaches the page, and the row is still there to retry:
  // a removal that failed must not look like one that succeeded.
  assert.ok(textOf(card).includes('已拒绝删除'))
  assert.equal(findAll(card, node => node.type === 'button').length, 1)
  assert.ok(textOf(card).includes('taste-skill'))
})

test('the in-session dashboard renders charts, metrics, and handles range switching', async () => {
  const { registered } = await boot()

  // The dashboard is a conversation tab now: the session comes from the tab, so
  // the only operation it may ask the Host for is that session's data.
  apiAnswers.set('dashboard/data', {
    ok: true,
    value: {
      session: { id: 'sess-1', title: '重构看板前端', cwd: 'D:/Code/test' },
      summary: {
        eventCount: 28,
        messages: 8,
        userMessages: 4,
        assistantMessages: 4,
        turns: 4,
        steps: 6,
        toolCalls: 5,
        toolResults: 5,
        toolFailures: 1,
        firstEventTime: 1710000000000,
        lastEventTime: 1710000120000,
        elapsedMs: 120000,
      },
      stats: {
        llmMs: 70000,
        toolMs: 30000,
        ttftMs: 1200,
        decodeMs: 65000,
        decodeTokens: 2600,
      },
      token: {
        totals: {
          inputTokens: 8500,
          outputTokens: 2600,
          reasoningTokens: 1200,
          totalTokens: 11100,
          uncachedInputTokens: 2500,
          cacheReadTokens: 6000,
          cacheWriteTokens: 0,
          cacheHitRate: 70.58,
        },
        points: [
          { key: '1', label: '第 1 轮 · 步 1', inputTokens: 2000, outputTokens: 600, totalTokens: 2600, runMs: 15000 },
          { key: '2', label: '第 2 轮 · 步 1', inputTokens: 6500, outputTokens: 2000, totalTokens: 8500, runMs: 25000 },
        ],
      },
      cost: {
        toolCalls: 5,
        toolFailures: 1,
        toolErrorRate: 20,
        retries: 1,
        retriedSteps: 1,
        wastedTurns: 1,
        wastedSteps: 2,
        wastedToolCalls: 1,
        distinctCommands: 2,
        repeatedCommands: [{ command: 'git status', calls: 2 }],
        repeatedCommandCalls: 2,
        repeatedCommandRate: 50,
        tools: [
          { name: 'pwsh', calls: 3, errors: 1, errorRate: 33.3, durationMs: 18000, resultChars: 4500 },
          { name: 'read', calls: 2, errors: 0, errorRate: 0, durationMs: 2000, resultChars: 12000 },
        ],
        turns: [
          { key: 't1', turn: 1, steps: 2, toolCalls: 2, toolFailures: 0, outcome: 'completed' },
          { key: 't2', turn: 2, steps: 2, toolCalls: 2, toolFailures: 1, outcome: 'error' },
        ],
      },
      turns: [
        { key: 't1', turn: 1, label: '第 1 轮', durationMs: 45000, steps: 2, toolCalls: 2, totalTokens: 2600, signals: ['user', 'tool', 'assistant'] },
        { key: 't2', turn: 2, label: '第 2 轮', durationMs: 75000, steps: 2, toolCalls: 2, totalTokens: 8500, signals: ['user', 'tool', 'error', 'assistant'] },
      ],
    },
  })

  // The tab hands over its own session, so the view loads that one directly.
  renderConversationDashboard(registered, { sessionId: 'sess-1' })
  await settle()
  await settle()
  const page = renderConversationDashboard(registered, { sessionId: 'sess-1' })
  const content = textOf(page)

  // The only thing it asks the Host for is that session: the cross-session list
  // that fed the old settings group is gone along with the group.
  assert.deepEqual(apiRequests.map(call => call.body.op), ['dashboard/data'])
  assert.deepEqual(plain(apiRequests[0].body), { op: 'dashboard/data', sessionId: 'sess-1' })

  // Verify elements are rendered
  assert.ok(content.includes('重构看板前端'))
  assert.ok(content.includes('上下文窗口容量与多层级解剖'))
  assert.ok(content.includes('Extra-Prompt 协同效益与开销'))
  assert.ok(content.includes('上下文生命周期事件流'))
  assert.ok(content.includes('会话耗时'))
  assert.ok(content.includes('对话轮次 / 步数'))
  assert.ok(content.includes('Token 消耗总量'))
  assert.ok(content.includes('KV 缓存命中率'))
  assert.ok(content.includes('Token 构成与缓存分布'))
  assert.ok(content.includes('耗时归因与推理速度'))
  assert.ok(content.includes('轮次健康度与损耗归因'))
  assert.ok(content.includes('工具性能与数据载荷开销'))
  assert.ok(content.includes('重复命令重做检测'))

  // Verify charts and SVG elements
  const donutSvg = findAll(page, node => node.type === 'svg' && node.props['aria-label'] === 'Token 构成比例图')[0]
  assert.ok(donutSvg, 'must render SVG donut chart')
  const gaugeSvg = findAll(page, node => node.type === 'svg' && node.props['aria-label'] === '上下文窗口水位图')[0]
  assert.ok(gaugeSvg, 'must render SVG context window gauge')

  // Verify tool table has pwsh and read
  assert.ok(content.includes('pwsh'))
  assert.ok(content.includes('read'))

  // Verify repeated command is listed
  assert.ok(content.includes('git status'))

  // Switch range to 'recent'
  const recentBtn = findAll(page, node => node.type === 'button' && textOf(node).includes('最近 8 轮'))[0]
  assert.ok(recentBtn, 'must have range button for recent turns')
  recentBtn.props.onClick()
  const pageRecent = renderConversationDashboard(registered, { sessionId: 'sess-1' })
  assert.ok(pageRecent, 'renders after range switch')
})

test('registers conversation.view slot for in-session dashboard tab', async () => {
  const { registered } = await boot()
  const convEntry = registered.find(item => item.slotOptions.name === 'conversation.view' && item.slotOptions.id === 'dashboard')
  assert.ok(convEntry, 'must register conversation.view with id "dashboard"')
  assert.equal(convEntry.slotOptions.order, 20)
  assert.equal(convEntry.slotOptions.label, '看板')
  assert.deepEqual(plain(convEntry.slotOptions.inject('sess-test')), { sessionId: 'sess-test' })

  // Render ConversationSessionDashboardView
  const component = convEntry.component
  const rendered = render(component({ sessionId: 'sess-test' }), '0')
  assert.ok(rendered)
  assert.ok(rendered.props.className.includes('dsh-dash-session-view'))
  assert.equal(rendered.props['data-conversation-composer-overlay'], '')
})

test('conversation dashboard detects active model from DOM composer and rejects header team labels', async () => {
  // The header's own label, as the host writes it (`ui-agent-preset`'s zh
  // dictionary: `trigger: '智能体团队'`). It is the exact string the detector has
  // to refuse, so a fixture of our own invention would test nothing.
  const TEAM_LABEL = '智能体团队'
  const headerMenuBtn = {
    tagName: 'BUTTON',
    className: 'header-mode-trigger',
    title: TEAM_LABEL,
    attributes: { 'aria-haspopup': 'menu', title: TEAM_LABEL },
    textContent: TEAM_LABEL,
    children: [],
  }

  const triggerLabelSpan = {
    tagName: 'SPAN',
    className: 'wq12jW_triggerLabel',
    attributes: { class: 'wq12jW_triggerLabel' },
    textContent: 'gemini-3.8-flash-high',
    children: [],
  }

  const composer = {
    tagName: 'DIV',
    className: 'standardControls composer',
    attributes: { class: 'standardControls composer' },
    textContent: 'gemini-3.8-flash-high',
    children: [triggerLabelSpan],
    querySelector: (sel) => (sel.includes('triggerLabel') ? triggerLabelSpan : null),
    querySelectorAll: (sel) => (sel.includes('span') ? [triggerLabelSpan] : []),
  }

  const dom = {
    querySelector: (sel) => {
      if (sel.includes('composer') || sel.includes('standardControls') || sel.includes('InputBar') || sel.includes('footer')) {
        return composer
      }
      return null
    },
    querySelectorAll: (sel) => {
      if (sel.includes('aria-haspopup="menu"')) return [headerMenuBtn]
      return []
    },
  }

  const { registered, plugin } = await boot(undefined, undefined, undefined, { dom })

  // 1. Assert isLikelyModelName rejects the header's own labels, but accepts 'gemini-3.8-flash-high'
  assert.equal(plugin.isLikelyModelName(TEAM_LABEL), false)
  assert.equal(plugin.isLikelyModelName('标准模式'), false)
  assert.equal(plugin.isLikelyModelName('当前模型'), false)
  assert.equal(plugin.isLikelyModelName('gemini-3.8-flash-high'), true)

  apiAnswers.set('dashboard/data', {
    ok: true,
    value: {
      session: { id: 'sess-dom-test', title: 'DOM 回退会话' },
      summary: { turns: 1, steps: 1, elapsedMs: 10000 },
      stats: {},
      context: { capacity: {} },
      token: {
        totals: { inputTokens: 5000, outputTokens: 1000, totalTokens: 6000 },
        points: [{ key: '1', label: '第 1 轮', inputTokens: 5000, outputTokens: 1000, totalTokens: 6000 }],
      },
      cost: { toolCalls: 0, tools: [] },
      turns: [{ key: 't1', turn: 1, label: '第 1 轮', durationMs: 10000, steps: 1, toolCalls: 0, totalTokens: 6000, signals: ['user', 'assistant'] }],
    },
  })

  // 2. Call WITHOUT passing sessionModel so it exercises DOM fallback
  const simulatedSession = { sessionId: 'sess-dom-test', title: 'DOM 回退会话' }
  renderConversationDashboard(registered, {
    sessionId: 'sess-dom-test',
    useSession: (selector) => selector(simulatedSession),
  })
  await settle()
  await settle()
  const page = renderConversationDashboard(registered, {
    sessionId: 'sess-dom-test',
    useSession: (selector) => selector(simulatedSession),
  })
  const content = textOf(page)

  // 3. Assert user sees 'gemini-3.8-flash-high · 1.00M 上限'
  assert.ok(
    content.includes('gemini-3.8-flash-high · 1.00M 上限'),
    `User must see "gemini-3.8-flash-high · 1.00M 上限". Got:\n${content.slice(0, 300)}`
  )

  // 4. Assert it NEVER shows '智能体团队 · 131.1k 上限'
  assert.ok(!content.includes('智能体团队 · 131.1k 上限'))
  assert.ok(!content.includes('智能体团队'))
  assert.ok(!content.includes('131.1k 上限'))
})

test('marks a field the user layer overrides, and the reset stages a clear', async () => {
  const { registered, forms } = await boot({ 'extra-prompt-injection': { text: '旧的' } }, {
    'extra-prompt-injection': { user: { text: '旧的' } },
  })
  const tree = renderPage(registered)
  const section = sectionOf(tree, 'extra-prompt-injection')
  // The value equals the committed one, yet the user layer carries the key: the
  // badge reports presence, not a value difference.
  assert.ok(textOf(section).includes('已自定义'))
  const reset = findAll(section, node => node.type === 'button' && textOf(node) === '恢复默认')[0]
  reset.props.onClick()
  assert.equal(saveOf(registered, 'extra-prompt-injection').props.disabled, false)
  saveOf(registered, 'extra-prompt-injection').props.onClick()
  await settle()
  assert.deepEqual(forms['extra-prompt-injection'].calls, [{ op: 'unset', field: 'text' }])
})

test('a save writes exactly the staged fields and clears them once accepted', async () => {
  const { registered, forms } = await boot({ 'extra-prompt-injection': { text: '旧提示词' } })
  const tree = renderPage(registered)
  const form = forms['extra-prompt-injection']

  assert.equal(saveOf(registered, 'extra-prompt-injection').props.disabled, true, 'an untouched panel cannot be saved')

  const textarea = () => findAll(renderPage(registered), node => node.type === 'textarea')[0]
  assert.equal(textarea().props.value, '旧提示词')
  textarea().props.onChange({ target: { value: '新提示词' } })

  assert.equal(saveOf(registered, 'extra-prompt-injection').props.disabled, false)
  saveOf(registered, 'extra-prompt-injection').props.onClick()
  await settle()
  assert.deepEqual(form.calls, [{ op: 'set', field: 'text', value: '新提示词' }])
  // The write landed, so the draft is dropped and the panel is clean again — the
  // committed value now comes from the Host snapshot, not from the draft.
  assert.equal(saveOf(registered, 'extra-prompt-injection').props.disabled, true)
  assert.equal(textarea().props.value, '新提示词')

  // A second edit stages again. Retyping the committed value stays a staged edit:
  // it would leave a user-layer entry, so it is not silently discarded.
  textarea().props.onChange({ target: { value: '新提示词' } })
  assert.equal(saveOf(registered, 'extra-prompt-injection').props.disabled, false)
  assert.equal(form.calls.length, 1)
})

test('a save that the Host refuses keeps the drafts', async () => {
  const { registered, forms } = await boot({ 'extra-prompt-injection': { text: '旧的' } })
  const form = forms['extra-prompt-injection']
  form.set = async (field, value) => { form.calls.push({ op: 'set', field, value }); return false }
  const tree = renderPage(registered)
  const textarea = findAll(tree, node => node.type === 'textarea')[0]
  textarea.props.onChange({ target: { value: '新的' } })
  saveOf(registered, 'extra-prompt-injection').props.onClick()
  await settle()
  // Nothing the user typed is lost to a write the Host did not accept.
  assert.equal(findAll(renderPage(registered), node => node.type === 'textarea')[0].props.value, '新的')
})

test('an emptied number stages an unset so the schema default applies', async () => {
  const { registered, forms } = await boot({ 'extra-rtk-compact': { minBodyChars: 1200 } })
  const tree = renderPage(registered, 'extra-rtk-compact')
  const numeric = findAll(tree, node => node.props.inputMode === 'numeric')
  numeric[0].props.onChange({ target: { value: '' } })
  const save = saveOf(registered, 'extra-rtk-compact')
  assert.equal(save.props.disabled, false)
  save.props.onClick()
  await settle()
  // Clearing the input stages a clear; the write must be an `unset` so the schema
  // default applies again, not a `set` of an empty or NaN value.
  assert.deepEqual(forms['extra-rtk-compact'].calls, [{ op: 'unset', field: 'minBodyChars' }])
})

test('a number outside the schema minimum blocks the save', async () => {
  const { registered, forms } = await boot({ 'extra-rtk-compact': { minBodyChars: 1200 } })
  const tree = renderPage(registered, 'extra-rtk-compact')
  // The first numeric field is `minBodyChars`, whose schema floor is 0.
  findAll(tree, node => node.props.inputMode === 'numeric')[0].props.onChange({ target: { value: '-1' } })
  assert.equal(saveOf(registered, 'extra-rtk-compact').props.disabled, true)
  assert.ok(textOf(renderPage(registered, 'extra-rtk-compact')).includes('请输入有效值'))
  // A draft the Host would refuse must not be written, and must not be dropped.
  assert.deepEqual(forms['extra-rtk-compact'].calls, [])
  assert.equal(findAll(renderPage(registered, 'extra-rtk-compact'), node => node.props.inputMode === 'numeric')[0].props.value, '-1')
})

test('an incomplete route row blocks the save instead of writing a broken route', async () => {
  const { registered, forms } = await boot({ 'extra-subagent-routing': { routes: [], guidance: '' } })
  const add = panelControl(renderPage(registered, 'extra-subagent-routing'), 'extra-subagent-routing', node => node.type === 'button' && textOf(node) === '添加一条路由')
  add.props.onClick()
  // The new row has no provider or model yet, which the Host would reject.
  assert.equal(saveOf(registered, 'extra-subagent-routing').props.disabled, true)
  assert.ok(textOf(renderPage(registered, 'extra-subagent-routing')).includes('每条路由都需要 provider 和 model。'))
  assert.deepEqual(forms['extra-subagent-routing'].calls, [])

  // Each edit re-renders the row, so the handler under test must be read from the
  // tree the previous edit produced — the way React hands a fresh closure down.
  const cell = (label) => findAll(
    sectionOf(renderPage(registered, 'extra-subagent-routing'), 'extra-subagent-routing'),
    node => node.props['aria-label'] === label,
  )[0]
  cell('provider').props.onChange({ target: { value: 'deepseek-official' } })
  cell('model').props.onChange({ target: { value: 'deepseek-v4-pro' } })
  const save = saveOf(registered, 'extra-subagent-routing')
  assert.equal(save.props.disabled, false)
  save.props.onClick()
  await settle()
  assert.deepEqual(plain(forms['extra-subagent-routing'].calls), [{
    op: 'set',
    field: 'routes',
    value: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro', note: '' }],
  }])
})

test('an unmounted row reports itself instead of rendering dead controls', async () => {
  const { registered } = await boot({}, { 'extra-rtk-compact': { status: 'unavailable' } })
  const tree = renderPage(registered, 'extra-rtk-compact')
  // The card is the honest state: the Host serves no form for a row it does not
  // mount, so the page explains where to switch it back on.
  assert.ok(textOf(sectionOf(tree, 'extra-rtk-compact')).includes(UNAVAILABLE_LABEL))
  assert.equal(saveOf(registered, 'extra-rtk-compact'), undefined, 'nothing to save')
  assert.equal(switchesOf(sectionOf(tree, 'extra-rtk-compact')).length, 0)
  // The group keeps its tab, and the other rows keep their fields.
  assert.deepEqual(tabsOf(tree).map(node => node.props['data-tab']), ['prompt', 'routing', 'skill', 'rtk', 'mcp'])
  const prompt = renderPage(registered, 'extra-prompt-injection')
  assert.equal(findAll(prompt, node => node.type === 'textarea').length, 1)
})

test('the rtk card reports a machine that has no rtk, beside the field that fixes it', async () => {
  const { registered } = await boot()
  // Only the Host can answer this, and it answers about the path the page holds.
  apiAnswers.set('rtk/status', { ok: true, value: { available: false, path: null, source: 'path' } })
  renderPage(registered)
  await settle()
  const tree = renderPage(registered, 'extra-rtk-compact')

  assert.deepEqual(plain(apiRequests.filter(call => call.body.op === 'rtk/status')), [{
    url: '/api/extra-prompt',
    method: 'POST',
    credentials: 'same-origin',
    body: { op: 'rtk/status', rtkPath: '' },
  }])
  // Without rtk every result passes through untouched, which looks exactly like a
  // filter that works; the card that configures it is where that gets said.
  assert.ok(textOf(tree).includes(RTK_MISSING_NOTICE))
  // Exactly one link on the card — the repository in its head — and the note points
  // at it rather than printing the address a second time.
  const links = findAll(sectionOf(tree, 'extra-rtk-compact'), node => node.type === 'a')
  assert.deepEqual(links.map(node => node.props.href), [RTK_REPO])
  assert.equal(links[0].props.target, '_blank')
  assert.ok(links[0].props.rel.includes('noopener'))
  // The field the note tells the user about is on the same card.
  assert.ok(panelControl(tree, 'extra-rtk-compact', node => node.type === 'input'))
})

test('the probe follows the configured path, and a wrong path is still reported', async () => {
  const { registered } = await boot(
    { 'extra-rtk-compact': { rtkPath: 'D:/tools/rtk.exe' } },
    { 'extra-rtk-compact': { user: { rtkPath: 'D:/tools/rtk.exe' } } },
  )
  // A configured path is the one case the Host cannot look up on its own, so the
  // page passes what it read from its own form.
  apiAnswers.set('rtk/status', { ok: true, value: { available: false, path: null, source: 'configured' } })
  renderPage(registered)
  await settle()
  const tree = renderPage(registered, 'extra-rtk-compact')

  assert.equal(apiRequests.filter(call => call.body.op === 'rtk/status')[0].body.rtkPath, 'D:/tools/rtk.exe')
  // The note still travels: a row that is mounted but cannot run is exactly what the
  // user needs told, whatever the reason.
  assert.ok(textOf(tree).includes(RTK_MISSING_NOTICE))
})

test('a machine that has rtk is asked once per path, and the card names the binary', async () => {
  const { registered } = await boot()
  apiAnswers.set('rtk/status', { ok: true, value: { available: true, path: 'C:/bin/rtk.exe', source: 'path' } })
  renderPage(registered)
  await settle()
  const tree = renderPage(registered, 'extra-rtk-compact')

  assert.ok(textOf(tree).includes(RTK_FOUND_PREFIX + 'C:/bin/rtk.exe'))
  assert.ok(!textOf(tree).includes(RTK_MISSING_NOTICE), 'nothing is missing here')
  // The one link stays the repository: the found note adds no second one.
  assert.deepEqual(findAll(sectionOf(tree, 'extra-rtk-compact'), node => node.type === 'a').map(node => node.props.href), [RTK_REPO])
  // A re-render is not a reason to ask again: the answer depends on rtkPath alone.
  assert.equal(apiRequests.filter(call => call.body.op === 'rtk/status').length, 1)
})

test('an unanswerable rtk question adds no claim to the card', async () => {
  // No scripted answer at all: the route rejects, which is also what an older Host
  // or a Host without the lookup seam looks like.
  const { registered } = await boot()
  renderPage(registered)
  await settle()
  const tree = renderPage(registered, 'extra-rtk-compact')
  assert.ok(!textOf(tree).includes(RTK_MISSING_NOTICE), 'an unanswered question is not a missing binary')
  assert.ok(!textOf(tree).includes(RTK_FOUND_PREFIX))
  // The card and its fields are there either way: the probe is decoration on a form
  // that does not depend on it.
  assert.ok(panelControl(tree, 'extra-rtk-compact', node => node.type === 'input'))
})

test('a switched-off row leaves its card uneditable, and the Skill manager beside it', async () => {
  const { registered, forms } = await boot({}, { 'extra-skill-installer': { status: 'unavailable' } })
  const tree = renderPage(registered, 'extra-skill-installer')
  // Its own group is still there: the page does not move when a row does.
  assert.deepEqual(tabsOf(tree).map(node => node.props['data-tab']), ['prompt', 'routing', 'skill', 'rtk', 'mcp'])
  assert.ok(textOf(sectionOf(tree, 'extra-skill-installer')).includes(UNAVAILABLE_LABEL))
  assert.equal(saveOf(registered, 'extra-skill-installer'), undefined)
  // The Skill manager is not a row: it stays reachable in the same group.
  assert.equal(findAll(tree, node => node.props['data-namespace'] === 'extra-managed-skills').length, 1)
  // And nothing here tries to switch the row back on by itself.
  assert.deepEqual(forms['extra-skill-installer'].calls, [])
})

test('the page holds no feature switch, and says where the switches are instead', async () => {
  const { registered } = await boot()
  const page = renderPage(registered)
  // The enable card is gone: `enabled` is no longer a setting of any of these rows.
  assert.equal(findAll(page, node => node.props['data-namespace'] === 'enable').length, 0)
  assert.ok(textOf(page).includes('开与关都在「插件」页'))
  // The prompt card's only control is its textarea: no switch was smuggled in.
  assert.equal(switchesOf(sectionOf(page, 'extra-prompt-injection')).length, 0)
})

test('warns when a configured route is outside the delegation policy, and never writes that policy', async () => {
  const { registered, officialForm } = await boot({
    'extra-subagent-routing': {
      routes: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro', note: '' }],
      guidance: '',
    },
    [OFFICIAL_NAMESPACE]: { enabled: true, allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-v4-lite' }] },
  })
  const section = sectionOf(renderPage(registered, 'extra-subagent-routing'), 'extra-subagent-routing')
  // The route would be named in the system prompt and then refused by the
  // delegation tool, which is invisible from this card alone.
  assert.ok(textOf(section).includes('deepseek-official/deepseek-v4-pro'))
  assert.ok(textOf(section).includes('允许清单'))
  // Reading is the whole intervention: the official card owns that document, and
  // a second writer would let the two lists diverge silently.
  assert.deepEqual(officialForm.calls, [])
})

test('reports a disabled delegation policy as its own problem', async () => {
  const { registered } = await boot({
    'extra-subagent-routing': { routes: [{ provider: 'p', model: 'm', note: '' }], guidance: '' },
    [OFFICIAL_NAMESPACE]: { enabled: false, allowedModels: [] },
  })
  assert.ok(textOf(renderPage(registered, 'extra-subagent-routing')).includes('没有启用模型白名单'))
})

test('stays silent when the policy already allows every configured route', async () => {
  const { registered } = await boot({
    'extra-subagent-routing': { routes: [{ provider: 'p', model: 'm', note: '' }], guidance: '' },
    [OFFICIAL_NAMESPACE]: { enabled: true, allowedModels: [{ provider: 'p', model: 'm' }] },
  })
  assert.equal(textOf(renderPage(registered, 'extra-subagent-routing')).includes('允许清单'), false)
})

test('says nothing about the policy when the namespace is not served', async () => {
  // An unreadable policy is not a disagreement: guessing would be worse.
  const { registered } = await boot(
    { 'extra-subagent-routing': { routes: [{ provider: 'p', model: 'm', note: '' }], guidance: '' } },
    { [OFFICIAL_NAMESPACE]: { status: 'unavailable' } },
  )
  assert.equal(textOf(renderPage(registered, 'extra-subagent-routing')).includes('允许清单'), false)
})

test('a non-writable namespace renders read-only and refuses to save', async () => {
  const { registered } = await boot({ 'extra-prompt-injection': { text: 'x' } }, { 'extra-prompt-injection': { writable: false } })
  const tree = renderPage(registered, 'extra-prompt-injection')
  assert.ok(textOf(tree).includes('内存模式'))
  assert.equal(findAll(tree, node => node.type === 'textarea')[0].props.disabled, true)
  assert.equal(saveOf(registered, 'extra-prompt-injection').props.disabled, true)
})

// The card's own rules repeat the Host's, because the two halves of this package
// cannot share a module: the browser artifact is a classic script with no build
// step, and `src/mcp/model.mjs` is Host ESM. The duplication is the price of the
// card being able to refuse a save at all, so it is pinned here instead of being
// trusted — every case below has to come out the same on both sides.
test('the MCP card refuses exactly the server lists the Host refuses', async () => {
  const { plugin } = await boot()
  assert.equal(typeof plugin.serverIssues, 'function', 'the card must expose its rules')

  /** Reduce a rule result to the entry and field it names, in a stable order. */
  const codes = (issues) => issues.map(issue => issue.index + ':' + issue.field).sort().join(' ')

  const cases = {
    'a well-formed stdio server': [{ serverName: 'local', transport: 'stdio', command: 'npx', env: { TOKEN: 't' } }],
    'a well-formed HTTP server': [{ serverName: 'remote', transport: 'streamable-http', url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer t' } }],
    'a name that is not allowed': [{ serverName: 'bad name!', transport: 'stdio', command: 'npx' }],
    'a name that is too long': [{ serverName: 'a'.repeat(33), transport: 'stdio', command: 'npx' }],
    'two servers sharing a name': [
      { serverName: 'same', transport: 'stdio', command: 'npx' },
      { serverName: 'same', transport: 'stdio', command: 'npx' },
    ],
    'a stdio server with no command': [{ serverName: 'local', transport: 'stdio', command: '   ' }],
    'an HTTP server with no URL': [{ serverName: 'remote', transport: 'streamable-http', url: '' }],
    'an HTTP server on another scheme': [{ serverName: 'remote', transport: 'streamable-http', url: 'ftp://mcp.example/mcp' }],
    'an HTTP server with no scheme': [{ serverName: 'remote', transport: 'streamable-http', url: 'mcp.example/mcp' }],
    'an HTTP server with credentials in the URL': [{ serverName: 'remote', transport: 'streamable-http', url: 'https://user:secret@mcp.example/mcp' }],
    'an environment name that is not allowed': [{ serverName: 'local', transport: 'stdio', command: 'npx', env: { 'BAD NAME': 'x' } }],
    'a header name that is not allowed': [{ serverName: 'remote', transport: 'streamable-http', url: 'https://x/mcp', headers: { 'Bad Header': 'x' } }],
    'a call timeout below the floor': [{ serverName: 'local', transport: 'stdio', command: 'npx', toolCallTimeoutMs: 99 }],
    'a call timeout above the ceiling': [{ serverName: 'local', transport: 'stdio', command: 'npx', toolCallTimeoutMs: 300001 }],
    'an instruction cap that is not a positive integer': [{ serverName: 'local', transport: 'stdio', command: 'npx', maxInstructionBytes: 0 }],
    'an instruction cap that is fractional': [{ serverName: 'local', transport: 'stdio', command: 'npx', maxInstructionBytes: 1.5 }],
    'no reconnect attempts': [{ serverName: 'local', transport: 'stdio', command: 'npx', reconnectMaxAttempts: 0 }],
    'a first delay above the maximum delay': [{ serverName: 'local', transport: 'stdio', command: 'npx', reconnectInitialDelayMs: 5000, reconnectMaxDelayMs: 100 }],
    'a zero delay while reconnect is off': [{
      serverName: 'local', transport: 'stdio', command: 'npx',
      reconnectEnabled: false, reconnectInitialDelayMs: 0, reconnectMaxDelayMs: 0, reconnectMaxAttempts: 0,
    }],
    'more servers than the cap': Array.from({ length: 65 }, (unused, index) => ({
      serverName: 's' + index, transport: 'stdio', command: 'npx',
    })),
  }

  for (const [label, entries] of Object.entries(cases)) {
    // The card only ever sees what the Host's schema produced, so both sides are
    // given the same normalized document.
    const servers = normalizeServers(entries)
    const host = codes(validateServers(servers))
    const card = codes(plain(plugin.serverIssues(servers)))
    assert.equal(card, host, `${label}: the card and the Host disagree`)
  }
})
