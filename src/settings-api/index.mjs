// The settings page's data channel.
//
// The page shows three things that are not configuration and cannot be read from a
// config namespace: the Skills the model can actually read, which of them this
// package installed (a file next to the profile written by `skill-installer`), and
// whether this machine has the `rtk` executable at all. The browser cannot read any
// of them.
//
// The Skill list is answered by the Host's own `skills` registry — the one the
// `skill` tool and the per-step catalog read — queried once per mounted workspace,
// so the page and the model cannot disagree about which directories count. See
// `./catalog.mjs` for the assembly and `readSkillViews` below for the query.
//
// DSH's own client-to-host path is the generated Remote API, and an out-of-tree
// JavaScript plugin cannot join it — that path needs Typert strict codecs, a
// generator run, and a decorator-marked service on the host side. Connection
// exposes two plainer registries:
//
//   `connection.rpc.handle(channel, handler)` mounts a dedicated JSON channel.
//   `connection.fetch.register(route)` claims an exact path under `/api`.
//
// This row uses `fetch.register`, because `rpc.handle` resolves `webServer` through
// the calling context (`rpc-host.ts` `register()` does `owner.webServer.register`),
// and a context belonging to a plugin that only *declares* the service does not
// satisfy that walk — it stops at the isolate boundary and reports
// `cannot get property "webServer" without inject` no matter what this row
// declares. `fetch.register` never touches `webServer`: it publishes into the
// shared `/api` map, which the Connection plugin's own `/api` route already serves
// behind the trusted-host fence and browser authentication.
//
// The route is therefore an ordinary authenticated same-origin POST, which the
// browser half issues with `fetch`. It reads configuration only from the request
// body — a value the page already holds through `configForms` — and never writes
// any: every settings write still goes through `configForms`.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveDshHome, resolveDshProfileDir } from '../shared/dsh-home.mjs';
import { listManagedSkills, uninstallManagedSkill } from '../skill-installer/manage.mjs';
import { readSessionDashboardFromHost } from '../session-dashboard/model.mjs';
import { assembleSkillCatalog } from './catalog.mjs';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'extra-settings-api';

/** The Connection service must exist before this row can publish anything. */
export const inject = ['connection'];

/** The exact path this plugin owns below `/api`. */
export const PATH = '/api/extra-prompt';

/** Ceiling on the distinct workspaces one `skills/list` read queries. */
export const MAX_WORKSPACES = 8;

/**
 * Wrap a failure in the shape the page can read.
 * @param code - stable machine-readable reason.
 * @param message - operator-facing description.
 * @returns a failed result envelope.
 */
function failure(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * The user Skills root, resolved exactly as `skill-installer` resolves its
 * destination, so the page lists what the installer actually wrote.
 * @param ctx - the plugin's host context.
 * @returns the absolute Skills root and the mounted profile directory.
 */
function rootsOf(ctx) {
  return {
    destRoot: join(resolveDshHome(ctx), 'skills'),
    profileDir: resolveDshProfileDir(ctx),
  };
}

/**
 * Read a service without declaring it as an injected dependency.
 *
 * This row's only hard dependency is `connection`: it must settle on the Web
 * transport, and it must keep working on a Host that has no session store or no
 * Skill registry. `ctx.get()` is the non-injecting accessor for exactly that —
 * the same seam `skill-installer` uses for `ctx.get('skills')`.
 *
 * @param ctx - the plugin's host context.
 * @param name - the service name.
 * @returns the live service, or `undefined`.
 */
function serviceOf(ctx, name) {
  if (typeof ctx?.get !== 'function') return undefined;
  const service = ctx.get(name);
  return service === undefined || service === null ? undefined : service;
}

/**
 * The registry instance and view scope one session's own Skill lookup uses.
 *
 * This reproduces the official resolution of `skill.list` (`api-proxy.ts`), and it
 * is the difference between "some Skills" and "the Skills this model can read".
 * The registry is layered per scope, and an agent preset mounts
 * `skill-filesystem` into its own layer — the stock `standard` preset does
 * exactly that — so a read with no scope sees only what the host composition
 * registered globally: no `.dsh/skills`, no `.agents/skills`, no bundled root.
 *
 * A live agent *is* the scope, because its chain passes through its preset's
 * standing layer. A session that is not live resolves its preset's standing key,
 * which composes the preset without resuming any agent, session, or turn. An
 * unknown or unusable preset degrades to the global layer, never to a failure.
 *
 * @param ctx - the plugin's host context.
 * @param sessionId - the session's id, when it has one.
 * @param agentPreset - the preset recorded for that session, if any.
 * @returns the scope to pass to `list()` and the registry instance to call.
 */
async function skillViewOf(ctx, sessionId, agentPreset) {
  const agents = serviceOf(ctx, 'agents');
  const live = sessionId === undefined || typeof agents?.get !== 'function' ? undefined : agents.get(sessionId);
  if (live !== undefined) {
    // A composition may realm-mount its own registry; a live agent is the only
    // address for that instance. The host instance otherwise serves every scope,
    // its layers keyed by the scope passed to `list`.
    const presets = serviceOf(ctx, 'agentPresets');
    const scoped = typeof presets?.serviceFor === 'function' ? presets.serviceFor(live, 'skills') : undefined;
    return { scope: live, registry: scoped ?? serviceOf(ctx, 'skills') };
  }
  const presets = serviceOf(ctx, 'agentPresets');
  if (presets === undefined || typeof presets.standingKeyFor !== 'function') {
    return { scope: undefined, registry: serviceOf(ctx, 'skills') };
  }
  try {
    return { scope: await presets.standingKeyFor(agentPreset), registry: serviceOf(ctx, 'skills') };
  } catch {
    // Swallows only the roster's unknown/unusable-preset rejection: a deleted or
    // broken preset must degrade this read, exactly as it degrades the official one.
    return { scope: undefined, registry: serviceOf(ctx, 'skills') };
  }
}

/**
 * The workspaces this Host has mounted, each with the scope that makes the read
 * equal to the model's own lookup.
 *
 * A mounted workspace is a live session's header cwd: that is the path the
 * model's Skill lookup is made with, so it is the only answer comparable with
 * what the model reads. When no session is live — the settings page can be
 * opened before the first message — the most recently updated stored session
 * stands in, and failing that there is no workspace at all and the user-level
 * and bundled roots are read through the default preset's standing scope.
 *
 * @param ctx - the plugin's host context.
 * @returns read targets, at most {@link MAX_WORKSPACES}, workspaces first.
 */
export async function resolveSkillTargets(ctx) {
  const candidates = [];
  const add = (candidate) => {
    if (candidates.length >= MAX_WORKSPACES) return;
    if (candidates.some(existing => existing.cwd === candidate.cwd)) return;
    candidates.push(candidate);
  };
  const sessions = serviceOf(ctx, 'sessions');
  if (sessions !== undefined) {
    const live = typeof sessions.list === 'function'
      ? sessions.list()
      : typeof sessions.values === 'function' ? [...sessions.values()] : [];
    for (const session of Array.isArray(live) ? live : []) {
      const cwd = session?.header?.cwd;
      if (typeof cwd !== 'string' || cwd === '') continue;
      add({ cwd, sessionId: session?.id, agentPreset: session?.header?.agentPreset });
    }
  }
  if (candidates.length === 0) {
    const sessionQuery = serviceOf(ctx, 'sessionQuery');
    if (sessionQuery !== undefined && typeof sessionQuery.listSessions === 'function') {
      try {
        const records = await sessionQuery.listSessions();
        const recency = record => record?.header?.updatedAt ?? record?.updatedAt ?? record?.header?.time ?? 0;
        const sorted = (Array.isArray(records) ? [...records] : []).sort((a, b) => recency(b) - recency(a));
        for (const record of sorted) {
          const cwd = record?.header?.cwd ?? record?.cwd;
          if (typeof cwd !== 'string' || cwd === '') continue;
          add({ cwd, sessionId: record?.header?.id ?? record?.id, agentPreset: record?.header?.agentPreset });
        }
      } catch {
        // A storage backend that cannot list sessions must not fail the card; the
        // default preset below is still a usable read.
      }
    }
  }
  if (candidates.length === 0) add({ cwd: undefined, sessionId: undefined, agentPreset: undefined });
  const targets = [];
  for (const candidate of candidates) {
    targets.push({ ...candidate, ...await skillViewOf(ctx, candidate.sessionId, candidate.agentPreset) });
  }
  // A Host that composes neither sessions nor presets still has a working
  // directory, which is the workspace a CLI launch implies — and with no scope it
  // is the only read that can see a globally mounted provider at all.
  if (targets.length === 1 && targets[0].cwd === undefined && targets[0].scope === undefined) {
    try {
      targets[0] = { ...targets[0], cwd: process.cwd() };
    } catch {
      // `process.cwd()` throws only when the directory was deleted under a
      // running process; that is not a reason to fail the read.
    }
  }
  return targets;
}

/**
 * Query the Host's Skill registry once per read target.
 *
 * This is the whole point of the card: `ctx.skills` is the registry the `skill`
 * tool and the per-step catalog read, queried with the same cwd and the same
 * scope, so its answer — project `.dsh/skills` and `.agents/skills`, user
 * `$DSH_HOME/skills` and `~/.agents/skills`, custom and bundled roots, plugin
 * runtime Skills, with one winner per name — is by construction the list the
 * model can read. Nothing here walks a directory or parses frontmatter.
 *
 * @param ctx - the plugin's host context.
 * @returns the views to merge, whether the registry exists, and the caveats.
 */
export async function readSkillViews(ctx) {
  const targets = await resolveSkillTargets(ctx);
  const fallback = serviceOf(ctx, 'skills');
  const usable = service => service !== undefined && typeof service.list === 'function';
  if (!usable(fallback) && !targets.some(target => usable(target.registry))) {
    return {
      catalogAvailable: false,
      views: [],
      notes: ['这个宿主没有 skills 注册表，只能列出本插件安装的 Skill。'],
    };
  }
  const notes = [];
  const views = [];
  for (const target of targets) {
    const registry = usable(target.registry) ? target.registry : fallback;
    const options = target.cwd === undefined
      ? { scope: target.scope }
      : { cwd: target.cwd, scope: target.scope };
    try {
      views.push({ cwd: target.cwd, preset: target.agentPreset, skills: await registry.list(options) });
    } catch (error) {
      const where = target.cwd === undefined ? '用户级目录' : `工作区 ${target.cwd}`;
      notes.push(`${where} 的 Skill 读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (targets.every(target => target.cwd === undefined)) {
    notes.push('当前没有已挂载的工作区，只列出不依赖工作区的 Skill（用户级与内置目录）。');
  }
  return { catalogAvailable: true, views, notes };
}

/**
 * Whether a configured rtk path names something that can be run.
 *
 * Only a configured path is checked here. A path the user typed is used verbatim by
 * `rtk-compact`, which has no lookup step to consult, so this is the one case where
 * the answer cannot come from the Host's own resolver.
 *
 * @param path - the configured absolute path.
 * @returns true when the file exists and, on POSIX, carries an execute bit.
 */
async function isRunnable(path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    // Windows has no execute bit: a regular file at the configured path is the
    // strongest claim that can be checked without starting it.
    return process.platform === 'win32' || (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Answer whether this machine can run rtk, using the same seam `rtk-compact` uses.
 *
 * `available: null` means "could not tell". The page treats that as "leave the
 * feature's default alone", which is what keeps an older Host, or one without the
 * subprocess service, from looking like a machine that has no rtk.
 *
 * @param ctx - the plugin's host context.
 * @param configured - the `rtkPath` the page read from its own form, if any.
 * @returns the status the page renders.
 */
async function rtkStatus(ctx, configured) {
  if (configured !== '') {
    const runnable = await isRunnable(configured);
    return { available: runnable, path: runnable ? configured : null, source: 'configured' };
  }
  const subprocess = typeof ctx.get === 'function' ? ctx.get('subprocess') : undefined;
  if (subprocess === null || subprocess === undefined || typeof subprocess.resolveExecutable !== 'function') {
    return { available: null, path: null, source: 'unknown' };
  }
  try {
    const resolved = await subprocess.resolveExecutable('rtk');
    const path = typeof resolved === 'string' && resolved !== '' ? resolved : null;
    return { available: path !== null, path, source: 'path' };
  } catch {
    // The resolver rejects for exactly one reason: the name is not on PATH.
    return { available: false, path: null, source: 'path' };
  }
}

/**
 * The operations this route serves, keyed by the name the page sends.
 *
 * `ping` exists so the channel can be proven end to end before any page depends
 * on it: a probe has to come from the browser half, because only a browser request
 * carries the session cookie Connection's authentication policy requires.
 *
 * @param ctx - the plugin's host context.
 * @returns the operation table.
 */
function operationsOf(ctx) {
  return {
    ping: () => ({ ok: true, value: { pong: true } }),
    'rtk/status': async (body) => {
      const configured = typeof body.rtkPath === 'string' ? body.rtkPath.trim() : '';
      return { ok: true, value: await rtkStatus(ctx, configured) };
    },
    'skills/list': async () => {
      const catalog = await readSkillViews(ctx);
      const notes = [...catalog.notes];
      // The install registry is profile state, so an unmounted profile means the
      // provenance is unknown — not that the catalog is unreadable. The catalog is
      // still reported, the uninstall metadata is not, and the reason travels as a
      // note instead of failing the whole read.
      let managed = [];
      try {
        managed = await listManagedSkills(rootsOf(ctx));
      } catch (error) {
        notes.push(error instanceof Error ? error.message : String(error));
      }
      return {
        ok: true,
        value: assembleSkillCatalog({
          views: catalog.views,
          managed,
          catalogAvailable: catalog.catalogAvailable,
          notes,
        }),
      };
    },
    'skills/remove': async (body) => {
      const roots = rootsOf(ctx);
      // A refusal here is an answer, not a fault: the marker mismatch is the
      // plugin declining to delete something it cannot prove it installed.
      try {
        const removed = await uninstallManagedSkill({
          ...roots,
          directoryName: body.directoryName,
          installationId: body.installationId,
        });
        return { ok: true, value: { removed } };
      } catch (error) {
        return failure('extra-prompt/skill-not-removed', error instanceof Error ? error.message : String(error));
      }
    },
    'dashboard/data': async (body) => {
      try {
        const data = await readSessionDashboardFromHost(ctx, body?.sessionId);
        return { ok: true, value: data };
      } catch (error) {
        return failure('extra-prompt/dashboard-data-failed', error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/**
 * Publish the route for as long as this fiber lives.
 * @param ctx - the plugin's host context.
 */
export function apply(ctx) {
  const operations = operationsOf(ctx);
  const dispatch = async (request) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json(failure('extra-prompt/bad-request', 'body is not JSON'), { status: 400 });
    }
    const op = body === null || typeof body !== 'object' ? undefined : body.op;
    const run = typeof op === 'string' && Object.prototype.hasOwnProperty.call(operations, op)
      ? operations[op]
      : undefined;
    if (run === undefined) {
      return Response.json(failure('extra-prompt/unknown-op', `no operation named ${String(op)}`), { status: 400 });
    }
    try {
      return Response.json(await run(body));
    } catch (error) {
      // A thrown value cannot cross the route as a result, so every failure is
      // encoded here instead of escaping as a 500 the page cannot interpret.
      return Response.json(failure(
        'extra-prompt/operation-failed',
        error instanceof Error ? error.message : String(error),
      ), { status: 500 });
    }
  };
  ctx.effect(() => ctx.connection.fetch.register({
    path: PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: dispatch,
  }));
}
