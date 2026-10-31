// dsh-extra-prompt — browser half.
//
// HAND-WRITTEN, NOT GENERATED. The upstream `clientBundle()` tsdown preset
// (vendor/dsh/packages/client/tsdown.client.ts) is repo-internal and unpublished,
// so an out-of-tree package has to reproduce its output itself. Rather than
// reproduce the whole toolchain, this file *is* the artifact: the exact lazy-CJS
// closure-factory shape the module loader expects, with the components authored
// through `React.createElement` instead of JSX. That keeps this package free of
// any build step.
//
// The shape, per tsdown.client.ts's `clientConfig` outputOptions:
//
//   window.__ModuleLoader__.load({ id: "<package name>", factory: (require) => {
//   var module = { exports: {} }; var exports = module.exports;
//   ...body...
//   return module.exports; } });
//
// `id` MUST be the bare package name, because `client-modules` keys its module
// table — and therefore the /plugins/<id>/client.js route — by package name.
//
// Only the eight baseline externals may be imported at runtime
// (vendor/dsh/packages/client/web/src/platform.ts): react, react/jsx-runtime,
// react-dom, react-dom/client, @deepseek-ai/cordis,
// @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
// @deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit.
// This bundle uses two of them: `react` and the shared settings kit in
// `@deepseek-ai/dsh-client-ui-primitives` — `SettingsForm` for the card frame and
// its save control, `SettingsValueField` for single-line and numeric fields,
// `Switch` for booleans, `Tag` for the overridden badge, `Button` for the route
// editor, and `SegmentedControl` for the group tabs. Using the host's own atoms is
// what keeps this page visually identical to the settings pages the client ships;
// `ui-primitives` is a shell baseline, so requiring it needs no
// `dsh.client.external` request.
//
// What stays local, because `ui-primitives` publishes no atom for it: the
// multi-line text control, the enum picker, and the route list editor. Their
// rules are copied from the host's own `settings-form/fields.module.css` and
// `ConfigField.module.css` and use only `--dsw-*` design tokens, so they carry
// the same metrics and theme as the official fields around them. Every custom
// field reuses the official field chrome (label row, override badge, reset,
// hint) rather than inventing its own.
//
// The page registers into the `settings.section` list slot, which
// `ui-settings-general` declares and whose nav row is projected straight from the
// slot ledger — so no upstream change is needed for a third-party settings page.
//
// The page holds configuration and nothing else. Every feature of this package is
// its own profile row, and switching one on or off is the 「插件」 page's row
// switch, which writes `disabled` into the profile patch and disposes (or mounts)
// that row's fiber. A row that is off therefore leaves this page one unavailable
// card instead of one switch: the Host serves no form for a plugin it does not
// mount, and the settings come back unchanged the moment the row is switched on.
// The card carries the reason, so the missing form is never a puzzle.

window.__ModuleLoader__.load({ id: "dsh-extra-prompt", factory: (require) => {
'use strict';

var module = { exports: {} };
var exports = module.exports;

var React = require('react');
var h = React.createElement;
var primitives = require('@deepseek-ai/dsh-client-ui-primitives');
var SettingsForm = primitives.SettingsForm;
var SettingsValueField = primitives.SettingsValueField;
var Switch = primitives.Switch;
var Tag = primitives.Tag;
var Button = primitives.Button;
var SegmentedControl = primitives.SegmentedControl;

/**
 * The icons this page draws, by meaning rather than by file.
 *
 * Every one is a component of the host's own set, so the glyphs carry the same
 * 16x16 geometry, the same 1px stroke and the same `currentColor` behaviour as
 * the icons beside the official settings sections. Nothing here is redrawn by
 * hand: a locally drawn glyph would be a second icon language on a page whose
 * whole point is to look like the host's own.
 *
 * The names are collected in one table instead of being read at each use site so
 * that the whole dependency is one object: `test/client-bundle.test.mjs` pins it
 * against the list of icons this bundle is allowed to name, because a host
 * upgrade that renames one turns a stale entry into a missing glyph. `iconOf`
 * then degrades that entry to a neutral outline rather than to a crash — the
 * page loses one small glyph, not the whole settings section.
 */
var HOST_ICON_NAMES = {
  injection: 'IconContextInjectionOutlineRegular',
  routing: 'IconBranchOutlineRegular',
  skill: 'IconSkillOutlineRegular',
  compact: 'IconCompactOutlineRegular',
  mcp: 'IconApiOutlineRegular',
  page: 'IconSlidersTwoOutlineRegular',
  expand: 'IconChevronDownOutlineRegular',
  collapse: 'IconChevronRightOutlineRegular',
};

/**
 * A 16x16 neutral outline, drawn the host's way (`fill:none`,
 * `stroke:currentColor`, 1px), for the one case the host has no answer for: it
 * does not export the icon a key names.
 *
 * A missing component would otherwise be handed to `React.createElement` as
 * `undefined`, which throws "Element type is invalid" and takes the entire
 * settings section down with it. Substituting a drawn glyph keeps the failure
 * proportional to what actually broke.
 */
function FallbackIcon(props) {
  var size = props && props.size !== undefined ? props.size : 16;
  return h('svg', {
    className: props && props.className,
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': 'true',
    strokeWidth: 1,
  }, h('rect', {
    x: 2.5,
    y: 2.5,
    width: 11,
    height: 11,
    rx: 2.5,
    stroke: 'currentColor',
  }));
}

/**
 * Whether a host export can be handed to `React.createElement` as a type.
 *
 * Functions are the ordinary case, and what `ui-primitives` exports today. The
 * object branch is for a host that wraps its icons in `memo`/`forwardRef`/`lazy`:
 * those are objects carrying `$$typeof`, and treating them as missing would
 * silently downgrade every icon to the fallback. A plain object without
 * `$$typeof` is not a type, so it still falls back instead of throwing.
 */
function isIconComponent(value) {
  if (typeof value === 'function') return true;
  return value !== null && typeof value === 'object' && value.$$typeof !== undefined;
}

/**
 * Resolve one entry of `HOST_ICON_NAMES` to a renderable component.
 *
 * @param key - a key of `HOST_ICON_NAMES`.
 * @returns the host's icon component, or the neutral outline if the host does
 *   not export that name (an older or newer client than this list was written
 *   against).
 */
function iconOf(key) {
  var component = primitives[HOST_ICON_NAMES[key]];
  return isIconComponent(component) ? component : FallbackIcon;
}

/**
 * The settings namespaces this page edits. Each is owned by one host row of this
 * same package, and each name is also that row's profile entry id — which is what
 * makes a feature's on/off switch the row's own switch on the 「插件」 page.
 */
var NAMESPACES = [
  'extra-prompt-injection',
  'extra-subagent-routing',
  'extra-skill-installer',
  'extra-rtk-compact',
  'extra-mcp',
  'extra-image-gen',
];

/**
 * The namespace of the rtk card, the one card with a machine fact to report.
 *
 * `rtk-compact` shells out to an `rtk` binary that may simply not be installed.
 * That no longer holds the feature back — its row is switched on and off on the
 * 「插件」 page like every other — so what is left for this page is to say which of
 * the two the Host found, rather than let a silent passthrough read as a filter
 * that works.
 */
var RTK_NAMESPACE = 'extra-rtk-compact';

/**
 * Where rtk itself comes from.
 *
 * The page is the only place a DSH user meets this feature, and the binary is not
 * something DSH installs, so the address belongs here rather than in a README the
 * settings page cannot reach.
 */
var RTK_REPO = 'https://github.com/rtk-ai/rtk';

/** The rtk card's note when this machine has no rtk to run. */
var RTK_MISSING_NOTICE = '本机没有找到 rtk 可执行文件，工具输出会原样通过；'
  + '装上 rtk（仓库见上方）或在本功能里指定 rtkPath 后才会压缩。'
  + '刚装完 rtk 时，DSH 要重启一次才会拿到新的 PATH。';

/** The rtk card's note when the binary is there. */
var RTK_FOUND_PREFIX = '已找到 rtk：';

/**
 * The tab groups, in display order. Every namespace above belongs to exactly one
 * group, so the page never has a feature it cannot reach; grouping related
 * namespaces behind one tab is what keeps the page from becoming one long scroll.
 *
 * The groups are fixed: switching a feature on or off happens on the 「插件」 page,
 * so this page never changes shape under the user. A row that is switched off shows
 * its card in the unavailable state rather than vanishing, and the card comes back
 * with its saved settings the moment the row is switched on again.
 */
var TABS = [
  { id: 'prompt', label: '提示词', namespaces: ['extra-prompt-injection'] },
  { id: 'routing', label: '子代理路由', namespaces: ['extra-subagent-routing'] },
  { id: 'skill', label: '技能', namespaces: ['extra-skill-installer'] },
  { id: 'rtk', label: '输出压缩', namespaces: ['extra-rtk-compact'] },
  { id: 'mcp', label: 'MCP', namespaces: ['extra-mcp'] },
  { id: 'image', label: '图片生成', namespaces: ['extra-image-gen'] },
];

/**
 * The accessible name and id prefix of the tablist. The control derives each tab
 * id as `<TAB_ID>-<group id>` and points it at `<TAB_ID>-<group id>-panel`, so the
 * panel below must carry that id and label itself back at the tab.
 */
var TAB_ID = 'extra-prompt-tabs';

/**
 * The official namespace that owns the delegation allow-list.
 *
 * This page only ever READS it. Which routes the delegating agent may actually
 * pick is DSH policy, written by the official Subagent settings card; a second
 * writer would let the two lists diverge silently. Reading it is what turns that
 * divergence into a visible warning instead.
 */
var OFFICIAL_NAMESPACE = 'subagent-model-selection-settings';

/** The snapshot reported for a form this page has none of (an absent cross-check). */
var ABSENT_SNAPSHOT = {
  status: 'unavailable', value: undefined, base: undefined, user: undefined, writable: false, revision: undefined,
};

/**
 * What the page shows above its cards: the package name and version, nothing
 * more. The artifact is hand-written with no build step, so the version cannot be
 * read from package.json at runtime; `test/client-bundle.test.mjs` asserts the two
 * stay in sync instead.
 */
var PLUGIN_LABEL = 'dsh-extra-prompt 0.4.1';

/** Copy for the shared form frame, from the plugin's own dictionary. */
var FORM_LABELS = {
  unavailable: '这一行没有挂载：在「插件」页打开它的开关后，这里才能编辑。',
  readOnly: '当前为内存模式，改动不会写入磁盘。',
  saveFailed: '保存未完全生效，改动仍保留在本页。',
  save: '保存',
  saving: '保存中…',
};

/** Copy for one field's override badge and the reset beside it. */
var OVERRIDDEN_LABEL = '已自定义';
var RESET_LABEL = '恢复默认';
var INVALID_LABEL = '请输入有效值';
var REQUIRED_ROUTE_LABEL = '每条路由都需要 provider 和 model。';
var SERVER_LIST_INVALID = '按提示修正后再保存。';

/**
 * The MCP server rules the card enforces before it will save.
 *
 * These mirror the Host's own model (`src/mcp/model.mjs`), which stays the
 * authority: it re-checks everything and additionally bounds the numbers. This
 * side only owns what would otherwise leave the document unusable with no visible
 * reason — a server that is listed and enabled but never connects. The two rule
 * sets are compared case by case in `test/client-bundle.test.mjs`.
 */
var SERVER_NAME_SHAPE = /^[A-Za-z0-9_-]{1,32}$/;
var ENV_NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;
var HEADER_NAME_SHAPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Transport choices, in the order the select shows them. The label stays short
 * because it shares the server's head row; the meaning is the option's tooltip and
 * the card summary. */
var MCP_TRANSPORTS = [
  ['stdio', 'stdio'],
  ['streamable-http', 'streamable-http'],
];
/** What each transport means, as the option's own tooltip. */
var MCP_TRANSPORT_NOTES = {
  stdio: '在 Host 本机启动子进程，不经过 Agent 沙箱',
  'streamable-http': '连接远程 HTTP 端点',
};
/**
 * The fields behind 高级设置, in render order.
 *
 * They are listed because a collapsed section cannot show its own errors: the card
 * restates an issue here that the current view has nowhere to put.
 */
var ADVANCED_FIELDS = [
  'toolCallTimeoutMs',
  'maxInstructionBytes',
  'failOnStartupError',
  'reconnectEnabled',
  'reconnectInitialDelayMs',
  'reconnectMaxDelayMs',
  'reconnectMaxAttempts',
];
/** A new server's transport; the entry is switched off until the user turns it on. */
var DEFAULT_TRANSPORT = 'stdio';

/**
 * Field descriptors driving the whole page. Keeping them declarative means one
 * renderer serves every namespace and a new tunable is a one-line addition.
 *
 * `blurb` is the one-line description the enable card shows; it is deliberately
 * shorter than `summary`, which sits at the top of the feature's own card.
 * `repo` is an optional upstream address, rendered as a link under the card's
 * summary for a feature whose dependency the user has to install themselves.
 * `enabled` is NOT a field here: it belongs to the enable card, which owns it for
 * every namespace at once.
 *
 * `kind`: text | textarea | number | boolean | select | routes | servers
 *
 * `icon` is a key of `HOST_ICON_NAMES`, not a glyph: the card title renders the
 * host's icon component for that key, the same way every other atom on this page
 * comes from the host.
 */
var PANELS = {
  'extra-prompt-injection': {
    icon: 'injection',
    title: '全局提示词注入',
    blurb: '每个会话的第一步注入一段固定文本。',
    summary: '把一段固定文本作为独立的一行注入每个会话的第一步，而不是并进 system prompt。清空即不注入。',
    fields: [
      {
        kind: 'textarea',
        field: 'text',
        label: '注入内容',
        rows: 6,
        placeholder: '例如：始终先用中文回答，并在改代码前先跑测试。',
        help: '改动在下一个 step 生效。清空后插件会追加一行说明，告知模型此前的注入已失效。',
      },
    ],
  },
  'extra-subagent-routing': {
    icon: 'routing',
    title: '子代理路由',
    blurb: '把「哪类任务交给哪个模型」写进 system prompt。',
    summary: '把「哪类任务交给哪个模型」写进 system prompt，并把每条说明写进模型目录的 description。可选的模型清单由 DSH 自己的子代理设置决定。',
    // This card supplies guidance and notes only. It reads the official
    // allow-list to warn when the two disagree, rather than writing a document
    // the official Subagent card owns.
    crossCheck: true,
    fields: [
      {
        kind: 'routes',
        field: 'routes',
        label: '路由',
        help: '每条路由由 provider、model 和可选说明组成。说明会同时写入模型目录的 description，两者保持一致。',
        invalidLabel: REQUIRED_ROUTE_LABEL,
      },
      {
        kind: 'textarea',
        field: 'guidance',
        label: '自定义指导正文',
        rows: 5,
        placeholder: '留空则按上面的路由自动生成。',
        help: '填写后整段替换自动生成的正文。',
      },
    ],
  },
  'extra-skill-installer': {
    icon: 'skill',
    title: 'Skill 安装',
    blurb: '提供 skill-install 工具，从 GitHub 安装 Skill。',
    summary: '提供 skill-install 工具，从 GitHub 仓库或目录 URL 安装 Skill；安装前按会话审批策略征求同意。',
    fields: [
      {
        kind: 'text',
        field: 'defaultRef',
        label: '默认 ref',
        placeholder: 'main',
        help: '模型未指定 ref 时使用。',
      },
      {
        kind: 'select',
        field: 'defaultMethod',
        label: '默认方式',
        options: [
          ['auto', 'auto — 先下载 zip，失败再走 git'],
          ['download', 'download — 仅下载 zip'],
          ['git', 'git — 仅克隆仓库'],
        ],
        help: '模型未指定 method 时使用。',
      },
    ],
  },
  'extra-rtk-compact': {
    icon: 'compact',
    title: 'rtk 输出压缩',
    blurb: '把 shell 输出交给 rtk 压缩后再交给模型。',
    summary: '把白名单命令的 shell 输出交给 rtk pipe 压缩后再交给模型。任何失败都原样透传，绝不会破坏工具调用。',
    repo: RTK_REPO,
    fields: [
      {
        kind: 'text',
        field: 'rtkPath',
        label: 'rtk 可执行文件路径',
        placeholder: '留空则从 PATH 解析 rtk',
        help: '改动会立即清除已缓存的解析结果，便于修正路径后马上生效。',
      },
      {
        kind: 'number',
        field: 'minBodyChars',
        label: '最小正文长度（字符）',
        min: 0,
        help: '短于该长度的输出不做压缩，避免为微小收益启动一个进程。',
      },
      { kind: 'number', field: 'timeoutMs', label: '超时（毫秒）', min: 1 },
      { kind: 'number', field: 'maxOutputBytes', label: '输出上限（字节）', min: 1 },
      { kind: 'boolean', field: 'gitStatus', label: '压缩 git status' },
      { kind: 'boolean', field: 'gitDiff', label: '压缩 git diff' },
      { kind: 'boolean', field: 'gitLog', label: '压缩 git log' },
      { kind: 'boolean', field: 'rg', label: '压缩 rg' },
      { kind: 'boolean', field: 'grep', label: '压缩 grep' },
    ],
  },
  'extra-mcp': {
    icon: 'mcp',
    title: 'MCP 服务器',
    blurb: '接入 MCP 服务器，每台组合一个官方的 dsh-mcp-client 实例。',
    summary: '每台服务器组合一个官方 dsh-mcp-client 实例，其工具以 mcp__<服务器名>__<工具名> 注册给模型。stdio 服务器在 Host 本机启动子进程，不经过 Agent 沙箱。',
    fields: [
      {
        kind: 'servers',
        field: 'servers',
        label: '服务器',
        help: '只有已启用的服务器会被连接；关闭的服务器既不启动进程，也不占用工具命名空间。',
        invalidLabel: SERVER_LIST_INVALID,
      },
    ],
  },
  'extra-image-gen': {
    // `mcp` is the existing HOST_ICON_NAMES key for the host's IconApiOutlineRegular;
    // reusing it keeps the image card on the same glyph without naming a new icon.
    icon: 'mcp',
    title: '图片生成',
    blurb: '提供 image_gen 工具，调用 OpenAI 兼容的生图接口。',
    summary: '提供 image_gen 工具，可复用已配置的 DSH 供应商端点与凭据，按配置的模型调用 /images/generations 或 /images/edits，把生成的图片存到输出目录并回传给模型；支持前台或后台任务。',
    fields: [
      {
        kind: 'provider',
        field: 'provider',
        label: '供应商',
        help: '选择后复用该供应商的 baseURL 与 apiKeyEnv，手动端点/凭据字段会自动隐藏；清除选择后恢复手动配置。所选供应商必须提供 OpenAI 兼容的 images 接口。',
      },
      {
        kind: 'text',
        field: 'baseURL',
        label: '接口地址（base URL）',
        placeholder: 'https://api.openai.com/v1',
        hideWhenProvider: true,
        help: '未选择供应商时使用；选择供应商后由供应商提供端点，本字段自动隐藏。',
      },
      {
        kind: 'text',
        field: 'apiKeyEnv',
        label: '密钥凭据名',
        placeholder: 'IMAGE_API_KEY',
        hideWhenProvider: true,
        help: '未选择供应商时使用；选择供应商后由供应商提供凭据，本字段自动隐藏。只从凭据或环境变量读取，不把密钥写进设置。',
      },
      {
        kind: 'text',
        field: 'model',
        label: '生图模型',
        placeholder: 'gpt-image-1',
        help: '模型名按服务商文档填写；留空时工具会提示先配置。',
      },
      {
        kind: 'select',
        field: 'endpoint',
        label: '默认端点',
        options: [
          ['generate', 'generate — /images/generations 新建图片'],
          ['edit', 'edit — /images/edits 编辑已有图片'],
        ],
        help: '调用时带参考图会自动走 edit；显式传 mode 时以调用参数为准。',
      },
      {
        kind: 'text',
        field: 'size',
        label: '默认尺寸',
        placeholder: '1024x1024，留空则不发送',
      },
      {
        kind: 'text',
        field: 'quality',
        label: '默认质量',
        placeholder: 'high / medium / low，留空则不发送',
      },
      {
        kind: 'text',
        field: 'outputDir',
        label: '输出目录',
        placeholder: '留空则保存到 DSH 主目录的 generated-images',
        help: '相对路径按会话工作目录解析。',
      },
      {
        kind: 'number',
        field: 'timeoutMs',
        label: '超时（毫秒）',
        min: 1000,
      },
    ],
  },
};

// --- styling -----------------------------------------------------------------
//
// The host's field chrome, copied from the two stylesheets this page has to match
// (`ui-primitives/src/settings-form/fields.module.css` for the label/badge/hint
// column and `ui-primitives/src/ConfigField.module.css` for the multi-line and
// enum controls) and re-declared under this page's own class names. Only
// `--dsw-*` alias tokens appear, so the page follows the active theme instead of
// pinning literals. Injected once, at apply time.

var STYLE_ID = 'dsh-extra-prompt-styles';
var CSS = [
  '.dsh-extra-page{display:flex;flex-direction:column;gap:14px;max-width:780px;padding:4px 0 28px;color:var(--dsw-alias-label-primary);box-sizing:border-box;}',
  '.dsh-extra-heading{margin:0 0 2px;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:8px;}',
  '.dsh-extra-headingIcon{display:inline-flex;align-items:center;color:var(--dsw-alias-label-secondary);flex:none;}',
  '.dsh-extra-intro{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);}',
  '.dsh-extra-card{box-sizing:border-box;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,0.04));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.16));border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px;box-shadow:0 1px 3px rgba(0,0,0,0.03);transition:border-color 0.18s ease;max-width:100%;}',
  '.dsh-extra-card:hover{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,0.28));}',
  '.dsh-extra-cardHead{display:flex;flex-direction:column;gap:2px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.1));}',
  '.dsh-extra-title{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);display:flex;align-items:center;gap:6px;}',
  '.dsh-extra-cardIcon{display:inline-flex;align-items:center;color:var(--dsw-alias-label-secondary);flex:none;}',
  '.dsh-extra-summary{margin:0;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary,inherit);}',
  '.dsh-extra-notice{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-bg-layer-2,rgba(249,115,22,0.08));border:1px solid var(--dsw-alias-border-l2,rgba(249,115,22,0.2));border-radius:8px;padding:8px 12px;}',
  '.dsh-extra-tabPanel{display:flex;flex-direction:column;gap:14px;}',
  'div[data-tabs="extra-prompt-tabs"]{display:inline-flex;align-items:center;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,0.1));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.18));border-radius:9999px;padding:2px;gap:2px;user-select:none;max-width:100%;box-sizing:border-box;}',
  'div[data-tabs="extra-prompt-tabs"] button[role="tab"]{border:none;background:transparent;padding:4px 12px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,inherit);border-radius:9999px;cursor:pointer;transition:all 0.16s cubic-bezier(0.4,0,0.2,1);display:inline-flex;align-items:center;justify-content:center;gap:4px;white-space:nowrap;line-height:1.3;}',
  'div[data-tabs="extra-prompt-tabs"] button[role="tab"]:hover:not(:disabled){color:var(--dsw-alias-label-primary,inherit);background:rgba(127,127,127,0.12);}',
  'div[data-tabs="extra-prompt-tabs"] button[role="tab"][aria-selected="true"]{background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,0.95));color:var(--dsw-alias-label-primary,inherit);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,0.12),0 0 0 1px var(--dsw-alias-border-l2,rgba(0,0,0,0.08));}',
  'div[data-tabs="extra-prompt-tabs"] button[role="tab"]:disabled{opacity:0.45;cursor:default;}',
  '.dsh-extra-field{display:flex;flex-direction:column;gap:6px;padding:8px 0;}',
  '.dsh-extra-field + .dsh-extra-field{border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.08));padding-top:10px;}',
  '.dsh-extra-head{display:flex;align-items:center;gap:8px;}',
  '.dsh-extra-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary);}',
  '.dsh-extra-badges{display:inline-flex;align-items:center;gap:6px;}',
  '.dsh-extra-reset{border:none;background:none;padding:0;font:inherit;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer;}',
  '.dsh-extra-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary);text-decoration:underline;}',
  '.dsh-extra-reset:disabled{cursor:default;}',
  '.dsh-extra-input{box-sizing:border-box;width:100%;padding:6px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.2));border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,0.04));color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;transition:border-color 0.15s ease,box-shadow 0.15s ease;}',
  '.dsh-extra-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px rgba(65,118,230,0.2);}',
  '.dsh-extra-input:disabled{color:var(--dsw-alias-label-tertiary);opacity:0.6;cursor:default;}',
  'textarea.dsh-extra-input{resize:vertical;min-height:80px;border-radius:8px;}',
  'select.dsh-extra-input{max-width:260px;cursor:pointer;border-radius:8px;padding:6px 10px;}',
  '.dsh-extra-hint{margin:0;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary);}',
  '.dsh-extra-link{color:var(--dsw-alias-link);text-decoration:none;}',
  '.dsh-extra-link:hover{text-decoration:underline;}',
  '.dsh-extra-invalid{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary);}',
  '.dsh-extra-servers{display:flex;flex-direction:column;gap:12px;}',
  '.dsh-extra-serverList{display:flex;flex-direction:column;gap:12px;}',
  '.dsh-extra-server{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.16));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,0.02));border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;box-shadow:0 1px 3px rgba(0,0,0,0.02);transition:border-color 0.18s ease;}',
  '.dsh-extra-server:hover{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,0.28));}',
  '.dsh-extra-serverHead{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}',
  'input.dsh-extra-serverName{flex:1 1 160px;width:auto;min-width:0;}',
  '.dsh-extra-serverHead > select.dsh-extra-input{flex:1 1 170px;max-width:none;width:auto;}',
  '.dsh-extra-serverActions{display:flex;align-items:center;gap:10px;margin-left:auto;}',
  '.dsh-extra-serverEnable{display:flex;align-items:center;gap:8px;}',
  '.dsh-extra-serverEnableLabel{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);}',
  '.dsh-extra-serverBody{display:flex;flex-direction:column;gap:10px;}',
  '.dsh-extra-serverBody .dsh-extra-field{padding:0;border-top:0;}',
  '.dsh-extra-serverRow{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px 14px;}',
  '.dsh-extra-serverTools{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}',
  '.dsh-extra-serverIssue{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary);}',
  '.dsh-extra-skillList{display:flex;flex-direction:column;gap:10px;}',
  '.dsh-extra-skillRow{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.16));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,0.02));border-radius:10px;padding:10px 14px;transition:border-color 0.18s ease;}',
  '.dsh-extra-skillRow:hover{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,0.28));}',
  '.dsh-extra-skillBody{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0;}',
  '.dsh-extra-skillName{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary);}',
  '.dsh-extra-skillMeta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-all;}',
  '.dsh-extra-skillActions{display:flex;align-items:center;gap:8px;flex:none;}',
  '.dsh-extra-bindings{display:flex;flex-direction:column;gap:6px;}',
  '.dsh-extra-bindingsHead{display:flex;align-items:center;gap:8px;}',
  '.dsh-extra-binding{display:grid;grid-template-columns:minmax(110px,1fr) minmax(110px,1.4fr) auto;gap:6px;align-items:center;}',
  '.dsh-extra-inputBad{border-color:var(--dsw-alias-state-error-primary)!important;}',
  '.dsh-extra-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px 16px;padding:4px 0;}',
  '.dsh-extra-toggleLabel{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary);}',
  '.dsh-extra-routes{display:flex;flex-direction:column;gap:8px;}',
  '.dsh-extra-route{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1.4fr) auto;gap:8px;align-items:center;}',
  '.dsh-extra-addRoute{align-self:flex-start;}',
  '.dsh-extra-page button:not([role="tab"]):not([role="switch"]):not(.dsh-extra-reset){border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.22));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,0.08));color:var(--dsw-alias-label-primary,inherit);border-radius:8px;padding:5px 12px;font-size:12px;font-weight:500;cursor:pointer;transition:all 0.15s ease;display:inline-flex;align-items:center;justify-content:center;gap:6px;}',
  '.dsh-extra-page button:not([role="tab"]):not([role="switch"]):not(.dsh-extra-reset):hover:not(:disabled){background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,0.14));border-color:var(--dsw-alias-border-l2,rgba(127,127,127,0.35));}',
  '.dsh-extra-page button:not([role="tab"]):not([role="switch"]):not(.dsh-extra-reset):disabled{opacity:0.45;cursor:default;}',
].join('');

/** Inject or update this page's stylesheet. Absent `document` (non-browser host) is a no-op. */
function ensureStyles() {
  if (typeof document === 'undefined' || document.head === null || document.head === undefined) return;
  var existing = document.getElementById(STYLE_ID);
  if (existing !== null) {
    if (existing.textContent !== CSS) {
      existing.textContent = CSS;
    }
    return;
  }
  var element = document.createElement('style');
  element.id = STYLE_ID;
  element.textContent = CSS;
  document.head.appendChild(element);
}

// --- field specs -------------------------------------------------------------
//
// One spec per field, shaped like the host's own `SettingsFieldSpec`: a draft is
// always text, `format` renders a stored value as that text, and `parse` returns
// the write the text stages, `{kind:'clear'}` for an empty draft, or undefined
// when the text is not a value the field accepts — which blocks the save instead
// of silently discarding what the user typed.

var ROUTE_SEPARATOR = '\t';

/**
 * Split route draft text into `[provider, model, note]` rows.
 *
 * Only a truly empty line is dropped. A row the user just added holds no text at
 * all, so it serializes to nothing but separators: trimming it away here would
 * make "add a row" a no-op and let the save write the routes away instead of
 * reporting the row as incomplete.
 */
function splitRouteRows(text) {
  if (text === '') return [];
  var rows = [];
  var lines = text.split('\n');
  for (var i = 0; i < lines.length; i += 1) {
    if (lines[i] === '') continue;
    var parts = lines[i].split(ROUTE_SEPARATOR);
    rows.push([parts[0] || '', parts[1] || '', parts[2] || '']);
  }
  return rows;
}

/** Render route rows back to draft text. */
function joinRouteRows(rows) {
  return rows.map(function (row) { return row.join(ROUTE_SEPARATOR); }).join('\n');
}

/** True when the draft is empty, which every spec reads as "drop the override". */
function isEmptyDraft(text) {
  return text === undefined || text === null || String(text).trim() === '';
}

/**
 * Build the format/parse pair for one field descriptor.
 * @param spec - the field descriptor from PANELS.
 * @returns the field's draft conversion spec.
 */
function makeSpec(spec) {
  if (spec.kind === 'number') {
    return {
      format: function (value) { return typeof value === 'number' ? String(value) : ''; },
      parse: function (text) {
        if (isEmptyDraft(text)) return { kind: 'clear' };
        var parsed = Number(String(text).trim());
        if (!isFinite(parsed)) return undefined;
        if (spec.min !== undefined && parsed < spec.min) return undefined;
        return { kind: 'set', value: parsed };
      },
    };
  }
  if (spec.kind === 'boolean') {
    return {
      // Absent means the schema default, which this side cannot read; false is
      // only ever what the Host itself resolved to.
      format: function (value) { return value === true ? 'true' : 'false'; },
      parse: function (text) {
        if (isEmptyDraft(text)) return { kind: 'clear' };
        if (text === 'true') return { kind: 'set', value: true };
        if (text === 'false') return { kind: 'set', value: false };
        return undefined;
      },
    };
  }
  if (spec.kind === 'provider') {
    return {
      kind: 'provider',
      format: function (value) { return typeof value === 'string' ? value : ''; },
      parse: function (text) {
        if (isEmptyDraft(text)) return { kind: 'clear' };
        return { kind: 'set', value: String(text).trim() };
      },
    };
  }
  if (spec.kind === 'select') {
    return {
      format: function (value) { return typeof value === 'string' ? value : ''; },
      parse: function (text) {
        if (isEmptyDraft(text)) return { kind: 'clear' };
        var trimmed = String(text).trim();
        for (var i = 0; i < spec.options.length; i += 1) {
          if (spec.options[i][0] === trimmed) return { kind: 'set', value: trimmed };
        }
        return undefined;
      },
    };
  }
  if (spec.kind === 'routes') {
    return {
      format: function (value) {
        if (!Array.isArray(value)) return '';
        return joinRouteRows(value.map(function (route) {
          if (route === null || typeof route !== 'object') return ['', '', ''];
          return [
            typeof route.provider === 'string' ? route.provider : '',
            typeof route.model === 'string' ? route.model : '',
            typeof route.note === 'string' ? route.note : '',
          ];
        }));
      },
      parse: function (text) {
        var raw = text === undefined || text === null ? '' : String(text);
        // A draft made only of separators is an incomplete row, not an empty
        // field, so the whitespace-only shortcut must not swallow it.
        if (raw.trim() === '' && raw.indexOf(ROUTE_SEPARATOR) < 0) return { kind: 'clear' };
        var rows = splitRouteRows(raw);
        if (rows.length === 0) return { kind: 'clear' };
        var routes = [];
        for (var i = 0; i < rows.length; i += 1) {
          var provider = rows[i][0].trim();
          var model = rows[i][1].trim();
          // An incomplete row is a draft the Host would reject; block the save.
          if (provider === '' || model === '') return undefined;
          routes.push({ provider: provider, model: model, note: rows[i][2].trim() });
        }
        return { kind: 'set', value: routes };
      },
    };
  }
  if (spec.kind === 'servers') {
    return {
      // The editor writes structured entries, one control per field, so there is
      // no draft text to convert: `format` hands back the entries as the editor
      // wants them, and `parse` only answers whether they are fit to save. An
      // empty draft — the reset button, or every entry removed — reads as a clear,
      // which is also what an empty array means to the Host.
      format: function (value) { return serverList(value); },
      parse: function (value) {
        if (isEmptyDraft(value)) return { kind: 'clear' };
        var servers = serverList(value);
        if (serverIssues(servers).length > 0) return undefined;
        return { kind: 'set', value: servers };
      },
    };
  }
  // text and textarea share one free-text spec: an empty draft clears the field.
  return {
    format: function (value) { return typeof value === 'string' ? value : ''; },
    parse: function (text) {
      if (isEmptyDraft(text)) return { kind: 'clear' };
      return { kind: 'set', value: String(text).trim() };
    },
  };
}

// Attach the spec to each field descriptor once, at module load.
Object.keys(PANELS).forEach(function (ns) {
  PANELS[ns].fields.forEach(function (spec) { spec.spec = makeSpec(spec); });
});

// --- helpers -----------------------------------------------------------------

function hasOwn(object, key) {
  return object !== null && object !== undefined && Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Subscribe to one namespace's ConfigForm, or to nothing when the caller has no
 * form for it (`form === null` keeps the hook order stable across panels).
 *
 * The renderer's sanctioned channel for live values is the injected `hooks`
 * compartment, but that requires an in-repo framework hook. This out-of-tree
 * bundle subscribes through React directly instead; the ConfigForm contract
 * (`getSnapshot`/`subscribe`) is a plain observable, so the result is identical.
 * Convert to a `hooks` compartment entry if this is ever contributed upstream.
 */
function useForm(form) {
  var pair = React.useState(function () {
    return form === null || form === undefined ? ABSENT_SNAPSHOT : form.getSnapshot();
  });
  var snapshot = pair[0];
  var setSnapshot = pair[1];
  React.useEffect(function () {
    if (form === null || form === undefined) return undefined;
    setSnapshot(form.getSnapshot());
    return form.subscribe(function () { setSnapshot(form.getSnapshot()); });
  }, [form]);
  return snapshot;
}

/**
 * Warn when the configured routes are not the ones the delegation policy allows.
 *
 * The plugin writes guidance and catalog notes; the official Subagent settings
 * card owns the allow-list. Configured routes the policy does not list would be
 * named in the system prompt and then refused by the delegation tool, which is
 * invisible from this card alone — so say it here. An unserved or unreadable
 * policy namespace yields no warning: guessing would be worse than silence.
 *
 * @param snapshot - the official `subagent-model-selection-settings` snapshot.
 * @param routes - the routes as they currently read on this card.
 * @returns the warning text, or null when the two already agree.
 */
function allowanceWarning(snapshot, routes) {
  var configured = Array.isArray(routes) ? routes : [];
  if (configured.length === 0) return null;
  if (snapshot.status !== 'ready') return null;
  var policy = snapshot.value;
  if (policy === null || typeof policy !== 'object') return null;
  var allowed = {};
  if (Array.isArray(policy.allowedModels)) {
    policy.allowedModels.forEach(function (entry) {
      if (entry === null || typeof entry !== 'object') return;
      if (typeof entry.provider !== 'string' || typeof entry.model !== 'string') return;
      allowed[entry.provider + '/' + entry.model] = true;
    });
  }
  var missing = [];
  configured.forEach(function (route) {
    if (route === null || typeof route !== 'object') return;
    if (typeof route.provider !== 'string' || typeof route.model !== 'string') return;
    var key = route.provider + '/' + route.model;
    if (allowed[key] !== true && missing.indexOf(key) < 0) missing.push(key);
  });
  var where = '请在「插件」页的「子代理」卡片里';
  if (policy.enabled !== true && missing.length > 0) {
    return '子代理委派没有启用模型白名单，且下列路由不在允许清单里，委派时会被拒绝：'
      + missing.join('、') + '。' + where + '启用它并勾选这些模型。';
  }
  if (policy.enabled !== true) {
    return '子代理委派没有启用模型白名单，上面的路由不会被接受。' + where + '启用它并勾选这些模型。';
  }
  if (missing.length > 0) {
    return '下列路由不在子代理的允许清单里，委派时会被拒绝：' + missing.join('、') + '。' + where + '勾选它们。';
  }
  return null;
}

// --- MCP server entries --------------------------------------------------------
//
// The card writes the whole `servers` array, so it reads entries here rather than
// normalizing them: the Host's own schema has already filled every default by the
// time a snapshot reaches this side, and an entry is written back as a spread of
// the original. These accessors only cover a document that a hand edit left
// incomplete.

/** The Host's cap on configured servers, restated so the card enforces it too. */
var MAX_MCP_SERVERS = 64;
/** Bounds the Host applies to the numbers `mcp-client` declares bare. */
var MCP_LIMITS = {
  toolCallTimeoutMs: [100, 300000],
  reconnectInitialDelayMs: [1, 300000],
  reconnectMaxDelayMs: [1, 300000],
  reconnectMaxAttempts: [1, 100],
  maxInstructionBytes: [1, Number.MAX_SAFE_INTEGER],
};

/**
 * The entries the card will render.
 * @param value - the `servers` field of a snapshot.
 * @returns the object entries, in document order.
 */
function serverList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(function (entry) {
    return entry !== null && typeof entry === 'object' && !Array.isArray(entry);
  });
}

/**
 * A string field of one entry.
 * @param entry - a server entry.
 * @param field - its field name.
 * @returns the value when it is a string, else the empty string.
 */
function serverText(entry, field) {
  return typeof entry[field] === 'string' ? entry[field] : '';
}

/**
 * A numeric field of one entry.
 * @param entry - a server entry.
 * @param field - its field name.
 * @param fallback - the value to read when the field is missing or not a number.
 * @returns the numeric value.
 */
function serverNumber(entry, field, fallback) {
  var value = entry[field];
  return typeof value === 'number' && isFinite(value) ? value : fallback;
}

/**
 * A boolean field of one entry, with a default for an entry that predates it.
 * @param entry - a server entry.
 * @param field - its field name.
 * @param fallback - the value to read when the field is absent.
 * @returns whether the field is on.
 */
function serverFlag(entry, field, fallback) {
  return entry[field] === undefined ? fallback : entry[field] === true;
}

/**
 * A binding dictionary of one entry.
 * @param entry - a server entry.
 * @param field - `env` or `headers`.
 * @returns the string-to-string record, empty when the field is unusable.
 */
function serverRecord(entry, field) {
  var value = entry[field];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  var out = {};
  Object.keys(value).forEach(function (key) {
    if (typeof value[key] === 'string') out[key] = value[key];
  });
  return out;
}

/**
 * The argument list of one entry, one argument per line in the editor.
 * @param entry - a server entry.
 * @returns the string arguments.
 */
function serverArgs(entry) {
  if (!Array.isArray(entry.args)) return [];
  return entry.args.filter(function (argument) { return typeof argument === 'string'; });
}

/**
 * Whether a URL is an endpoint the card will save.
 *
 * Credentials embedded in the URL are refused for the same reason the Host refuses
 * them: they would be sent on every request while staying invisible in the field
 * that shows the URL.
 *
 * @param value - candidate URL.
 * @returns true when it is absolute http(s) with no userinfo.
 */
function serverUrlOk(value) {
  var parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return parsed.username === '' && parsed.password === '';
}

/**
 * Every reason the given entries cannot be saved.
 *
 * The message text is shared with the Host's model on purpose: the same problem
 * should read the same way wherever it is reported.
 *
 * @param servers - the entries as the card holds them.
 * @returns issues in document order, the first of them naming a document-level one.
 */
function serverIssues(servers) {
  var issues = [];
  var seen = {};
  var push = function (index, field, message) {
    issues.push({ index: index, field: field, message: message });
  };
  if (servers.length > MAX_MCP_SERVERS) {
    push(-1, 'servers', '最多 ' + MAX_MCP_SERVERS + ' 台服务器，当前 ' + servers.length + ' 台。');
  }
  servers.forEach(function (entry, index) {
    var name = serverText(entry, 'serverName');
    if (!SERVER_NAME_SHAPE.test(name)) {
      push(index, 'serverName', '名称只能包含字母、数字、下划线和连字符，长度 1–32。');
    } else if (hasOwn(seen, name)) {
      push(index, 'serverName', '名称与第 ' + (seen[name] + 1) + ' 台服务器重复；它同时是工具命名空间，必须唯一。');
    } else {
      seen[name] = index;
    }
    if (serverText(entry, 'transport') === 'streamable-http') {
      var url = serverText(entry, 'url').trim();
      if (url === '') push(index, 'url', 'Streamable HTTP 服务器必须填写 URL。');
      else if (!serverUrlOk(serverText(entry, 'url'))) push(index, 'url', 'URL 必须是不含用户名密码的 http(s) 地址。');
      Object.keys(serverRecord(entry, 'headers')).forEach(function (key) {
        if (!HEADER_NAME_SHAPE.test(key)) push(index, 'headers', '请求头名 “' + key + '” 无效。');
      });
    } else {
      if (serverText(entry, 'command').trim() === '') push(index, 'command', 'stdio 服务器必须填写启动命令。');
      Object.keys(serverRecord(entry, 'env')).forEach(function (key) {
        if (!ENV_NAME_SHAPE.test(key)) push(index, 'env', '环境变量名 “' + key + '” 无效。');
      });
    }
    var checkBounds = function (field, integerMessage) {
      var bounds = MCP_LIMITS[field];
      var value = serverNumber(entry, field, bounds[0]);
      if (integerMessage !== undefined && !Number.isInteger(value)) {
        push(index, field, integerMessage);
        return;
      }
      if (value < bounds[0] || value > bounds[1]) {
        push(index, field, '需在 ' + bounds[0] + '–' + bounds[1] + ' 之间。');
      }
    };
    checkBounds('toolCallTimeoutMs');
    checkBounds('maxInstructionBytes', '指令字节上限需为不小于 1 的整数。');
    // The reconnect numbers only matter while reconnect is on, exactly as on the
    // Host side, and `mcp-client` additionally requires the first delay to be the
    // smaller of the two.
    if (serverFlag(entry, 'reconnectEnabled', true)) {
      checkBounds('reconnectInitialDelayMs');
      checkBounds('reconnectMaxDelayMs');
      checkBounds('reconnectMaxAttempts');
      if (serverNumber(entry, 'reconnectInitialDelayMs', 500) > serverNumber(entry, 'reconnectMaxDelayMs', 30000)) {
        push(index, 'reconnectInitialDelayMs', '首次延迟不能大于最大延迟。');
      }
    }
  });
  return issues;
}

/**
 * A new, switched-off entry.
 *
 * Switched off on purpose: saving must not start a child process the user has not
 * reviewed. Turning one on is a separate, deliberate act.
 * @returns a server entry with the Host's own defaults.
 */
function newServerEntry() {
  return {
    serverName: '',
    enabled: false,
    transport: DEFAULT_TRANSPORT,
    command: '',
    args: [],
    env: {},
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
  };
}

/**
 * The next array after editing one entry.
 * @param servers - the current entries.
 * @param index - which entry to change.
 * @param patch - the fields to overwrite on it.
 * @returns a new array, with the untouched entries shared by reference.
 */
function withServer(servers, index, patch) {
  return servers.map(function (entry, at) {
    return at === index ? Object.assign({}, entry, patch) : entry;
  });
}

/** The official field chrome, for the controls `SettingsValueField` does not cover. */
function fieldHead(props) {
  return h('div', { className: 'dsh-extra-head' }, [
    h('label', { key: 'label', className: 'dsh-extra-label', htmlFor: props.id }, props.label),
    props.overridden
      ? h('span', { key: 'badges', className: 'dsh-extra-badges' }, [
        h(Tag, { key: 'tag', tone: 'neutral' }, OVERRIDDEN_LABEL),
        h('button', {
          key: 'reset',
          type: 'button',
          className: 'dsh-extra-reset',
          disabled: props.disabled === true,
          onClick: props.onReset,
        }, RESET_LABEL),
      ])
      : null,
  ]);
}

// --- field controls ----------------------------------------------------------

/**
 * The provider picker for the image card.
 *
 * The list is Host state, not a config namespace: it merges the routes DSH has
 * configured with the ones this package can name. It is requested only when the
 * image card is mounted, so the other cards never pay for this read. A failed
 * read leaves the manual fields usable instead of blocking the whole card.
 */
function ProviderSelect(props) {
  var pair = React.useState({ status: 'loading', options: [], error: '' });
  var state = pair[0];
  var setState = pair[1];

  React.useEffect(function () {
    var live = true;
    settingsApi('image/providers').then(function (value) {
      if (!live) return;
      var rows = value !== null && typeof value === 'object' && Array.isArray(value.providers)
        ? value.providers
        : [];
      setState({ status: 'ready', options: rows, error: '' });
    }, function (error) {
      if (!live) return;
      setState({
        status: 'error',
        options: [],
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return function () { live = false; };
  }, []);

  var current = typeof props.text === 'string' ? props.text : '';
  var options = state.options.filter(function (entry) {
    return entry !== null && typeof entry === 'object'
      && typeof entry.provider === 'string' && entry.provider !== '';
  });
  var selected = null;
  options.forEach(function (entry) { if (entry.provider === current) selected = entry; });

  var children = [h('option', { key: '', value: '' }, '手动填写（不使用供应商）')];
  options.forEach(function (entry) {
    var label = (typeof entry.displayName === 'string' && entry.displayName !== ''
      ? entry.displayName
      : entry.provider) + ' · ' + entry.provider;
    children.push(h('option', {
      key: entry.provider,
      value: entry.provider,
      title: typeof entry.baseURL === 'string' ? entry.baseURL : '',
    }, label));
  });
  // A configured value can outlive the provider it names. Keep it visible so the
  // card does not silently look unconfigured; the Host reports the real refusal.
  if (current !== '' && selected === null) {
    children.push(h('option', { key: '__current', value: current }, current + '（当前值，已不在配置中）'));
  }

  var note = null;
  if (state.status === 'loading') {
    note = h('p', { key: 'note', className: 'dsh-extra-hint' }, '正在读取已配置的供应商…');
  } else if (state.error !== '') {
    note = h('p', { key: 'note', className: 'dsh-extra-invalid' }, '读取供应商失败：' + state.error);
  } else if (options.length === 0) {
    note = h('p', { key: 'note', className: 'dsh-extra-hint' }, '没有找到已配置的供应商；可以继续使用下面的手动配置。');
  } else if (selected !== null) {
    var selectedBaseURL = typeof selected.baseURL === 'string' ? selected.baseURL : '';
    var selectedKey = typeof selected.apiKeyEnv === 'string' ? selected.apiKeyEnv : '';
    note = h('p', { key: 'note', className: 'dsh-extra-hint' },
      '将复用端点：' + (selectedBaseURL === '' ? '未配置' : selectedBaseURL)
      + '；凭据：' + (selectedKey === '' ? '不需要密钥（请求不带认证）' : selectedKey));
  }

  return h('div', { className: 'dsh-extra-provider' }, [
    h('select', {
      key: 'control',
      id: props.id,
      className: 'dsh-extra-input',
      value: current,
      disabled: props.disabled,
      onChange: function (event) { props.onChange(event.target.value); },
    }, children),
    note,
  ]);
}

/** The route list: one row per route, plus the add control beneath it. */
function RoutesEditor(props) {
  var rows = splitRouteRows(props.text);
  var commit = function (next) { props.onChange(joinRouteRows(next)); };
  var replace = function (index, cell, value) {
    commit(rows.map(function (row, at) {
      if (at !== index) return row;
      var next = row.slice();
      next[cell] = value;
      return next;
    }));
  };
  var controls = rows.map(function (row, index) {
    return h('div', { key: index, className: 'dsh-extra-route' }, [
      h('input', {
        key: 'provider', type: 'text', className: 'dsh-extra-input', value: row[0],
        placeholder: 'provider', disabled: props.disabled,
        'aria-label': 'provider',
        onChange: function (event) { replace(index, 0, event.target.value); },
      }),
      h('input', {
        key: 'model', type: 'text', className: 'dsh-extra-input', value: row[1],
        placeholder: 'model', disabled: props.disabled,
        'aria-label': 'model',
        onChange: function (event) { replace(index, 1, event.target.value); },
      }),
      h('input', {
        key: 'note', type: 'text', className: 'dsh-extra-input', value: row[2],
        placeholder: '说明（可选）', disabled: props.disabled,
        'aria-label': '说明',
        onChange: function (event) { replace(index, 2, event.target.value); },
      }),
      h(Button, {
        key: 'remove', variant: 'outline', size: 'sm', disabled: props.disabled,
        onClick: function () {
          commit(rows.filter(function (_, at) { return at !== index; }));
        },
      }, '删除'),
    ]);
  });
  controls.push(h(Button, {
    key: 'add', variant: 'outline', size: 'sm', className: 'dsh-extra-addRoute',
    disabled: props.disabled,
    onClick: function () { commit(rows.concat([['', '', '']])); },
  }, '添加一条路由'));
  return h('div', { className: 'dsh-extra-routes' }, controls);
}

// --- the page ----------------------------------------------------------------

/**
 * One namespace: its own staged draft, its own save, inside the shared form frame.
 *
 * Each namespace is a separate settings document with its own revision, its own
 * writability and its own host row, so each gets its own save — the frame's save
 * control writes exactly the edits staged on this card and nothing else.
 */
/**
 * Key/value editor for one binding dictionary (`env` or `headers`).
 *
 * The dictionary is stored as the Host's schema wants it, so a row is added under
 * a free placeholder name and renamed afterwards. A rename onto a name that is
 * already taken is refused rather than allowed to overwrite the other value, and
 * the refused text stays visible long enough to explain itself.
 *
 * @param props - `{ kind, bindings, disabled, onChange }`.
 * @returns the editor element.
 */
function BindingsEditor(props) {
  var bindings = props.bindings;
  var names = Object.keys(bindings);
  var shape = props.kind === 'env' ? ENV_NAME_SHAPE : HEADER_NAME_SHAPE;
  var attemptState = React.useState(null);
  var attempt = attemptState[0];
  var setAttempt = attemptState[1];

  /**
   * Rename one key, keeping the dictionary's order.
   * @param at - the index being renamed.
   * @param nextName - the name typed so far.
   */
  var rename = function (at, nextName) {
    var current = names[at];
    if (nextName !== current && hasOwn(bindings, nextName)) {
      setAttempt({ at: at, name: nextName });
      return;
    }
    setAttempt(null);
    var out = {};
    names.forEach(function (key, index) {
      out[index === at ? nextName : key] = bindings[key];
    });
    props.onChange(out);
  };

  /**
   * Add a row under the first free placeholder name.
   */
  var add = function () {
    var suffix = names.length + 1;
    var name = 'NEW_KEY';
    while (hasOwn(bindings, name)) {
      suffix += 1;
      name = 'NEW_KEY_' + suffix;
    }
    var out = Object.assign({}, bindings);
    out[name] = '';
    props.onChange(out);
  };

  var rows = names.map(function (name, at) {
    var shown = attempt !== null && attempt.at === at ? attempt.name : name;
    var nameBad = !shape.test(shown) || (attempt !== null && attempt.at === at);
    var control = function (key, className, value, onInput, invalid, label) {
      return h('input', {
        key: key,
        className: className,
        type: 'text',
        value: value,
        disabled: props.disabled,
        spellCheck: false,
        'aria-label': label,
        'aria-invalid': invalid ? true : undefined,
        onChange: function (event) { onInput(event.target.value); },
      });
    };
    return h('div', { key: name, className: 'dsh-extra-binding' }, [
      control('name', nameBad ? 'dsh-extra-input dsh-extra-inputBad' : 'dsh-extra-input',
        shown, function (next) { rename(at, next); }, nameBad, props.label + ' 名称'),
      control('value', 'dsh-extra-input', bindings[name], function (next) {
        var out = Object.assign({}, bindings);
        out[name] = next;
        props.onChange(out);
      }, false, props.label + ' 值'),
      h(Button, {
        key: 'remove',
        size: 'small',
        disabled: props.disabled,
        onClick: function () {
          var out = Object.assign({}, bindings);
          delete out[name];
          setAttempt(null);
          props.onChange(out);
        },
      }, '删除'),
    ]);
  });

  return h('div', { className: 'dsh-extra-field' }, [
    h('div', { key: 'head', className: 'dsh-extra-bindingsHead' }, [
      h('span', { key: 'label', className: 'dsh-extra-label' }, props.label),
      h(Button, {
        key: 'add',
        size: 'small',
        disabled: props.disabled,
        onClick: add,
      }, '添加一行'),
    ]),
    // Saying "no rows" beats leaving the label followed by nothing but prose, which
    // read as if the note were the field's content.
    names.length === 0
      ? h('p', { key: 'empty', className: 'dsh-extra-hint' }, '没有条目。')
      : h('div', { key: 'rows', className: 'dsh-extra-bindings' }, rows),
    h('p', { key: 'note', className: 'dsh-extra-hint' },
      props.kind === 'env'
        ? '值以明文保存在 profile 的 cordis.patch.yml 中。'
        : '值随每个请求发送，并以明文保存在 profile 的 cordis.patch.yml 中。'),
    props.message === undefined
      ? null
      : h('p', { key: 'message', className: 'dsh-extra-invalid' }, props.message),
  ]);
}

/**
 * One MCP server entry.
 *
 * @param props - `{ entry, issues, disabled, onChange, onRemove }`.
 * @returns the entry card.
 */
function ServerCard(props) {
  var entry = props.entry;
  var advancedState = React.useState(false);
  var advanced = advancedState[0];
  var setAdvanced = advancedState[1];
  var remote = serverText(entry, 'transport') === 'streamable-http';

  /**
   * The message for one field, when the card has one.
   * @param field - the field name.
   * @returns the message, or undefined.
   */
  var messageOf = function (field) {
    var found;
    props.issues.forEach(function (issue) { if (issue.field === field && found === undefined) found = issue.message; });
    return found;
  };

  var set = function (patch) { props.onChange(patch); };

  var textControl = function (field, value, onInput, invalid, placeholder) {
    return h('input', {
      key: field,
      className: 'dsh-extra-input',
      type: 'text',
      value: value,
      placeholder: placeholder === undefined ? undefined : placeholder,
      disabled: props.disabled,
      spellCheck: false,
      'aria-invalid': invalid ? true : undefined,
      'aria-label': field,
      onChange: function (event) { onInput(event.target.value); },
    });
  };

  var numberControl = function (field, value, min, max) {
    return h('input', {
      key: field,
      className: 'dsh-extra-input',
      type: 'number',
      inputMode: 'numeric',
      value: String(value),
      min: String(min),
      max: String(max),
      step: '1',
      disabled: props.disabled,
      'aria-label': field,
      'aria-invalid': messageOf(field) === undefined ? undefined : true,
      onChange: function (event) {
        if (event.target.value === '') return;
        var next = Number(event.target.value);
        if (isFinite(next)) set({ [field]: next });
      },
    });
  };

  var labeled = function (field, label, control) {
    var message = messageOf(field);
    return h('div', { key: field, className: 'dsh-extra-field' }, [
      h('span', { key: 'label', className: 'dsh-extra-label' }, label),
      control,
      message === undefined ? null : h('span', { key: 'message', className: 'dsh-extra-invalid' }, message),
    ]);
  };

  var toggle = function (field, label, fallback) {
    return h('div', { key: field, className: 'dsh-extra-field' }, [
      h('div', { key: 'row', className: 'dsh-extra-toggle' }, [
        h('span', { key: 'label', className: 'dsh-extra-toggleLabel' }, label),
        h(Switch, {
          key: 'switch',
          checked: serverFlag(entry, field, fallback),
          label: label,
          disabled: props.disabled,
          onChange: function (next) { set({ [field]: next === true }); },
        }),
      ]),
    ]);
  };

  /** One line of the body; the controls it holds share an equal-width column. */
  var row = function (key, children) {
    return h('div', { key: key, className: 'dsh-extra-serverRow' }, children);
  };

  // Rows rather than one grid: a single-line input beside a three-line textarea is
  // what made this card ragged, so only controls of the same kind share a line and
  // everything else spans the card.
  var transportRows = remote
    ? [
      row('url', [
        labeled('url', 'URL', textControl('url', serverText(entry, 'url'),
          function (next) { set({ url: next }); }, messageOf('url') !== undefined, 'https://mcp.example/mcp')),
      ]),
      h(BindingsEditor, {
        key: 'headers',
        kind: 'headers',
        label: '请求头',
        bindings: serverRecord(entry, 'headers'),
        disabled: props.disabled,
        message: messageOf('headers'),
        onChange: function (next) { set({ headers: next }); },
      }),
    ]
    : [
      row('command', [
        labeled('command', '启动命令', textControl('command', serverText(entry, 'command'),
          function (next) { set({ command: next }); }, messageOf('command') !== undefined, 'npx')),
        labeled('cwd', '工作目录', textControl('cwd', serverText(entry, 'cwd'),
          function (next) { set({ cwd: next }); }, false, '留空则用 Host 的工作目录')),
      ]),
      labeled('args', '参数（每行一个）', h('textarea', {
        key: 'args',
        className: 'dsh-extra-input dsh-extra-textarea',
        rows: 3,
        value: serverArgs(entry).join('\n'),
        disabled: props.disabled,
        spellCheck: false,
        onChange: function (event) {
          set({ args: event.target.value.split('\n').filter(function (line) { return line.trim() !== ''; }) });
        },
      })),
      h(BindingsEditor, {
        key: 'env',
        kind: 'env',
        label: '环境变量',
        bindings: serverRecord(entry, 'env'),
        disabled: props.disabled,
        message: messageOf('env'),
        onChange: function (next) { set({ env: next }); },
      }),
    ];

  var advancedRows = advanced
    ? [
      row('timeouts', [
        labeled('toolCallTimeoutMs', '单次调用超时（毫秒）',
          numberControl('toolCallTimeoutMs', serverNumber(entry, 'toolCallTimeoutMs', 60000), 100, 300000)),
        labeled('maxInstructionBytes', '指令字节上限',
          numberControl('maxInstructionBytes', serverNumber(entry, 'maxInstructionBytes', 32768), 1, Number.MAX_SAFE_INTEGER)),
      ]),
      toggle('failOnStartupError', '启动失败即视为该服务器加载失败（否则后台重连）', false),
      toggle('reconnectEnabled', '断线后自动重连', true),
      row('reconnect', [
        labeled('reconnectInitialDelayMs', '首次重连延迟（毫秒）',
          numberControl('reconnectInitialDelayMs', serverNumber(entry, 'reconnectInitialDelayMs', 500), 1, 300000)),
        labeled('reconnectMaxDelayMs', '最大重连延迟（毫秒）',
          numberControl('reconnectMaxDelayMs', serverNumber(entry, 'reconnectMaxDelayMs', 30000), 1, 300000)),
        labeled('reconnectMaxAttempts', '最大重连次数',
          numberControl('reconnectMaxAttempts', serverNumber(entry, 'reconnectMaxAttempts', 10), 1, 100)),
      ]),
    ]
    : [];

  // Every issue is stated once, where it belongs: under its own control when that
  // control is on screen, and here only when it is not (a collapsed 高级设置), so the
  // card never repeats itself.
  var visible = ['serverName']
    .concat(remote ? ['url', 'headers'] : ['command', 'args', 'cwd', 'env'])
    .concat(advanced ? ADVANCED_FIELDS : []);
  var rest = props.issues.filter(function (issue) { return visible.indexOf(issue.field) < 0; });
  var nameMessage = messageOf('serverName');

  return h('section', { className: 'dsh-extra-server' }, [
    h('div', { key: 'head', className: 'dsh-extra-serverHead' }, [
      h('input', {
        key: 'name',
        className: nameMessage === undefined
          ? 'dsh-extra-input dsh-extra-serverName'
          : 'dsh-extra-input dsh-extra-serverName dsh-extra-inputBad',
        type: 'text',
        value: serverText(entry, 'serverName'),
        placeholder: '服务器名',
        disabled: props.disabled,
        spellCheck: false,
        'aria-label': '服务器名',
        'aria-invalid': nameMessage === undefined ? undefined : true,
        onChange: function (event) { set({ serverName: event.target.value }); },
      }),
      h('select', {
        key: 'transport',
        className: 'dsh-extra-input dsh-extra-select',
        value: serverText(entry, 'transport') === 'streamable-http' ? 'streamable-http' : 'stdio',
        disabled: props.disabled,
        'aria-label': '传输方式',
        onChange: function (event) { set({ transport: event.target.value }); },
      }, MCP_TRANSPORTS.map(function (option) {
        return h('option', { key: option[0], value: option[0], title: MCP_TRANSPORT_NOTES[option[0]] }, option[1]);
      })),
      // The two right-hand controls stay one unit, so a narrow card wraps them
      // together instead of leaving 删除 alone on the next line.
      h('div', { key: 'actions', className: 'dsh-extra-serverActions' }, [
        h('span', { key: 'enable', className: 'dsh-extra-serverEnable' }, [
          h('span', { key: 'label', className: 'dsh-extra-serverEnableLabel' }, '启用'),
          h(Switch, {
            key: 'switch',
            checked: serverFlag(entry, 'enabled', false),
            label: '启用该服务器',
            disabled: props.disabled,
            onChange: function (next) { set({ enabled: next === true }); },
          }),
        ]),
        h(Button, {
          key: 'remove',
          size: 'small',
          disabled: props.disabled,
          onClick: props.onRemove,
        }, '删除'),
      ]),
    ]),
    nameMessage === undefined
      ? null
      : h('p', { key: 'nameIssue', className: 'dsh-extra-invalid' }, nameMessage),
    h('div', { key: 'body', className: 'dsh-extra-serverBody' }, transportRows
      .concat([h('div', { key: 'advanced', className: 'dsh-extra-serverTools' }, [
        h(Button, {
          key: 'toggle',
          size: 'small',
          disabled: props.disabled,
          // The host button takes its leading glyph through `icon`, so the chevron
          // gets the atom's own icon slot instead of riding inside the label. 13px
          // is what the host's own `Button size="sm"` callers pass.
          icon: h(iconOf(advanced ? 'expand' : 'collapse'), { size: 13 }),
          onClick: function () { setAdvanced(!advanced); },
        }, advanced ? '收起高级设置' : '高级设置'),
      ])])
      .concat(advancedRows)),
    rest.length === 0 ? null : h('p', { key: 'rest', className: 'dsh-extra-invalid' },
      rest.map(function (issue) { return issue.message; }).join(' ')),
  ]);
}

/**
 * The whole `servers` field: one card per entry, plus the way to add one.
 *
 * @param props - `{ value, disabled, onChange }`.
 * @returns the list editor.
 */
function ServersEditor(props) {
  var servers = serverList(props.value);
  var issues = serverIssues(servers);
  var documentIssues = issues.filter(function (issue) { return issue.index < 0; });
  var issuesOf = function (index) {
    return issues.filter(function (issue) { return issue.index === index; });
  };

  var cards = servers.map(function (entry, index) {
    return h(ServerCard, {
      key: String(index) + '-' + serverText(entry, 'serverName'),
      entry: entry,
      issues: issuesOf(index),
      disabled: props.disabled,
      onChange: function (patch) { props.onChange(withServer(servers, index, patch)); },
      onRemove: function () {
        props.onChange(servers.filter(function (unused, at) { return at !== index; }));
      },
    });
  });

  return h('div', { className: 'dsh-extra-servers' }, [
    documentIssues.length === 0 ? null : h('div', { key: 'document', className: 'dsh-extra-serverIssue' },
      documentIssues.map(function (issue) { return issue.message; }).join(' ')),
    servers.length === 0
      ? h('p', { key: 'empty', className: 'dsh-extra-hint' }, '还没有配置任何 MCP 服务器。')
      : h('div', { key: 'cards', className: 'dsh-extra-serverList' }, cards),
    // A new entry is added switched off, so adding one never starts a process.
    h('div', { key: 'add', className: 'dsh-extra-serverTools' }, [
      h(Button, {
        key: 'add',
        size: 'small',
        disabled: props.disabled || servers.length >= MAX_MCP_SERVERS,
        onClick: function () { props.onChange(servers.concat([newServerEntry()])); },
      }, '添加服务器'),
    ]),
  ]);
}

/**
 * The Host route that answers the page's non-configuration questions. It is this
 * package's own `settings-api` row, published as an exact `/api` Fetch route behind
 * Connection's authentication, so a same-origin request carries the session cookie
 * that authorizes it.
 */
var SETTINGS_API = '/api/extra-prompt';

/**
 * Call one operation on the settings route.
 * @param op - the operation name.
 * @param extra - the remaining request fields, when the operation takes any.
 * @returns a promise of the operation's value, rejected with the Host's message.
 */
function settingsApi(op, extra) {
  var body = { op: op };
  if (extra !== undefined) {
    Object.keys(extra).forEach(function (key) { body[key] = extra[key]; });
  }
  return fetch(SETTINGS_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  }).then(function (response) {
    return response.json().catch(function () { return null; }).then(function (parsed) {
      if (parsed === null || typeof parsed !== 'object') throw new Error('设置接口返回了非 JSON 响应。');
      if (parsed.ok !== true) {
        var detail = parsed.error !== undefined && typeof parsed.error.message === 'string'
          ? parsed.error.message
          : '请求失败。';
        throw new Error(detail);
      }
      return parsed.value;
    });
  });
}

/**
 * Human labels for the registry's `source` buckets.
 *
 * The raw bucket stays visible next to its label: the label says which directory
 * a reader would open, the bucket is what the Host and the routing rules call it,
 * and a bucket this page has never heard of must still be shown verbatim rather
 * than swallowed.
 */
var SKILL_SOURCE_LABELS = {
  'project-dsh': '工作区 .dsh/skills',
  'project-agents': '工作区 .agents/skills',
  'user-dsh': '用户 $DSH_HOME/skills',
  'user-agents': '用户 ~/.agents/skills',
  'custom': '自定义目录',
  'bundled': '内置目录',
  'runtime': '插件运行期',
};

/** The provenance line for one catalog entry, or '' when it has no source. */
function skillSourceText(entry) {
  if (typeof entry.source !== 'string' || entry.source === '') {
    // A managed record the Host could not match to a live Skill: its directory may
    // be gone, or this Host may have no registry to compare against. The record's
    // own reason says which, so this line only says what is certain.
    return entry.orphan === true ? '受管记录（未出现在 Skill 目录中）' : '';
  }
  var label = SKILL_SOURCE_LABELS[entry.source];
  return label === undefined ? entry.source : label + '（' + entry.source + '）';
}

/**
 * The model-visible Skill catalog.
 *
 * The list is not a directory walk: the Host answers `skills/list` from its own
 * `skills` registry — the one the `skill` tool and the per-step catalog are built
 * from — queried once per mounted workspace. So the card shows project
 * `.dsh/skills` and `.agents/skills`, user `$DSH_HOME/skills` and `~/.agents/skills`,
 * custom and bundled roots, and plugin runtime Skills, already resolved to the
 * Host's winner per name. Nothing here re-implements discovery, which is what
 * keeps the page and the model from disagreeing about which directories count.
 *
 * Only entries the Host reports as installed by `skill-install` carry a remove
 * button: this package can prove it owns nothing else, and a button the Host would
 * refuse is worse than none. A managed record whose directory is gone is still
 * shown — it is a row this package owns and can clean — with the Host's reason
 * instead of a Skill.
 *
 * Entries the model cannot reach are marked rather than hidden: a Skill with
 * `disable-model-invocation` really is on disk and really is readable, it is just
 * not offered to the model, and saying so is the difference between a catalogue
 * and a guess.
 */
function ManagedSkillsCard() {
  var pair = React.useState({ phase: 'loading', value: null, error: null, busy: null });
  var state = pair[0];
  var setState = pair[1];
  // A removal can outlive the card — the user may switch tabs while it runs — and a
  // state write after unmount is a leak rather than a render.
  var live = React.useRef(true);

  var patch = function (fields) {
    if (!live.current) return;
    setState(function (previous) { return Object.assign({}, previous, fields); });
  };

  var load = function () {
    patch({ phase: 'loading', error: null });
    settingsApi('skills/list').then(function (value) {
      var catalog = value !== null && typeof value === 'object' ? value : {};
      patch({ phase: 'ready', value: catalog, error: null, busy: null });
    }, function (error) {
      patch({ phase: 'failed', value: null, error: error.message, busy: null });
    });
  };

  React.useEffect(function () {
    live.current = true;
    load();
    return function () { live.current = false; };
  }, []);

  var remove = function (entry) {
    patch({ busy: entry.managed.directoryName, error: null });
    settingsApi('skills/remove', {
      directoryName: entry.managed.directoryName,
      installationId: entry.managed.installationId,
    }).then(function () {
      // Reload rather than splice locally: the Host is the only authority on
      // whether the directory and its record are both gone.
      if (live.current) load();
    }, function (error) {
      patch({ busy: null, error: error.message });
    });
  };

  var catalog = state.value === null || typeof state.value !== 'object' ? {} : state.value;
  var skills = Array.isArray(catalog.skills) ? catalog.skills : [];
  var workspaces = Array.isArray(catalog.workspaces) ? catalog.workspaces : [];
  var notes = Array.isArray(catalog.notes) ? catalog.notes : [];

  var body;
  if (state.phase === 'loading') {
    body = h('p', { key: 'loading', className: 'dsh-extra-hint' }, '正在读取模型可见的 Skills…');
  } else if (state.phase === 'failed') {
    body = h('div', { key: 'failed', className: 'dsh-extra-skillList' }, [
      h('p', { key: 'error', className: 'dsh-extra-invalid' }, state.error),
      h(Button, { key: 'retry', onClick: load }, '重新读取'),
    ]);
  } else if (skills.length === 0) {
    body = h('p', { key: 'empty', className: 'dsh-extra-hint' }, '没有读到任何 Skill。');
  } else {
    body = h('div', { key: 'rows', className: 'dsh-extra-skillList' }, skills.map(function (entry, index) {
      var lines = [h('span', {
        key: 'name',
        className: 'dsh-extra-skillName',
      }, entry.orphan === true ? entry.skillName + '（受管记录）' : entry.skillName)];
      if (typeof entry.description === 'string' && entry.description !== '') {
        lines.push(h('span', { key: 'description', className: 'dsh-extra-skillMeta' }, entry.description));
      }
      var where = [];
      var sourceText = skillSourceText(entry);
      if (sourceText !== '') where.push(sourceText);
      if (typeof entry.workspace === 'string' && entry.workspace !== '') where.push('工作区 ' + entry.workspace);
      if (where.length > 0) {
        lines.push(h('span', { key: 'source', className: 'dsh-extra-skillMeta' }, where.join(' · ')));
      }
      if (typeof entry.directory === 'string' && entry.directory !== '') {
        lines.push(h('span', { key: 'directory', className: 'dsh-extra-skillMeta' }, entry.directory));
      }
      if (entry.orphan !== true) {
        var flags = [];
        if (entry.modelInvocable !== true) flags.push('模型不可见（disable-model-invocation）');
        if (entry.userInvocable !== true) flags.push('不可用 /名称 手动调用');
        if (flags.length > 0) lines.push(h('span', { key: 'flags', className: 'dsh-extra-notice' }, flags.join(' · ')));
      }
      if (entry.managed !== null && typeof entry.managed === 'object') {
        var installed = typeof entry.managed.source === 'string' ? entry.managed.source : '';
        if (typeof entry.managed.ref === 'string' && entry.managed.ref !== '') installed += ' @ ' + entry.managed.ref;
        if (installed !== '') {
          lines.push(h('span', { key: 'install', className: 'dsh-extra-skillMeta' }, 'skill-install：' + installed));
        }
        if (entry.managed.removable !== true && typeof entry.managed.reason === 'string') {
          lines.push(h('span', { key: 'reason', className: 'dsh-extra-notice' }, entry.managed.reason));
        }
      }
      var removable = entry.managed !== null && typeof entry.managed === 'object' && entry.managed.removable === true;
      var action = removable
        ? h(Button, {
          key: 'remove',
          disabled: state.busy !== null,
          onClick: function () { remove(entry); },
        }, state.busy === entry.managed.directoryName ? '卸载中…' : '卸载')
        : null;
      return h('div', {
        key: String(index) + ':' + entry.skillName,
        className: 'dsh-extra-skillRow',
      }, [
        h('div', { key: 'body', className: 'dsh-extra-skillBody' }, lines),
        action === null ? null : h('div', { key: 'actions', className: 'dsh-extra-skillActions' }, action),
      ]);
    }));
  }

  var card = [
    h('div', { key: 'head', className: 'dsh-extra-cardHead' }, [
      h('h3', { key: 'title', className: 'dsh-extra-title' }, [
        h('span', { key: 'icon', className: 'dsh-extra-cardIcon' }, h(iconOf('skill'), { size: 16 })),
        h('span', { key: 'text' }, '模型可见的 Skills'),
      ]),
      h('p', { key: 'summary', className: 'dsh-extra-summary' },
        '列出模型当前能读取到的 Skill：工作区 .dsh/skills 与 .agents/skills、用户 $DSH_HOME/skills 与 ~/.agents/skills、自定义与内置目录、插件运行期 Skill。名单来自宿主的 skills 注册表，与模型每轮看到的目录同源；只有本插件用 skill-install 安装的条目可以在这里卸载。'),
    ]),
  ];
  if (state.phase === 'ready') {
    if (workspaces.length > 0) {
      card.push(h('p', { key: 'workspaces', className: 'dsh-extra-hint' },
        '已挂载工作区：' + workspaces.map(function (item) {
          return typeof item.preset === 'string' && item.preset !== ''
            ? item.cwd + '（' + item.preset + ' 预设）'
            : item.cwd;
        }).join('、') + '（共 ' + skills.length + ' 个 Skill）'));
    } else {
      card.push(h('p', { key: 'count', className: 'dsh-extra-hint' }, '共 ' + skills.length + ' 个 Skill。'));
    }
    notes.forEach(function (note, index) {
      card.push(h('p', { key: 'note-' + index, className: 'dsh-extra-notice' }, note));
    });
  }
  card.push(body);
  if (state.error !== null && state.phase === 'ready') {
    card.push(h('p', { key: 'error', className: 'dsh-extra-invalid' }, state.error));
  }
  return h('section', { className: 'dsh-extra-card', 'data-namespace': 'extra-managed-skills' }, card);
}

function Panel(props) {
  var ns = props.ns;
  var panel = props.panel;
  var form = props.form;
  var snapshot = useForm(form);
  // Always called, with null for the panels that have nothing to cross-check, so
  // the hook order stays the same in every panel.
  var crossCheck = useForm(props.crossCheckForm === undefined ? null : props.crossCheckForm);

  // `draft` holds the text of every field the user touched and is keyed by field
  // name, so a save can write exactly those fields and leave the rest alone.
  var draftPair = React.useState(null);
  var draft = draftPair[0];
  var setDraft = draftPair[1];
  var busyPair = React.useState(false);
  var busy = busyPair[0];
  var setBusy = busyPair[1];
  var failedPair = React.useState(false);
  var failed = failedPair[0];
  var setFailed = failedPair[1];

  var status = snapshot.status;
  var writable = status === 'ready' && snapshot.writable === true;
  var committed = hasOwn(snapshot, 'value') && snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {};
  // What a field reverts to once its override is dropped, so a cleared field
  // previews the value the save would leave behind rather than an empty box.
  var base = snapshot.base !== null && typeof snapshot.base === 'object' ? snapshot.base : {};
  var userLayer = snapshot.user !== null && typeof snapshot.user === 'object' ? snapshot.user : null;

  var specOf = function (field) {
    var found = null;
    panel.fields.forEach(function (spec) { if (spec.field === field) found = spec.spec; });
    return found;
  };

  var textOf = function (spec) {
    if (draft !== null && hasOwn(draft, spec.field)) {
      // An empty provider picker means "use the manual fields", not "preview the
      // base override"; the picker needs to show that real choice immediately.
      if (spec.spec.kind === 'provider' && draft[spec.field] === '') return '';
      return draft[spec.field] === '' ? spec.spec.format(base[spec.field]) : draft[spec.field];
    }
    return spec.spec.format(committed[spec.field]);
  };
  var providerField = null;
  panel.fields.forEach(function (spec) { if (spec.field === 'provider') providerField = spec; });
  // A selected provider owns the endpoint and credential. The two manual fields
  // stay in the saved settings so clearing the picker restores them, but they
  // must not look editable while the provider is in charge.
  var providerSelected = providerField !== null && textOf(providerField) !== '';
  var hiddenByProvider = function (spec) {
    return spec.hideWhenProvider === true && providerSelected;
  };
  var valueOf = function (spec) {
    var parsed = spec.spec.parse(textOf(spec));
    return parsed !== undefined && parsed.kind === 'set' ? parsed.value : undefined;
  };
  var overriddenOf = function (spec) {
    if (draft !== null && hasOwn(draft, spec.field)) {
      var staged = spec.spec.parse(draft[spec.field]);
      // A staged clear removes the override; a staged set leaves one, whatever
      // it happens to equal.
      return staged !== undefined && staged.kind === 'set';
    }
    return userLayer !== null && hasOwn(userLayer, spec.field);
  };
  var invalidOf = function (spec) {
    if (draft === null || !hasOwn(draft, spec.field)) return false;
    return spec.spec.parse(draft[spec.field]) === undefined;
  };

  var dirty = draft !== null && Object.keys(draft).length > 0;
  var invalid = panel.fields.some(function (spec) {
    return !hiddenByProvider(spec) && invalidOf(spec);
  });

  var edit = function (field, text) {
    var next = draft === null ? {} : Object.assign({}, draft);
    // Selecting a provider discards any staged manual endpoint draft: the
    // hidden fields must not be written behind the user's back. The committed
    // values remain untouched for a later clear.
    if (field === 'provider' && text !== '') {
      delete next.baseURL;
      delete next.apiKeyEnv;
    }
    next[field] = text;
    setDraft(next);
    setFailed(false);
  };

  var discard = function () {
    setDraft(null);
    setFailed(false);
  };

  var save = function () {
    if (!dirty || invalid || busy) return;
    setBusy(true);
    setFailed(false);
    var fields = Object.keys(draft).filter(function (field) {
      var found = null;
      panel.fields.forEach(function (candidate) { if (candidate.field === field) found = candidate; });
      return found === null || !hiddenByProvider(found);
    });
    var refused = [];
    // Sequential, so a Host that fences each write by revision sees the previous
    // one settled before the next is staged against it.
    var writeAt = function (at) {
      if (at >= fields.length) return Promise.resolve();
      var spec = specOf(fields[at]);
      var staged = spec === null ? undefined : spec.parse(draft[fields[at]]);
      var pending = staged === undefined || staged.kind === 'clear'
        ? form.unset(fields[at])
        : form.set(fields[at], staged.value);
      return Promise.resolve(pending).then(function (accepted) {
        if (accepted !== true) refused.push(fields[at]);
        return writeAt(at + 1);
      });
    };
    writeAt(0).then(function () {
      setBusy(false);
      // Keep the drafts when anything was refused, so nothing the user typed is
      // lost to a write the Host did not accept.
      if (refused.length === 0) setDraft(null);
      else setFailed(true);
    }, function () {
      setBusy(false);
      setFailed(true);
    });
  };

  var disabled = !writable || busy;
  var shell = {
    available: status !== 'unavailable',
    writable: writable,
    dirty: dirty,
    invalid: invalid,
    saving: busy,
    failed: failed,
  };

  var renderField = function (spec) {
    if (hiddenByProvider(spec)) return null;
    var id = 'dsh-extra-' + ns + '-' + spec.field;
    var overridden = overriddenOf(spec);
    var invalidField = invalidOf(spec);
    var reset = function () { edit(spec.field, ''); };

    if (spec.kind === 'text' || spec.kind === 'number') {
      return h(SettingsValueField, {
        key: spec.field,
        id: id,
        label: spec.label,
        hint: spec.help === undefined ? '' : spec.help,
        text: textOf(spec),
        overridden: overridden,
        invalid: invalidField,
        overriddenLabel: OVERRIDDEN_LABEL,
        resetLabel: RESET_LABEL,
        invalidLabel: spec.invalidLabel === undefined ? INVALID_LABEL : spec.invalidLabel,
        numeric: spec.kind === 'number',
        placeholder: spec.placeholder,
        disabled: disabled,
        onEdit: function (text) { edit(spec.field, text); },
        onReset: reset,
      });
    }

    if (spec.kind === 'provider') {
      return h('div', { key: spec.field, className: 'dsh-extra-field' }, [
        fieldHead({ id: id, label: spec.label, overridden: overridden, disabled: disabled, onReset: reset }),
        h(ProviderSelect, {
          key: 'control',
          id: id,
          text: textOf(spec),
          disabled: disabled,
          onChange: function (text) { edit(spec.field, text); },
        }),
        spec.help === undefined ? null : h('p', { key: 'help', className: 'dsh-extra-hint' }, spec.help),
      ]);
    }

    var control;
    if (spec.kind === 'boolean') {
      return h('div', { key: spec.field, className: 'dsh-extra-field' }, [
        h('div', { key: 'row', className: 'dsh-extra-toggle' }, [
          h('span', { key: 'label', className: 'dsh-extra-toggleLabel' }, spec.label),
          h(Switch, {
            key: 'switch',
            checked: valueOf(spec) === true,
            label: spec.label,
            disabled: disabled,
            onChange: function (next) { edit(spec.field, next === true ? 'true' : 'false'); },
          }),
          overridden
            ? h('span', { key: 'badges', className: 'dsh-extra-badges' }, [
              h(Tag, { key: 'tag', tone: 'neutral' }, OVERRIDDEN_LABEL),
              h('button', {
                key: 'reset', type: 'button', className: 'dsh-extra-reset',
                disabled: disabled, onClick: reset,
              }, RESET_LABEL),
            ])
            : null,
        ]),
        spec.help === undefined ? null : h('p', { key: 'help', className: 'dsh-extra-hint' }, spec.help),
      ]);
    }
    if (spec.kind === 'select') {
      control = h('select', {
        key: 'control',
        id: id,
        className: 'dsh-extra-input',
        value: textOf(spec),
        disabled: disabled,
        onChange: function (event) { edit(spec.field, event.target.value); },
      }, spec.options.map(function (option) {
        return h('option', { key: option[0], value: option[0] }, option[1]);
      }));
    } else if (spec.kind === 'routes') {
      control = h(RoutesEditor, {
        key: 'control',
        text: textOf(spec),
        disabled: disabled,
        onChange: function (text) { edit(spec.field, text); },
      });
    } else if (spec.kind === 'servers') {
      control = h(ServersEditor, {
        key: 'control',
        value: textOf(spec),
        disabled: disabled,
        onChange: function (next) { edit(spec.field, next); },
      });
    } else {
      control = h('textarea', {
        key: 'control',
        id: id,
        className: 'dsh-extra-input',
        rows: spec.rows === undefined ? 5 : spec.rows,
        placeholder: spec.placeholder,
        value: textOf(spec),
        disabled: disabled,
        onChange: function (event) { edit(spec.field, event.target.value); },
      });
    }

    var help = spec.help === undefined ? null : h('p', { key: 'help', className: 'dsh-extra-hint' }, spec.help);
    // A list editor ends with its own action button, so a field's explanation goes
    // above it: below, it reads as a caption for "add another".
    var children = [fieldHead({ id: id, label: spec.label, overridden: overridden, disabled: disabled, onReset: reset })];
    if (spec.kind === 'servers') {
      if (help !== null) children.push(help);
      children.push(control);
    } else {
      children.push(control);
      if (help !== null) children.push(help);
    }
    children.push(invalidField
      ? h('p', { key: 'invalid', className: 'dsh-extra-invalid' },
        spec.invalidLabel === undefined ? INVALID_LABEL : spec.invalidLabel)
      : null);
    return h('div', { key: spec.field, className: 'dsh-extra-field' }, children);
  };

  var body;
  if (status === 'loading') {
    body = h('p', { key: 'loading', className: 'dsh-extra-hint' }, '正在读取…');
  } else if (status === 'unavailable') {
    body = h(SettingsForm, {
      key: 'form', labels: FORM_LABELS, state: shell, onSave: save, onDiscard: discard,
    }, null);
  } else {
    body = h(SettingsForm, {
      key: 'form', labels: FORM_LABELS, state: shell, onSave: save, onDiscard: discard,
    }, panel.fields.map(renderField));
  }

  // Report a divergence from the delegation policy this card does not own. It
  // follows the staged routes, so the warning clears as the user fixes the rows.
  var notice = null;
  if (panel.crossCheck === true) {
    var routeSpec = null;
    panel.fields.forEach(function (spec) { if (spec.kind === 'routes') routeSpec = spec; });
    notice = allowanceWarning(crossCheck, routeSpec === null ? [] : valueOf(routeSpec));
  }

  var card = [
    h('div', { key: 'head', className: 'dsh-extra-cardHead' }, [
      h('h3', { key: 'title', className: 'dsh-extra-title' }, [
        panel.icon === undefined
          ? null
          : h('span', { key: 'icon', className: 'dsh-extra-cardIcon' },
            h(iconOf(panel.icon), { size: 16 })),
        h('span', { key: 'text' }, panel.title),
      ]),
      h('p', { key: 'summary', className: 'dsh-extra-summary' }, panel.summary),
      // A feature that depends on something the user installs themselves shows where
      // to get it, on the card that configures it.
      panel.repo === undefined
        ? null
        : h('p', { key: 'repo', className: 'dsh-extra-hint' }, ['仓库：', upstreamLink(panel.repo)]),
    ]),
  ];
  if (notice !== null) card.push(h('p', { key: 'notice', className: 'dsh-extra-notice' }, notice));
  // A machine fact the page looked up for this card alone (the rtk probe). It
  // belongs to the frame rather than to one field: it describes something the
  // fields cannot change.
  if (props.note !== undefined && props.note !== null) {
    card.push(h('p', { key: 'note', className: 'dsh-extra-hint' }, props.note));
  }
  card.push(body);
  return h('section', { className: 'dsh-extra-card', 'data-namespace': ns }, card);
}

/**
 * An outbound link, rendered the way the official settings cards render one.
 *
 * A new tab with `noopener`, so the page keeps its state and the opened document
 * gets no handle on it. The address is its own label: it is what the user has to
 * type if the click does not do what they want.
 *
 * @param href - the absolute http(s) address.
 * @returns the anchor node.
 */
function upstreamLink(href) {
  return h('a', {
    className: 'dsh-extra-link',
    href: href,
    target: '_blank',
    rel: 'noopener noreferrer',
  }, href);
}

/**
 * The whole page: every feature's settings card, grouped into tabs.
 *
 * It holds no switch. Each feature is one profile row of this package, and the
 * 「插件」 page owns whether that row is mounted — so what this page can do is
 * configure a feature, and the card of an unmounted row says so in the shared
 * "unavailable" state instead of offering a control it cannot honour.
 */
function ExtraPromptSettings(props) {
  var forms = props.forms;

  // The one snapshot this page reads for itself: the rtk card's committed
  // `rtkPath`, which is what the machine probe below asks the Host about. Every
  // other subscription belongs to a card, and each card holds its own.
  var rtkSnapshot = useForm(forms[RTK_NAMESPACE]);

  var tabPair = React.useState(TABS[0].id);
  var selectedTab = tabPair[0];
  var setSelectedTab = tabPair[1];

  // Whether this machine has rtk. `available: null` means the Host could not tell —
  // an older Host, or one without the lookup seam — and an unanswered question is
  // reported as nothing at all rather than as a missing binary.
  var rtkPair = React.useState({ available: null, path: null });
  var rtk = rtkPair[0];
  var setRtk = rtkPair[1];

  /** The committed `rtkPath`, or null while that document is still loading. */
  var rtkPathOf = function () {
    if (rtkSnapshot.status !== 'ready') return null;
    var value = rtkSnapshot.value;
    if (value === null || typeof value !== 'object') return null;
    return typeof value.rtkPath === 'string' ? value.rtkPath : '';
  };
  var rtkPath = rtkPathOf();

  // Asked once per distinct rtkPath, and again whenever it changes: a corrected path
  // is the one edit that can make rtk appear without restarting the Host.
  var askedRtkPath = React.useRef(null);
  React.useEffect(function () {
    if (rtkPath === null || askedRtkPath.current === rtkPath) return;
    askedRtkPath.current = rtkPath;
    var live = true;
    settingsApi('rtk/status', { rtkPath: rtkPath }).then(function (value) {
      if (!live || value === null || typeof value !== 'object') return;
      setRtk({
        available: value.available === true ? true : (value.available === false ? false : null),
        path: typeof value.path === 'string' ? value.path : null,
      });
    }, function () {
      if (live) setRtk({ available: null, path: null });
    });
    return function () { live = false; };
  }, [rtkPath]);

  /**
   * What the rtk card says about this machine.
   *
   * The probe is a machine fact, not a switch: whether the feature runs is the
   * row's business on the 「插件」 page, and this line is what keeps a silent
   * passthrough from reading as a working filter. The card head already links the
   * repository, so the note names it instead of printing the address twice.
   */
  var rtkNote = rtk.available === false
    ? RTK_MISSING_NOTICE
    : (rtk.available === true && typeof rtk.path === 'string' && rtk.path !== ''
      ? RTK_FOUND_PREFIX + rtk.path
      : null);

  var cardsIn = function (namespaces) {
    return namespaces.map(function (ns) {
      return h(Panel, {
        key: ns,
        ns: ns,
        panel: PANELS[ns],
        form: forms[ns],
        // Handed only to the card that asks for it, so the others hold no
        // subscription to a namespace they never read.
        crossCheckForm: PANELS[ns].crossCheck === true ? props.crossCheckForm : null,
        // Also one card only: the rest have no machine fact to report.
        note: ns === RTK_NAMESPACE ? rtkNote : null,
      });
    });
  };

  // Every group is always there, so a selection can only be stale if the constant
  // itself changed; falling back to the first group keeps that a non-event.
  var active = TABS.filter(function (tab) { return tab.id === selectedTab; })[0];
  if (active === undefined) active = TABS[0];

  // A single-segment tablist cannot switch anything, so the bar only appears once
  // there is a choice to make; the panel is then the whole content.
  var tabBar = TABS.length > 1 ? h(SegmentedControl, {
    key: 'tabs',
    id: TAB_ID,
    value: active.id,
    label: '功能分组',
    options: TABS.map(function (tab) { return { value: tab.id, label: tab.label }; }),
    onChange: function (next) { setSelectedTab(next); },
  }) : null;

  var tabPanel = h('div', {
    key: 'panel',
    className: 'dsh-extra-tabPanel',
    role: 'tabpanel',
    id: TAB_ID + '-' + active.id + '-panel',
    'aria-labelledby': TAB_ID + '-' + active.id,
  }, cardsIn(active.namespaces).concat(active.id === 'skill'
    // Not a namespace: installed Skills are registry state, not settings, so this
    // card reads the Host directly instead of rendering a ConfigForm.
    ? [h(ManagedSkillsCard, { key: 'managed-skills' })]
    : []));

  return h('div', { className: 'dsh-extra-page' }, [
    h('h2', { key: 'heading', className: 'dsh-extra-heading' }, [
      h('span', { key: 'icon', className: 'dsh-extra-headingIcon' }, h(iconOf('page'), { size: 16 })),
      h('span', { key: 'text' }, '提示词与技能'),
    ]),
    // The one thing a user cannot learn from this page: where the switches are.
    h('p', { key: 'intro', className: 'dsh-extra-intro' },
      PLUGIN_LABEL + ' · 每个功能一行插件，开与关都在「插件」页；这里只放它们的配置。'),
    tabBar,
    tabPanel,
  ]);
}

// --- plugin ------------------------------------------------------------------

/**
 * Services this browser half requires. Cordis waits on these before `apply`
 * runs, so `ctx.configForms` is always available inside it. `slots` and
 * `configForms` are the only services read.
 */
exports.inject = ['slots', 'configForms'];

/**
 * Register one settings page into the `settings.section` list slot.
 *
 * `slots.inject` waits for the declaration instead of racing it: the slot is
 * declared by `ui-settings-general`, whose activation order relative to this
 * plugin is unconstrained. Bare `slots.register` would throw on an undeclared
 * slot, and the nav row is projected from this same ledger, so the page appears
 * as a first-class section with no upstream change.
 *
 * @param ctx - the browser plugin context.
 */
/**
 * The MCP rules the card enforces before it will save.
 *
 * Exported beside `apply` so the tests can hold this copy and the Host's
 * `src/mcp/model.mjs` to the same answers case by case. The loader reads only
 * `name`, `inject`, `Config` and `apply` from a plugin object, so an extra named
 * export is inert at runtime.
 */
exports.serverIssues = serverIssues;
/**
 * The host icons this page names, so a test can pin the whole dependency rather
 * than scan for it. A renamed or dropped host icon is invisible until something
 * renders it, and the page then shows a fallback outline instead of the intended
 * glyph — an easy thing to miss, and exactly what a pinned list catches.
 */
exports.HOST_ICON_NAMES = HOST_ICON_NAMES;

/**
 * Register the settings page.
 * @param ctx - the client context.
 */
exports.apply = function apply(ctx) {
  ensureStyles();

  // One long-lived ConfigForm per namespace, created outside React so the
  // subscription effect sees a stable identity across renders.
  var forms = {};
  NAMESPACES.forEach(function (ns) { forms[ns] = ctx.configForms.get(ns); });
  // Read-only: the official allow-list this page warns against. Never written.
  var crossCheckForm = ctx.configForms.get(OFFICIAL_NAMESPACE);

  ctx.slots.inject('settings.section', function () {
    return ctx.slots.register({
      name: 'settings.section',
      id: 'extra-prompt',
      // After the built-in general (0), models (10) and plugins (15) sections.
      order: 30,
      label: '提示词与技能',
    }, function (props) {
      return h(ExtraPromptSettings, Object.assign({}, props, {
        forms: forms,
        crossCheckForm: crossCheckForm,
      }));
    });
  });
};

return module.exports; } });
