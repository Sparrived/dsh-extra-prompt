import assert from 'node:assert/strict'
import test from 'node:test'
import { CLEARED_INJECTION, PROMPT_NAMESPACE, injectionBody, injectionMessage, isInjectionSource, nextInjection, systemReminderBlock } from '../src/prompt-injection/model.mjs'

test('injects nothing on the first step when the setting is absent or blank', () => {
  assert.equal(nextInjection(null, undefined), undefined)
  assert.equal(nextInjection(null, ''), undefined)
  assert.equal(nextInjection(null, '   \n\t '), undefined)
  assert.equal(nextInjection(null, 7), undefined)
})

test('injects the trimmed text of a fresh setting', () => {
  assert.equal(nextInjection(null, '  总是先跑测试  '), '总是先跑测试')
})

test('keeps the user text verbatim, including prompt-variable-looking braces', () => {
  // 注入内容直接成为 user/message，不参与 system prompt 的模板插值，
  // 所以 `{{name}}` 必须原样保留，不能被改写也不能被替换。
  assert.equal(nextInjection(null, '请始终以 {{model}} 的风格回答'), '请始终以 {{model}} 的风格回答')
  assert.equal(nextInjection(null, '用 {{{ 和 }}} 与 {{}} 的写法'), '用 {{{ 和 }}} 与 {{}} 的写法')
})

test('re-injects only when the text actually changes', () => {
  assert.equal(nextInjection('旧的注入', '旧的注入'), undefined)
  // 只有首尾空白不同不算变化，否则每个 step 都会白白追加一行。
  assert.equal(nextInjection('旧的注入', '  旧的注入\n'), undefined)
  assert.equal(nextInjection('旧的注入', '新的注入'), '新的注入')
})

test('clearing the setting tells the model the earlier injection is void', () => {
  assert.equal(nextInjection('旧的注入', ''), CLEARED_INJECTION)
  // 已经声明过失效后不再重复追加。
  assert.equal(nextInjection(CLEARED_INJECTION, ''), undefined)
  assert.equal(nextInjection(CLEARED_INJECTION, '   '), undefined)
})

test('a new text after clearing is injected again, and so is the same text later', () => {
  assert.equal(nextInjection(CLEARED_INJECTION, '重新启用'), '重新启用')
  // 清空后重新写回原文，需要重新注入，而不是被当成"没变"。
  assert.equal(nextInjection(CLEARED_INJECTION, '旧的注入'), '旧的注入')
})

test('the injected message declares its own producer kind instead of the retired plugin wrapper', () => {
  const message = injectionMessage('总是先跑测试', PROMPT_NAMESPACE)
  const block = '<system-reminder>\n\n总是先跑测试\n\n</system-reminder>'
  // 会话格式 v4 拒绝共享的 `plugin` 来源：写这样一条消息会让落盘直接抛
  // `format v4 message requires a producer-owned source kind`，整个 Session 无法运行。
  assert.equal(message.source.kind, PROMPT_NAMESPACE)
  assert.equal(Object.hasOwn(message.source, 'plugin'), false)
  // 快照形态与 DSH 自身的运行时上下文一致，轨迹据此显示成一条注入行。
  assert.equal(message.source.form, 'snapshot')
  assert.deepEqual(message.source.sections, [{ name: PROMPT_NAMESPACE, text: block }])
  assert.deepEqual(message.content, [{ type: 'text', text: block }])
})

test('wraps the injection body in a system-reminder block automatically', () => {
  assert.equal(systemReminderBlock('总是先跑测试'), '<system-reminder>\n\n总是先跑测试\n\n</system-reminder>')
  // 注入的是用户正文本身；块只由插件添加一次。
  assert.equal(injectionBody('<system-reminder>\n\n总是先跑测试\n\n</system-reminder>'), '总是先跑测试')
  assert.equal(injectionBody('总是先跑测试'), '总是先跑测试')
})

test('does not wrap a hand-written block a second time', () => {
  const handWritten = '<system-reminder>\n\n旧的注入\n\n</system-reminder>'
  assert.equal(systemReminderBlock(handWritten), handWritten)
  // 旧配置（带手写块）与新配置（纯正文）在比较时被视为同一个正文。
  assert.equal(nextInjection(null, handWritten), '旧的注入')
  assert.equal(nextInjection(handWritten, '旧的注入'), undefined)
})

test('recognises an already-delivered wrapped injection as unchanged', () => {
  // 注入写进会话后带上了插件添加的块；下一步不能因为它和配置的纯正文不同就重复注入。
  assert.equal(nextInjection('<system-reminder>\n\n旧的注入\n\n</system-reminder>', '旧的注入'), undefined)
  assert.equal(
    nextInjection(`<system-reminder>\n\n${CLEARED_INJECTION}\n\n</system-reminder>`, ''),
    undefined,
  )
})

test('the clearing notice is delivered inside the same block', () => {
  const [block] = injectionMessage(CLEARED_INJECTION, PROMPT_NAMESPACE).content
  assert.equal(block.text, `<system-reminder>\n\n${CLEARED_INJECTION}\n\n</system-reminder>`)
})

test('recognizes its own rows both before and after the v3 to v4 source migration', () => {
  assert.equal(isInjectionSource({ kind: PROMPT_NAMESPACE }, PROMPT_NAMESPACE), true)
  // 旧日志的 `plugin` 包装经 v3→v4 迁移后变成这个带前缀的种类。
  assert.equal(isInjectionSource({ kind: `plugin:${PROMPT_NAMESPACE}` }, PROMPT_NAMESPACE), true)
})

test('leaves other producers and malformed sources alone', () => {
  assert.equal(isInjectionSource({ kind: 'plugin', plugin: PROMPT_NAMESPACE }, PROMPT_NAMESPACE), false)
  assert.equal(isInjectionSource({ kind: 'user' }, PROMPT_NAMESPACE), false)
  assert.equal(isInjectionSource({ kind: 'plugin:extra-subagent-routing' }, PROMPT_NAMESPACE), false)
  assert.equal(isInjectionSource(undefined, PROMPT_NAMESPACE), false)
  assert.equal(isInjectionSource(null, PROMPT_NAMESPACE), false)
  assert.equal(isInjectionSource('plugin', PROMPT_NAMESPACE), false)
})
