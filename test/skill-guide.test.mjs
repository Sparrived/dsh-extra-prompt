// The guide body and its SkillRegistration are pure data, so they are tested
// directly rather than through the plugin entry: importing the entry would pull
// in `@deepseek-ai/schemastery`, which only resolves inside a DSH runtime.

import assert from 'node:assert/strict'
import test from 'node:test'
import { guideRegistration, resolveGuideContent } from '../src/skill-guide/guide.mjs'

test('contributes exactly one runtime skill named skill-create', () => {
  const skill = guideRegistration('')
  assert.equal(skill.name, 'skill-create')
  assert.equal(skill.source, 'runtime')
  // 运行时 Skill 由注册表拥有 provider 标签；省略 invocation 让模型和用户都能调用。
  assert.equal(skill.provider, undefined, 'runtime skills let the registry own the provider label')
  assert.equal(skill.invocation, undefined, 'omitted invocation keeps the skill model- and user-invocable')
  assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
})

test('describes when to use the skill for routing', () => {
  const skill = guideRegistration('')
  for (const field of ['description', 'whenToUse']) {
    assert.equal(typeof skill[field], 'string')
    assert.notEqual(skill[field].trim(), '', `${field} must not be blank`)
  }
})

test('documents the frontmatter contract the filesystem provider actually parses', () => {
  const { content } = guideRegistration('')
  assert.equal(typeof content, 'string')
  for (const marker of [
    'name: api-review',
    'description:',
    'whenToUse:',
    'disable-model-invocation',
    'user-invocable',
  ]) {
    assert.ok(content.includes(marker), `guide must document ${marker}`)
  }
  assert.ok(content.includes('.dsh/skills/<skill-name>/SKILL.md'), 'guide must state the project skill path')
  assert.ok(!content.includes('\r'), 'guide body uses LF newlines')
})

test('lets a non-empty override replace the built-in body verbatim', () => {
  assert.equal(resolveGuideContent('  自定义指导  '), '自定义指导')
  // 空白与缺失都退回内置正文，否则清空输入框会让这个 Skill 变成空壳。
  assert.equal(resolveGuideContent(''), resolveGuideContent(undefined))
  assert.equal(resolveGuideContent('   '), resolveGuideContent(undefined))
  assert.ok(resolveGuideContent(undefined).includes('SKILL.md'))
})

test('builds a fresh registration per call so Fiber disposal cannot share state', () => {
  const first = guideRegistration('')
  const second = guideRegistration('')
  assert.notEqual(first, second)
  assert.deepEqual(first, second)
})
