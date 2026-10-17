// End-to-end exercise of the settings route behind the Skill card.
//
// `apply()` is mounted on a context double, and then the exact POST the browser
// half issues is handed to the registered route. That covers the seam the unit
// tests cannot: the route's own envelope, the real managed-install registry read
// (a temporary profile with a real marker file), and the fact that `skills/list`
// asks the Host's registry — not a directory walk — for the catalog.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PATH, apply } from '../src/settings-api/index.mjs';
import { MANAGED_SKILL_REGISTRY_FILE, registerManagedSkill } from '../src/skill-installer/managed-registry.mjs';

/** One summary shaped the way `ctx.skills.list()` returns it. */
function summary(name, source, directory) {
  return {
    name,
    description: `${name} does something.`,
    invocation: { modelInvocable: true, userInvocable: true },
    source,
    provider: 'filesystem',
    resourceBase: { kind: 'directory', path: directory },
  };
}

/**
 * A context double exposing only what this row declares and reads.
 *
 * @param services - the services `ctx.get()` answers for.
 * @returns the context and every route this row registered.
 */
function contextOf(services) {
  const routes = [];
  const ctx = {
    get: name => services[name],
    effect: (callback) => {
      const disposer = callback();
      return () => { if (typeof disposer === 'function') disposer(); };
    },
    connection: {
      fetch: {
        register: (options) => { routes.push(options); return () => {}; },
      },
    },
  };
  return { ctx, routes };
}

/** The POST the browser half sends, through the route the row published. */
async function post(route, body) {
  const response = await route.fetch(new Request(`http://127.0.0.1${PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

/**
 * A temp harness: a workspace, the user Skills root with one installed Skill, and
 * the profile that records it — the three places this card reads from.
 */
async function harness(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'extra-prompt-catalog-'));
  const workspace = join(root, 'workspace');
  const skillsRoot = join(root, 'skills');
  const profileDir = join(root, 'profiles', 'test');
  const installDir = join(skillsRoot, 'demo-skill');
  const marker = {
    version: 1,
    owner: 'extra-prompt',
    directoryName: 'demo-skill',
    skillName: 'demo-skill',
    source: 'https://github.com/acme/skills/tree/main',
    ref: 'main',
    path: '.',
    installationId: 'aa11aa11-1111-4111-8111-111111111111',
  };
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: Installed by this package.\n---\n\nUse it.\n');
  if (options.installMarker !== false) {
    await writeFile(join(installDir, '.dsh-managed-skill.json'), JSON.stringify(marker));
  }
  // The registry row holds the six record fields; `version` and `owner` belong to
  // the marker file inside the Skill directory.
  if (options.record !== false) {
    const { version, owner, ...record } = marker;
    await registerManagedSkill(profileDir, record);
  }
  return { root, workspace, skillsRoot, profileDir, installDir, marker };
}

test('the route publishes one POST path and answers the catalog the Host registry returns', async () => {
  const fixture = await harness();
  const calls = [];
  const liveAgent = { id: 'agent-1' };
  const skills = {
    list: async (options) => {
      calls.push(options);
      const installed = summary('demo-skill', 'user-dsh', fixture.installDir);
      const bundled = summary('office-docx', 'bundled', join(fixture.root, 'bundled', 'office-docx'));
      return [summary('api-review', 'project-dsh', join(fixture.workspace, '.dsh', 'skills', 'api-review')), installed, bundled];
    },
  };
  const { ctx, routes } = contextOf({
    dshHome: fixture.root,
    profileContext: { dir: fixture.profileDir },
    sessions: { list: () => [{ id: 'session-1', header: { cwd: fixture.workspace, agentPreset: 'standard' } }] },
    agents: { get: id => (id === 'session-1' ? liveAgent : undefined) },
    skills,
  });
  try {
    apply(ctx);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].path, PATH);
    assert.deepEqual(routes[0].methods, ['POST']);

    const { status, body } = await post(routes[0], { op: 'skills/list' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    // One query per mounted workspace, made with the session's cwd and the live
    // agent as the view scope — the same two values the model's own lookup passes.
    assert.deepEqual(calls, [{ cwd: fixture.workspace, scope: liveAgent }]);
    assert.equal(body.value.catalogAvailable, true);
    assert.deepEqual(body.value.workspaces, [{ cwd: fixture.workspace, found: 3, preset: 'standard' }]);
    assert.deepEqual(body.value.notes, []);
    assert.deepEqual(body.value.skills.map(entry => entry.skillName), ['api-review', 'demo-skill', 'office-docx']);

    const project = body.value.skills[0];
    assert.equal(project.source, 'project-dsh');
    assert.equal(project.workspace, fixture.workspace);
    assert.equal(project.directory, join(fixture.workspace, '.dsh', 'skills', 'api-review'));
    assert.equal(project.managed, undefined, 'a Skill this package did not install carries no install record');

    // The installed Skill is described by both halves: where the registry found it
    // and what this package wrote there.
    const installed = body.value.skills[1];
    assert.equal(installed.source, 'user-dsh');
    assert.equal(installed.managed.directoryName, 'demo-skill');
    assert.equal(installed.managed.installationId, 'aa11aa11-1111-4111-8111-111111111111');
    assert.equal(installed.managed.removable, true);
    assert.equal(installed.managed.source, 'https://github.com/acme/skills/tree/main');
    assert.equal(installed.managed.ref, 'main');
    assert.equal(installed.managed.reason, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('the uninstall the card offers deletes the directory its record proves, and nothing else', async () => {
  const fixture = await harness();
  const { ctx, routes } = contextOf({
    dshHome: fixture.root,
    profileContext: { dir: fixture.profileDir },
    sessions: { list: () => [{ header: { cwd: fixture.workspace } }] },
    skills: { list: async () => [summary('demo-skill', 'user-dsh', fixture.installDir)] },
  });
  try {
    apply(ctx);
    const before = await post(routes[0], { op: 'skills/list' });
    assert.equal(before.body.value.skills[0].managed.removable, true);

    // The wrong installation identity is a refusal, not a deletion.
    const refused = await post(routes[0], { op: 'skills/remove', directoryName: 'demo-skill', installationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    assert.equal(refused.status, 200);
    assert.equal(refused.body.ok, false);
    assert.equal(refused.body.error.code, 'extra-prompt/skill-not-removed');
    await stat(join(fixture.installDir, 'SKILL.md'));

    const removed = await post(routes[0], { op: 'skills/remove', directoryName: 'demo-skill', installationId: 'aa11aa11-1111-4111-8111-111111111111' });
    assert.equal(removed.body.ok, true);
    assert.equal(removed.body.value.removed.skillName, 'demo-skill');
    await assert.rejects(stat(fixture.installDir), { code: 'ENOENT' });
    const registry = JSON.parse(await readFile(join(fixture.profileDir, MANAGED_SKILL_REGISTRY_FILE), 'utf8'));
    assert.deepEqual(registry.entries, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('an unmounted profile loses the provenance, not the catalog', async () => {
  const fixture = await harness({ record: false });
  const { ctx, routes } = contextOf({
    dshHome: fixture.root,
    sessions: { list: () => [{ header: { cwd: fixture.workspace } }] },
    skills: { list: async () => [summary('api-review', 'project-dsh', join(fixture.workspace, '.dsh', 'skills', 'api-review'))] },
  });
  try {
    apply(ctx);
    const { body } = await post(routes[0], { op: 'skills/list' });
    assert.equal(body.ok, true);
    assert.deepEqual(body.value.skills.map(entry => entry.skillName), ['api-review']);
    // The reason an uninstall is impossible is stated instead of silently dropping
    // the install metadata.
    assert.equal(body.value.notes.length, 1);
    assert.ok(body.value.notes[0].includes(MANAGED_SKILL_REGISTRY_FILE), body.value.notes[0]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a Host without a skills registry still reports what this package installed', async () => {
  const fixture = await harness();
  const { ctx, routes } = contextOf({
    dshHome: fixture.root,
    profileContext: { dir: fixture.profileDir },
    sessions: { list: () => [{ header: { cwd: fixture.workspace } }] },
  });
  try {
    apply(ctx);
    const { body } = await post(routes[0], { op: 'skills/list' });
    assert.equal(body.ok, true);
    assert.equal(body.value.catalogAvailable, false);
    assert.equal(body.value.notes.length, 1);
    assert.ok(body.value.notes[0].includes('skills'), body.value.notes[0]);
    assert.deepEqual(body.value.skills.map(entry => entry.skillName), ['demo-skill']);
    // The record is real and removable; only its place in the model's catalog is
    // unknown, and the row says so without inventing a Skill behind it.
    assert.equal(body.value.skills[0].orphan, true);
    assert.equal(body.value.skills[0].managed.removable, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
