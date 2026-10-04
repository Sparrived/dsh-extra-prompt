// Pure logic for the MCP server manager. No host imports, so `node --test`
// exercises every rule here directly.
//
// The shape this module produces is the exact `Config` of
// `@deepseek-ai/dsh-mcp-client`, which is the plugin that actually connects and
// registers tools. This package only decides which instances should exist and
// keeps them in step with the settings document; it never speaks MCP itself.
//
// A server is identified by its `serverName`, because that is also the
// model-facing tool namespace (`mcp__<serverName>__<tool>`) and the name
// `mcp-client` reserves. A separate opaque id would let the two drift, so a
// rename is a remove plus an add instead.

/** `mcp-client` accepts this pattern and no other for `serverName`. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Environment variable names, the stricter of the two binding-name rules. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** HTTP header names, following RFC 9110's token production. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Bounds this package enforces on top of `mcp-client`, which declares its timeout
 * and reconnect numbers bare. They are here so a typo fails at the settings card
 * instead of at connect time, where the only signal is a reconnect loop.
 */
export const MIN_TOOL_CALL_TIMEOUT_MS = 100;
export const MAX_TOOL_CALL_TIMEOUT_MS = 300000;
export const MIN_RECONNECT_DELAY_MS = 1;
export const MAX_RECONNECT_DELAY_MS = 300000;
export const MIN_RECONNECT_ATTEMPTS = 1;
export const MAX_RECONNECT_ATTEMPTS = 100;

/** Defaults mirrored from `mcp-client`, so an untouched server behaves as documented there. */
export const DEFAULTS = Object.freeze({
  transport: 'stdio',
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
});

/** The two transports `mcp-client` implements. */
export const TRANSPORTS = ['stdio', 'streamable-http'];

/**
 * Upper bound on configured servers.
 *
 * Each one is a live child process or HTTP client with its own reconnect timers
 * and its own model-facing tool namespace, so the list is capped where a settings
 * document stops being reviewable rather than where the runtime breaks.
 */
export const MAX_SERVERS = 64;

/**
 * A dictionary of bindings, keyed by variable or header name.
 *
 * A dictionary rather than a list of rows: `mcp-client` takes a record, and keys
 * in a record cannot repeat, so duplicate-binding validation has no subject.
 *
 * @param value - candidate value from a settings document.
 * @returns a plain string-to-string record.
 */
function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

/**
 * The argument list of a stdio server.
 * @param value - candidate value from a settings document.
 * @returns a list of strings.
 */
function list(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string');
}

/**
 * A bounded integer, or the default when the value is not one.
 * @param value - candidate value from a settings document.
 * @param fallback - value used when the candidate is unusable.
 * @returns the candidate when it is a finite number, else the fallback.
 */
function number(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Coerce one stored entry into the canonical shape.
 *
 * A missing `enabled` reads as `false`: a server the settings document does not
 * describe as switched on must not start a child process, and an entry written by
 * an older version carries no such flag.
 *
 * @param raw - candidate entry from a settings document.
 * @returns the canonical server, or `null` when the entry is not an object.
 */
export function normalizeServer(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const transport = TRANSPORTS.includes(raw.transport) ? raw.transport : DEFAULTS.transport;
  return {
    serverName: typeof raw.serverName === 'string' ? raw.serverName : '',
    enabled: raw.enabled === true,
    transport,
    command: typeof raw.command === 'string' ? raw.command : DEFAULTS.command,
    args: list(raw.args),
    env: record(raw.env),
    cwd: typeof raw.cwd === 'string' ? raw.cwd : DEFAULTS.cwd,
    url: typeof raw.url === 'string' ? raw.url : DEFAULTS.url,
    headers: record(raw.headers),
    toolCallTimeoutMs: number(raw.toolCallTimeoutMs, DEFAULTS.toolCallTimeoutMs),
    maxInstructionBytes: number(raw.maxInstructionBytes, DEFAULTS.maxInstructionBytes),
    failOnStartupError: raw.failOnStartupError === true,
    reconnectEnabled: raw.reconnectEnabled !== false,
    reconnectInitialDelayMs: number(raw.reconnectInitialDelayMs, DEFAULTS.reconnectInitialDelayMs),
    reconnectMaxDelayMs: number(raw.reconnectMaxDelayMs, DEFAULTS.reconnectMaxDelayMs),
    reconnectMaxAttempts: number(raw.reconnectMaxAttempts, DEFAULTS.reconnectMaxAttempts),
  };
}

/**
 * Coerce a whole settings value into a list of servers.
 * @param value - the `servers` field of this plugin's config.
 * @returns canonical servers, any unusable entry dropped.
 */
export function normalizeServers(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    const server = normalizeServer(raw);
    if (server !== null) out.push(server);
  }
  return out;
}

/**
 * The `mcp-client` config for one server.
 *
 * Only fields that plugin's schema declares: it validates its own input, and an
 * extra key here would be rejected at composition time as an unknown field.
 *
 * @param server - a canonical server.
 * @returns the config object to hand to `ctx.plugin`.
 */
export function specOf(server) {
  const shared = {
    serverName: server.serverName,
    toolCallTimeoutMs: server.toolCallTimeoutMs,
    failOnStartupError: server.failOnStartupError,
    maxInstructionBytes: server.maxInstructionBytes,
    reconnect: {
      enabled: server.reconnectEnabled,
      initialDelayMs: server.reconnectInitialDelayMs,
      maxDelayMs: server.reconnectMaxDelayMs,
      maxAttempts: server.reconnectMaxAttempts,
    },
  };
  if (server.transport === 'streamable-http') {
    return { transport: 'streamable-http', url: server.url, headers: server.headers, ...shared };
  }
  return {
    transport: 'stdio',
    command: server.command,
    args: server.args,
    env: server.env,
    cwd: server.cwd,
    ...shared,
  };
}

/**
 * A stable identity for "did this server's connection settings change".
 *
 * Key order follows the construction above, so two equal specs always serialize
 * identically. Recomposition drops and reconnects a server, so a save that
 * touched only a label must not look like a change.
 *
 * @param server - a canonical server.
 * @returns the serialized spec.
 */
export function specKey(server) {
  return JSON.stringify(specOf(server));
}

/**
 * The servers that should have a live instance.
 * @param servers - canonical servers.
 * @returns the enabled subset, in document order.
 */
export function activeServers(servers) {
  return servers.filter((server) => server.enabled);
}

/**
 * Whether one binding name is usable for its transport's binding kind.
 * @param name - the variable or header name.
 * @param kind - `'env'` for stdio, `'header'` for Streamable HTTP.
 * @returns true when the name is accepted.
 */
export function bindingNameAccepted(name, kind) {
  return kind === 'env' ? ENV_NAME_PATTERN.test(name) : HEADER_NAME_PATTERN.test(name);
}

/**
 * Whether a URL is an endpoint this package is willing to connect to.
 *
 * Credentials embedded in the URL are refused: `mcp-client` forwards `headers`
 * but a userinfo component would be sent verbatim on every request, hidden from
 * the settings card, which is the one place the user could review it.
 *
 * @param value - candidate URL.
 * @returns true when the URL is absolute http(s) with no userinfo.
 */
export function urlAccepted(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return parsed.username === '' && parsed.password === '';
}

/**
 * Every reason the given servers cannot be run.
 *
 * Each issue names the entry and the field so the card can point at the control
 * that has to change, rather than only reporting that the document is wrong.
 *
 * @param servers - canonical servers.
 * @returns issues in document order.
 */
export function validateServers(servers) {
  const issues = [];
  const seen = new Map();
  if (servers.length > MAX_SERVERS) {
    issues.push({
      index: -1,
      field: 'servers',
      message: `最多 ${MAX_SERVERS} 台服务器，当前 ${servers.length} 台。`,
    });
  }
  servers.forEach((server, index) => {
    const at = (field, message) => issues.push({ index, field, message });
    if (!SERVER_NAME_PATTERN.test(server.serverName)) {
      at('serverName', '名称只能包含字母、数字、下划线和连字符，长度 1–32。');
    } else if (seen.has(server.serverName)) {
      at('serverName', `名称与第 ${seen.get(server.serverName) + 1} 台服务器重复；它同时是工具命名空间，必须唯一。`);
    } else {
      seen.set(server.serverName, index);
    }
    if (server.transport === 'stdio') {
      if (server.command.trim() === '') at('command', 'stdio 服务器必须填写启动命令。');
      for (const key of Object.keys(server.env)) {
        if (!bindingNameAccepted(key, 'env')) at('env', `环境变量名 “${key}” 无效。`);
      }
    } else {
      if (server.url.trim() === '') at('url', 'Streamable HTTP 服务器必须填写 URL。');
      else if (!urlAccepted(server.url)) at('url', 'URL 必须是不含用户名密码的 http(s) 地址。');
      for (const key of Object.keys(server.headers)) {
        if (!bindingNameAccepted(key, 'header')) at('headers', `请求头名 “${key}” 无效。`);
      }
    }
    if (server.toolCallTimeoutMs < MIN_TOOL_CALL_TIMEOUT_MS || server.toolCallTimeoutMs > MAX_TOOL_CALL_TIMEOUT_MS) {
      at('toolCallTimeoutMs', `调用超时需在 ${MIN_TOOL_CALL_TIMEOUT_MS}–${MAX_TOOL_CALL_TIMEOUT_MS} ms 之间。`);
    }
    if (server.maxInstructionBytes < 1 || !Number.isInteger(server.maxInstructionBytes)) {
      at('maxInstructionBytes', '指令字节上限需为不小于 1 的整数。');
    }
    if (server.reconnectEnabled) {
      if (server.reconnectInitialDelayMs < MIN_RECONNECT_DELAY_MS || server.reconnectInitialDelayMs > MAX_RECONNECT_DELAY_MS) {
        at('reconnectInitialDelayMs', `首次延迟需在 ${MIN_RECONNECT_DELAY_MS}–${MAX_RECONNECT_DELAY_MS} ms 之间。`);
      }
      if (server.reconnectMaxDelayMs < MIN_RECONNECT_DELAY_MS || server.reconnectMaxDelayMs > MAX_RECONNECT_DELAY_MS) {
        at('reconnectMaxDelayMs', `最大延迟需在 ${MIN_RECONNECT_DELAY_MS}–${MAX_RECONNECT_DELAY_MS} ms 之间。`);
      }
      if (server.reconnectInitialDelayMs > server.reconnectMaxDelayMs) {
        at('reconnectInitialDelayMs', '首次延迟不能大于最大延迟。');
      }
      if (!Number.isInteger(server.reconnectMaxAttempts)
        || server.reconnectMaxAttempts < MIN_RECONNECT_ATTEMPTS
        || server.reconnectMaxAttempts > MAX_RECONNECT_ATTEMPTS) {
        at('reconnectMaxAttempts', `最大重连次数需在 ${MIN_RECONNECT_ATTEMPTS}–${MAX_RECONNECT_ATTEMPTS} 之间。`);
      }
    }
  });
  return issues;
}

/**
 * A new, switched-off stdio server.
 *
 * Switched off on purpose: saving the card must not start a child process the
 * user has not reviewed yet. Enabling is a separate, deliberate act, which is
 * also where the card explains that stdio servers run outside the sandbox.
 *
 * @param serverName - the name to start from; the user edits it.
 * @returns a canonical server with every other field at its default.
 */
export function newServer(serverName) {
  return normalizeServer({ serverName, enabled: false });
}
