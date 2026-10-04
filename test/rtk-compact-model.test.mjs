import assert from 'node:assert/strict'
import test from 'node:test'
import { filterForCommand, rebuildTextBlocks, splitTrailingMarkers } from '../src/rtk-compact/model.mjs'

test('splits a single exit marker off the body', () => {
  assert.deepEqual(splitTrailingMarkers('fatal: bad flag\n[exit code: 1]'), {
    body: 'fatal: bad flag\n',
    markers: ['[exit code: 1]'],
  })
})

test('splits a truncation notice that precedes the exit marker', () => {
  const { body, markers } = splitTrailingMarkers(
    'noise\n[output truncated; full output: C:\\Temp\\out.log]\n[exit code: 1]',
  )
  assert.equal(body, 'noise\n')
  assert.deepEqual(markers, [
    '[output truncated; full output: C:\\Temp\\out.log]',
    '[exit code: 1]',
  ])
})

test('recognizes every supported marker form', () => {
  for (const marker of [
    '[exit code: 0]',
    '[exit code: -1]',
    '[shell exited: code 3]',
    '[shell killed by signal: SIGKILL]',
    '[shell exited]',
  ]) {
    const { body, markers } = splitTrailingMarkers(`payload\n${marker}`)
    assert.equal(body, 'payload\n', `${marker} must be stripped from the body`)
    assert.deepEqual(markers, [marker])
  }
})

test('leaves a body with no marker untouched', () => {
  assert.deepEqual(splitTrailingMarkers('plain output\n'), {
    body: 'plain output\n',
    markers: [],
  })
})

test('keeps a bracketed line that only looks like a marker inside the body', () => {
  const text = 'see [exit code: 1] in the log\nmore text'
  assert.deepEqual(splitTrailingMarkers(text), { body: text, markers: [] })
})

test('replaces only the text region and preserves non-text blocks in order', () => {
  const image = { type: 'image', attachment: { attachmentId: 'a' } }
  const rebuilt = rebuildTextBlocks(
    [{ type: 'text', text: 'first' }, image, { type: 'text', text: 'second' }],
    'compressed',
  )
  assert.deepEqual(rebuilt, [{ type: 'text', text: 'compressed' }, image])
})

test('drops nothing when the only block is not text', () => {
  const image = { type: 'image', attachment: { attachmentId: 'a' } }
  assert.deepEqual(rebuildTextBlocks([image], 'compressed'), [
    image,
    { type: 'text', text: 'compressed' },
  ])
})

test('maps whitelisted commands to their filter and rejects everything else', () => {
  assert.equal(filterForCommand('git status --short'), 'git-status')
  assert.equal(filterForCommand('  git diff HEAD'), 'git-diff')
  assert.equal(filterForCommand('git log -n 100 --oneline'), 'git-log')
  assert.equal(filterForCommand('rg -n dock src'), 'rg')
  assert.equal(filterForCommand('grep -R foo .'), 'grep')
  assert.equal(filterForCommand('git statusx'), undefined)
  assert.equal(filterForCommand('echo rg'), undefined)
  assert.equal(filterForCommand('Get-ChildItem -Recurse src'), undefined)
})

test('honours per-command switches so one filter can be turned off from settings', () => {
  const gitLogOff = new Set(['gitLog'])
  assert.equal(filterForCommand('git log -n 100 --oneline', gitLogOff), undefined)
  // Switching one command off leaves its siblings alone.
  assert.equal(filterForCommand('git status --short', gitLogOff), 'git-status')
  assert.equal(filterForCommand('rg -n dock src', new Set(['rg'])), undefined)
  // Every rule switched off is plain passthrough.
  const allOff = new Set(['gitStatus', 'gitDiff', 'gitLog', 'rg', 'grep'])
  for (const command of ['git status', 'git diff HEAD', 'git log', 'rg x', 'grep x']) {
    assert.equal(filterForCommand(command, allOff), undefined, `${command} must pass through`)
  }
})
