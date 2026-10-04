// The settings page's data channel.
//
// The page shows two things that are not configuration and cannot be read from a
// config namespace: the registry of Skills this package installed, which is a file
// next to the profile written by `skill-installer`, and whether this machine has the
// `rtk` executable at all. The browser cannot read either of them.
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
import { listSessionsFromHost, readSessionDashboardFromHost } from '../session-dashboard/model.mjs';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'extra-settings-api';

/** The Connection service must exist before this row can publish anything. */
export const inject = ['connection'];

/** The exact path this plugin owns below `/api`. */
export const PATH = '/api/extra-prompt';

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
      const roots = rootsOf(ctx);
      return { ok: true, value: { skills: await listManagedSkills(roots) } };
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
    'dashboard/sessions': async () => {
      try {
        const sessions = await listSessionsFromHost(ctx);
        return { ok: true, value: { sessions } };
      } catch (error) {
        return failure('extra-prompt/dashboard-sessions-failed', error instanceof Error ? error.message : String(error));
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
