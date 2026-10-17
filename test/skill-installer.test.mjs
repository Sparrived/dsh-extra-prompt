import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSkillFromSource, skillInstallGate, validateGitRef } from '../src/skill-installer/installer.mjs'

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function zipFile(path, content, offset) {
  const name = Buffer.from(path, 'utf8')
  const bytes = Buffer.from(content, 'utf8')
  const crc = crc32(bytes)
  const local = Buffer.alloc(30 + name.length + bytes.length)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(bytes.length, 18)
  local.writeUInt32LE(bytes.length, 22)
  local.writeUInt16LE(name.length, 26)
  name.copy(local, 30)
  bytes.copy(local, 30 + name.length)

  const central = Buffer.alloc(46 + name.length)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(bytes.length, 20)
  central.writeUInt32LE(bytes.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE(0, 38)
  central.writeUInt32LE(offset, 42)
  name.copy(central, 46)
  return { local, central }
}

function makeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [path, content] of files) {
    const entry = zipFile(path, content, offset)
    locals.push(entry.local)
    centrals.push(entry.central)
    offset += entry.local.length
  }
  const central = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, end])
}

test('rejects unsafe Git refs while preserving legal branch and commit forms', () => {
  assert.equal(validateGitRef('main'), 'main')
  assert.equal(validateGitRef('feature/with-slash'), 'feature/with-slash')
  assert.equal(validateGitRef('0123456789abcdef0123456789abcdef01234567'), '0123456789abcdef0123456789abcdef01234567')
  for (const ref of ['@', '+foo', 'feature/.hidden', 'release.lock', 'feature/.lock', 'feature//branch', 'feature..branch', 'feature@{1}', 'feature~x', 'feature^x', 'feature:x', 'feature?x', 'feature*x', 'feature[x]', 'feature\\x', 'feature x']) {
    assert.throws(() => validateGitRef(ref), error => error.code === 'invalid-ref')
  }
})

test('gates Skill install on the session approval policy and delegation depth', () => {
  // A fake approval service: the gate must read the policy through its durable
  // overrideOf() fold, never through a (`Session` has no) session event array.
  const approval = (override, defaultPolicy) => ({
    config: defaultPolicy === undefined ? {} : { policy: defaultPolicy },
    overrideOf: () => override,
  })
  const top = { header: {} }
  const child = { header: { delegationDepth: 2 } }

  // Default ask: interactive approval.
  assert.equal(skillInstallGate(approval(undefined, undefined), top), 'ask')
  assert.equal(skillInstallGate(approval('ask', undefined), top), 'ask')
  // A user-chosen never (e.g. the full-access preset) is global consent: skip the prompt.
  assert.equal(skillInstallGate(approval('never', 'ask'), top), 'skip')
  assert.equal(skillInstallGate(approval('never', undefined), top), 'skip')
  // A never policy from the approval service default is deployment/user intent too.
  assert.equal(skillInstallGate(approval(undefined, 'never'), top), 'skip')
  // An ask override wins over a never deployment default.
  assert.equal(skillInstallGate(approval('ask', 'never'), top), 'ask')

  // A delegation-pinned never must not install unattended: the child seed wins
  // over the configured default.
  assert.equal(skillInstallGate(approval('never', 'ask'), child), 'reject')
  assert.equal(skillInstallGate(approval('never', undefined), child), 'reject')
  assert.equal(skillInstallGate(approval(undefined, 'never'), child), 'reject')
  // A later switch to ask still wins in a child.
  assert.equal(skillInstallGate(approval('ask', 'never'), child), 'ask')

  // Without the durable fold there is no safe answer; silently falling back to
  // the configured default is exactly the "always ask" bug this gate prevents.
  assert.throws(
    () => skillInstallGate({ config: { policy: 'never' } }, top),
    /overrideOf/,
  )
})

test('downloads, validates, copies, and marks a Skill before the commit rename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extra-prompt-installer-test-'))
  const destinationRoot = join(root, 'skills')
  const profileDir = join(root, 'profiles', 'test')
  const archive = makeZip([
    ['demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: A test skill\n---\n\nUse it.\n'],
    ['demo-skill/README.md', 'test\n'],
  ])
  const previousFetch = globalThis.fetch
  let committed = false
  globalThis.fetch = async () => new Response(archive, {
    status: 200,
    headers: { 'content-type': 'application/zip', 'content-length': String(archive.length) },
  })
  try {
    const result = await installSkillFromSource({
      source: 'https://github.com/acme/demo-skill',
      path: '.',
      ref: 'main',
      method: 'download',
    }, {
      destRoot: destinationRoot,
      profileDir,
      onCommit: () => { committed = true },
    })
    assert.equal(committed, true)
    assert.equal(result.method, 'download')
    // 有 profile 时确实写下了受管记录，所以模型可以看到它是被托管的。
    assert.equal(result.registered, true)
    assert.equal(await readFile(join(destinationRoot, 'demo-skill', 'SKILL.md'), 'utf8'), '---\nname: demo-skill\ndescription: A test skill\n---\n\nUse it.\n')
    const marker = JSON.parse(await readFile(join(destinationRoot, 'demo-skill', '.dsh-managed-skill.json'), 'utf8'))
    assert.match(marker.installationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    assert.deepEqual({ ...marker, installationId: undefined }, {
      version: 1,
      owner: 'extra-prompt',
      directoryName: 'demo-skill',
      skillName: 'demo-skill',
      source: 'https://github.com/acme/demo-skill/tree/main',
      ref: 'main',
      path: '.',
      installationId: undefined,
    })
    const registry = JSON.parse(await readFile(join(profileDir, 'extra-prompt-managed-skills.json'), 'utf8'))
    assert.deepEqual(registry, {
      version: 1,
      entries: [{
        directoryName: 'demo-skill',
        skillName: 'demo-skill',
        source: 'https://github.com/acme/demo-skill/tree/main',
        ref: 'main',
        path: '.',
        installationId: marker.installationId,
      }],
    })
  } finally {
    globalThis.fetch = previousFetch
    await rm(root, { recursive: true, force: true })
  }
})

test('installs without a mounted profile and reports that provenance was not recorded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extra-prompt-installer-noprofile-'))
  const destinationRoot = join(root, 'skills')
  const archive = makeZip([
    ['demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: A test skill\n---\n'],
  ])
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(archive, {
    status: 200,
    headers: { 'content-type': 'application/zip', 'content-length': String(archive.length) },
  })
  try {
    const result = await installSkillFromSource({
      source: 'https://github.com/acme/demo-skill',
      path: '.',
      ref: 'main',
      method: 'download',
    }, { dshHome: root, destRoot: destinationRoot })
    // 没有挂载 profile 时 Skill 仍然装好，只是无法登记可自动卸载的来源记录。
    assert.equal(result.method, 'download')
    // 模型可见的输出里必须承认这一点，否则模型会以为这个 Skill 已被托管、可自动卸载。
    assert.equal(result.registered, false)
    assert.match(await readFile(join(destinationRoot, 'demo-skill', 'SKILL.md'), 'utf8'), /demo-skill/)
    assert.ok(
      result.warnings.some(warning => warning.includes('profile')),
      `expected a profile warning, got ${JSON.stringify(result.warnings)}`,
    )
    // 关键回归：绝不猜测 profile 名字，也不写出任何 profiles 目录。
    await assert.rejects(stat(join(root, 'profiles')), error => error?.code === 'ENOENT')
  } finally {
    globalThis.fetch = previousFetch
    await rm(root, { recursive: true, force: true })
  }
})
