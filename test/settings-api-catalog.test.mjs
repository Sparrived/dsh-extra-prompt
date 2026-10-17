// The Skill catalog the settings page renders.
//
// Two layers are pinned here. `catalog.mjs` is the pure assembly — merging the
// Host's per-workspace views, attaching managed-install records, keeping a record
// whose directory is gone. `src/settings-api/index.mjs` owns the two Host seams
// the assembly depends on: which workspaces are mounted, and the `ctx.skills`
// registry the model's own catalog is built from. Neither layer decides where
// Skills live, which is the point: a test here fails if the page ever starts
// re-implementing discovery instead of asking the registry.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CATALOG_ENTRIES,
  assembleSkillCatalog,
  attachManagedInstalls,
  catalogEntryOf,
  managedInstallOf,
  mergeCatalogViews,
  orphanManagedEntries,
} from '../src/settings-api/catalog.mjs';
import { MAX_WORKSPACES, readSkillViews, resolveSkillTargets } from '../src/settings-api/index.mjs';

/** One winning summary as `ctx.skills.list()` returns it. */
function summary(overrides = {}) {
  return {
    name: 'api-review',
    description: 'Review API changes.',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'project-dsh',
    provider: 'filesystem',
    resourceBase: { kind: 'directory', path: 'D:\\repo\\.dsh\\skills\\api-review' },
    ...overrides,
  };
}

/** One managed record as `listManagedSkills()` returns it. */
function record(overrides = {}) {
  return {
    directoryName: 'taste-skill',
    skillName: 'taste-skill',
    source: 'https://github.com/acme/skills',
    ref: 'main',
    path: 'skills/taste-skill',
    installationId: 'aa11',
    installPath: 'C:\\dsh\\skills\\taste-skill',
    removable: true,
    ...overrides,
  };
}

test('a catalog entry carries the registry fields, the directory, and its workspace', () => {
  const entry = catalogEntryOf(summary({ whenToUse: 'Use for API reviews.' }), 'D:\\repo');
  assert.deepEqual(entry, {
    skillName: 'api-review',
    description: 'Review API changes.',
    whenToUse: 'Use for API reviews.',
    source: 'project-dsh',
    provider: 'filesystem',
    modelInvocable: true,
    userInvocable: true,
    directory: 'D:\\repo\\.dsh\\skills\\api-review',
    workspace: 'D:\\repo',
  });
  // A cwd-less read has no workspace to report, and a resource base that is not a
  // directory has no path to claim: guessing one would be worse than omitting it.
  const bare = catalogEntryOf({
    name: 'remote',
    description: 'Remote skill.',
    invocation: { modelInvocable: false, userInvocable: true },
    source: 'custom',
    provider: 'registry',
    resourceBase: { kind: 'url', url: 'https://example.test/skill' },
  }, undefined);
  assert.equal(bare.workspace, undefined);
  assert.equal(bare.directory, undefined);
  assert.equal(bare.modelInvocable, false);
  assert.equal(bare.userInvocable, true);
});

test('a summary the registry never resolved is not reported as invocable', () => {
  const entry = catalogEntryOf({ name: 'mystery', description: '' }, undefined);
  assert.equal(entry.modelInvocable, false);
  assert.equal(entry.userInvocable, false);
  assert.equal(entry.description, '');
});

test('merging views keeps the first view that saw a name', () => {
  const merged = mergeCatalogViews([
    { cwd: 'D:\\first', skills: [summary(), summary({ name: 'shared', description: 'From first.' })] },
    { cwd: 'D:\\second', skills: [summary({ name: 'shared', description: 'From second.' }), summary({ name: 'other' })] },
    { cwd: undefined, skills: [summary({ name: 'user-only', source: 'user-dsh' })] },
  ]);
  assert.deepEqual(merged.map(entry => entry.skillName), ['api-review', 'shared', 'other', 'user-only']);
  // The workspace that wins is the one whose body the model would load there.
  assert.deepEqual(merged.map(entry => entry.workspace), ['D:\\first', 'D:\\first', 'D:\\second', undefined]);
  assert.equal(merged.find(entry => entry.skillName === 'shared').description, 'From first.');
});

test('merging stops at the entry ceiling instead of flooding the card', () => {
  const many = Array.from({ length: MAX_CATALOG_ENTRIES + 25 }, (_, index) => summary({ name: `skill-${index}` }));
  assert.equal(mergeCatalogViews([{ cwd: 'D:\\repo', skills: many }]).length, MAX_CATALOG_ENTRIES);
  // A caller may ask for less; the default is the ceiling, not a floor.
  assert.equal(mergeCatalogViews([{ cwd: 'D:\\repo', skills: many }], 3).length, 3);
  assert.deepEqual(mergeCatalogViews(undefined), []);
});

test('an install record is matched by path first and by name second', () => {
  const { skills, claimed } = attachManagedInstalls([
    catalogEntryOf(summary(), 'D:\\repo'),
    catalogEntryOf(summary({ name: 'named-only', resourceBase: { kind: 'opaque', description: 'managed elsewhere' } }), 'D:\\repo'),
  ], [
    record({ installPath: 'D:\\repo\\.dsh\\skills\\api-review', skillName: 'not-this-name' }),
    record({ directoryName: 'named-only', skillName: 'named-only', installPath: 'C:\\elsewhere\\named-only', removable: false, reason: '标记不一致' }),
  ]);
  assert.equal(skills[0].managed.installationId, 'aa11');
  assert.equal(skills[0].managed.removable, true);
  assert.equal(skills[0].managed.reason, undefined);
  assert.equal(skills[1].managed.removable, false);
  assert.equal(skills[1].managed.reason, '标记不一致');
  assert.equal(claimed.size, 2);
  // A catalog entry this package did not install carries no managed field at all,
  // which is what keeps the page from offering a button the Host would refuse.
  assert.equal(catalogEntryOf(summary({ name: 'unrelated' }), 'D:\\repo').managed, undefined);
});

test('a record whose directory is gone is still reported, as an orphan', () => {
  const managed = [record({ skillName: 'gone', directoryName: 'gone', installPath: 'C:\\dsh\\skills\\gone', removable: false, reason: '目录已不存在，可以清理这条记录。' })];
  const { skills, claimed } = attachManagedInstalls([catalogEntryOf(summary(), 'D:\\repo')], managed);
  assert.equal(skills.length, 1);
  assert.equal(claimed.size, 0);
  const orphans = orphanManagedEntries(managed, claimed);
  assert.deepEqual(orphans, [{
    skillName: 'gone',
    description: '',
    orphan: true,
    directory: 'C:\\dsh\\skills\\gone',
    managed: {
      directoryName: 'gone',
      installationId: 'aa11',
      source: 'https://github.com/acme/skills',
      ref: 'main',
      installPath: 'C:\\dsh\\skills\\gone',
      removable: false,
      reason: '目录已不存在，可以清理这条记录。',
    },
  }]);
});

test('the assembled catalog reports the workspaces it read and the caveats it hit', () => {
  const value = assembleSkillCatalog({
    views: [
      { cwd: 'D:\\repo', skills: [summary()] },
      { cwd: undefined, skills: [summary({ name: 'office-docx', source: 'bundled' })] },
    ],
    managed: [record({ installPath: 'D:\\repo\\.dsh\\skills\\api-review' })],
    notes: ['插件的注入已失效'],
  });
  assert.equal(value.catalogAvailable, true);
  assert.deepEqual(value.skills.map(entry => entry.skillName), ['api-review', 'office-docx']);
  assert.equal(value.skills[0].managed.removable, true);
  assert.deepEqual(value.workspaces, [{ cwd: 'D:\\repo', found: 1 }]);
  assert.deepEqual(value.notes, ['插件的注入已失效']);
  // The default is "the registry was readable": a caller that forgets the flag must
  // not be reported as a Host with no skills service.
  assert.equal(assembleSkillCatalog({}).catalogAvailable, true);
  assert.deepEqual(assembleSkillCatalog({}).skills, []);
});

test('managedInstallOf tolerates a record with no provenance left', () => {
  const install = managedInstallOf({ directoryName: 'x', skillName: 'x', installationId: 'id' });
  assert.deepEqual(install, { directoryName: 'x', installationId: 'id', removable: false });
});

test('a read target carries the scope the model lookup itself uses', async () => {
  const agent = { id: 'agent-live' };
  const standing = { id: 'standing-minimal' };
  const ctx = contextWith({
    sessions: {
      list: () => [
        { id: 'live', header: { cwd: 'D:\\repo', agentPreset: 'standard' } },
        { id: 'cold', header: { cwd: 'D:\\other', agentPreset: 'minimal' } },
        { id: 'unknown', header: { cwd: 'D:\\third', agentPreset: 'deleted' } },
        { id: 'twin', header: { cwd: 'D:\\repo', agentPreset: 'standard' } },
      ],
    },
    agents: { get: id => (id === 'live' ? agent : undefined) },
    agentPresets: {
      standingKeyFor: async (id) => {
        if (id === 'minimal') return standing;
        throw new Error(`unknown preset "${id}"`)
      },
    },
  });
  const targets = await resolveSkillTargets(ctx);
  // One target per distinct workspace, in the order the sessions were listed.
  assert.deepEqual(targets.map(target => target.cwd), ['D:\\repo', 'D:\\other', 'D:\\third']);
  assert.equal(targets[0].scope, agent, 'a live agent is the scope itself');
  assert.equal(targets[1].scope, standing, "a cold session uses its preset's standing key");
  assert.equal(targets[2].scope, undefined, 'an unusable preset degrades to the global layer');
});

test('resolveSkillTargets caps the work one page read can schedule', async () => {
  const many = Array.from({ length: MAX_WORKSPACES + 4 }, (_, index) => ({ header: { cwd: `D:\\w${index}` } }));
  const ctx = contextWith({ sessions: { list: () => many } });
  const targets = await resolveSkillTargets(ctx);
  assert.equal(targets.length, MAX_WORKSPACES);
  assert.equal(targets[0].cwd, 'D:\\w0');
});

test('with no live session the most recently stored workspace stands in, then the Host cwd', async () => {
  const stored = contextWith({
    sessions: { list: () => [] },
    sessionQuery: {
      listSessions: async () => [
        { header: { id: 'old', cwd: 'D:\\old', updatedAt: 10 } },
        { header: { id: 'new', cwd: 'D:\\new', updatedAt: 99 } },
      ],
    },
  });
  assert.deepEqual((await resolveSkillTargets(stored)).map(target => target.cwd), ['D:\\new', 'D:\\old']);

  // A backend that cannot list sessions must leave the fallback, not fail the read.
  const broken = contextWith({
    sessions: { list: () => [] },
    sessionQuery: { listSessions: async () => { throw new Error('storage offline') } },
  });
  // No preset roster either, so the Host's own cwd is the only workspace left — and
  // with no scope it is the only read that can see a globally mounted provider.
  const targets = await resolveSkillTargets(broken);
  assert.deepEqual(targets.map(target => target.cwd), [process.cwd()]);
  assert.equal(targets[0].scope, undefined);
});

test('readSkillViews asks the Host registry once per read target, with the model scope', async () => {
  const calls = [];
  const agent = { id: 'agent-live' };
  const ctx = contextWith({
    sessions: { list: () => [{ id: 'live', header: { cwd: 'D:\\repo', agentPreset: 'standard' } }] },
    agents: { get: () => agent },
    skills: {
      list: async (options) => {
        calls.push(options);
        return [summary()];
      },
    },
  });
  const { catalogAvailable, views, notes } = await readSkillViews(ctx);
  assert.equal(catalogAvailable, true);
  // One read per workspace: the workspace read already carries the user-level and
  // bundled roots, so a second cwd-less pass would only duplicate them.
  assert.deepEqual(calls, [{ cwd: 'D:\\repo', scope: agent }]);
  assert.deepEqual(views.map(view => view.cwd), ['D:\\repo']);
  assert.deepEqual(notes, []);
  assert.deepEqual(assembleSkillCatalog({ views, managed: [], catalogAvailable, notes }).skills
    .map(entry => entry.skillName), ['api-review']);
});

test('a composition that realm-mounts its own registry is addressed through the live agent', async () => {
  const agent = { id: 'agent-live' };
  const scoped = { list: async () => [summary({ name: 'realm-skill' })] };
  const ctx = contextWith({
    sessions: { list: () => [{ id: 'live', header: { cwd: 'D:\\repo' } }] },
    agents: { get: () => agent },
    agentPresets: { serviceFor: (target, name) => (target === agent && name === 'skills' ? scoped : undefined) },
    skills: { list: async () => { throw new Error('the host registry must not serve a realm composition') } },
  });
  const { views } = await readSkillViews(ctx);
  assert.deepEqual(views[0].skills.map(skill => skill.name), ['realm-skill']);
});

test('with no session at all the read uses the default preset scope and no workspace', async () => {
  const calls = [];
  const standing = { id: 'standing-default' };
  const ctx = contextWith({
    skills: { list: async (options) => { calls.push(options); return [summary({ name: 'user-only', source: 'user-dsh' })] } },
    agentPresets: { standingKeyFor: async (id) => { assert.equal(id, undefined, 'the default preset is addressed by absence'); return standing } },
  });
  const { catalogAvailable, views, notes } = await readSkillViews(ctx);
  assert.equal(catalogAvailable, true);
  assert.deepEqual(calls, [{ scope: standing }]);
  assert.deepEqual(views.map(view => view.cwd), [undefined]);
  assert.equal(notes.length, 1);
  assert.ok(notes[0].includes('没有已挂载的工作区'), notes[0]);
});

test('a Host without a skills registry reports that instead of an empty directory walk', async () => {
  const { catalogAvailable, views, notes } = await readSkillViews(contextWith({ sessions: { list: () => [] } }));
  assert.equal(catalogAvailable, false);
  assert.deepEqual(views, []);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /skills/u);
});

test('a failing workspace read is reported as a caveat, not as an empty catalog', async () => {
  const ctx = contextWith({
    sessions: { list: () => [{ header: { cwd: 'D:\\repo' } }] },
    skills: {
      list: async (options) => {
        if (options.cwd !== undefined) throw new Error('EACCES')
        return [summary({ name: 'user-only', source: 'user-dsh' })]
      },
    },
  });
  const { catalogAvailable, views, notes } = await readSkillViews(ctx);
  assert.equal(catalogAvailable, true);
  assert.deepEqual(views, []);
  assert.equal(notes.length, 1);
  assert.ok(notes[0].includes('D:\\repo'), `the failing workspace must be named: ${notes[0]}`);
  assert.ok(notes[0].includes('EACCES'), `the cause must survive: ${notes[0]}`);
});

/**
 * A context double exposing only `ctx.get()`.
 *
 * @param services - the services this context answers for.
 * @returns the double.
 */
function contextWith(services) {
  return { get: name => services[name] };
}
