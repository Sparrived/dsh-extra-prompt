// Protocol tests for the image_gen tool.
//
// These exercise the real request construction and response parsing against a
// scripted `fetch`: the generate body, the multipart edit form, provider error
// envelopes, base64 and URL answers, and the byte sniffing every saved file
// goes through. The DSH wiring (settings, filesystem, attachments) lives in
// `src/image-gen/index.mjs` and is covered by the tool-level QA run, not here.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildImagePayload,
  decodeImageBase64,
  detectImageMediaType,
  endpointURL,
  errorDetail,
  extensionForMediaType,
  imageFileName,
  normalizeImageRefs,
  parseImageResponse,
  requestImageAPI,
  resolveImageEntry,
  resolveMode,
} from '../src/image-gen/model.mjs'

/** A real 1x1 transparent PNG, so the magic-byte check sees a real file header. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** A fetch double that records each call and answers from a script. */
function scriptedFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init, calls.length - 1)
  }
  return { calls, fetchImpl }
}

/** One JSON response. */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { return body },
    async arrayBuffer() { return new ArrayBuffer(0) },
  }
}

test('endpointURL accepts a service root, an /images root and a complete endpoint', () => {
  assert.equal(endpointURL('https://api.example.com/v1', 'generate'), 'https://api.example.com/v1/images/generations')
  assert.equal(endpointURL('https://api.example.com/v1/', 'edit'), 'https://api.example.com/v1/images/edits')
  assert.equal(endpointURL('https://api.example.com/v1/images', 'edit'), 'https://api.example.com/v1/images/edits')
  assert.equal(
    endpointURL('https://api.example.com/v1/images/generations', 'edit'),
    'https://api.example.com/v1/images/edits',
  )
  assert.equal(
    endpointURL('https://api.example.com/v1/images/edits', 'generate'),
    'https://api.example.com/v1/images/generations',
  )
  assert.throws(() => endpointURL('   ', 'generate'), /baseURL/u)
})

test('resolveMode prefers an explicit mode, then reference images, then the setting', () => {
  assert.equal(resolveMode('edit', 'generate', 0), 'edit')
  assert.equal(resolveMode('generate', 'edit', 2), 'generate')
  assert.equal(resolveMode(undefined, 'generate', 1), 'edit')
  assert.equal(resolveMode(undefined, 'edit', 0), 'edit')
  assert.equal(resolveMode(undefined, 'generate', 0), 'generate')
  // A stale or malformed value never becomes an endpoint.
  assert.equal(resolveMode('images', 'generate', 0), 'generate')
})

test('normalizeImageRefs trims, drops blanks and de-duplicates', () => {
  assert.deepEqual(normalizeImageRefs([' a.png ', '', 3, 'a.png', 'b.png']), ['a.png', 'b.png'])
  assert.deepEqual(normalizeImageRefs(undefined), [])
  assert.deepEqual(normalizeImageRefs('a.png'), [])
})

test('buildImagePayload omits blank optional fields and a single image count', () => {
  assert.deepEqual(
    buildImagePayload({ model: ' gpt-image-1 ', prompt: ' a cat ', size: '  ', quality: '', n: 1 }),
    { model: 'gpt-image-1', prompt: 'a cat' },
  )
  assert.deepEqual(
    buildImagePayload({ model: 'm', prompt: 'p', size: '1024x1024', quality: 'high', n: 3 }),
    { model: 'm', prompt: 'p', size: '1024x1024', quality: 'high', n: 3 },
  )
  assert.throws(() => buildImagePayload({ model: ' ', prompt: 'p' }), /模型未配置/u)
  assert.throws(() => buildImagePayload({ model: 'm', prompt: '  ' }), /prompt 不能为空/u)
})

test('parseImageResponse accepts the documented and the gateway spellings', () => {
  const entries = parseImageResponse({
    data: [
      { b64_json: 'AAAA', revised_prompt: 'a redraw' },
      { url: 'https://cdn.example.com/1.png' },
      { image: 'https://cdn.example.com/2.png' },
      { image: 'BBBB' },
      { nothing: true },
      null,
    ],
  })
  assert.deepEqual(entries, [
    { b64: 'AAAA', revisedPrompt: 'a redraw' },
    { url: 'https://cdn.example.com/1.png' },
    { url: 'https://cdn.example.com/2.png' },
    { b64: 'BBBB' },
  ])
  // A gateway that names the array `images` is still understood.
  assert.deepEqual(parseImageResponse({ images: [{ b64_json: 'CCCC' }] }), [{ b64: 'CCCC' }])
  assert.deepEqual(parseImageResponse({}), [])
})

test('errorDetail reads the provider message, then the status', () => {
  assert.equal(errorDetail({ error: { message: 'bad size' } }, 400), 'bad size')
  assert.equal(errorDetail({ error: 'quota' }, 429), 'quota')
  assert.equal(errorDetail({ detail: 'no auth' }, 401), 'no auth')
  assert.equal(errorDetail(undefined, 502), 'HTTP 502')
  assert.equal(errorDetail({ message: 'x'.repeat(600) }, 500).length, 501)
})

test('detectImageMediaType reads magic bytes, not the name', () => {
  assert.equal(detectImageMediaType(PNG), 'image/png')
  assert.equal(detectImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(detectImageMediaType(Buffer.from('GIF89a')), 'image/gif')
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])
  assert.equal(detectImageMediaType(webp), 'image/webp')
  assert.equal(detectImageMediaType(Buffer.from('not an image')), undefined)
  assert.equal(extensionForMediaType('image/jpeg'), 'jpg')
  assert.equal(extensionForMediaType(undefined), 'img')
})

test('imageFileName is UTC-stamped and collision-resistant', () => {
  const name = imageFileName(new Date('2026-10-30T01:02:03.000Z'), 'a1b2c3', 0, 'image/png')
  assert.equal(name, 'image-20261030-010203-a1b2c3-01.png')
  assert.equal(imageFileName(new Date('2026-10-30T01:02:03.000Z'), 'ff', 9, undefined), 'image-20261030-010203-ff-10.img')
})

test('decodeImageBase64 tolerates whitespace and a data: prefix', () => {
  const encoded = PNG.toString('base64')
  assert.deepEqual(decodeImageBase64(encoded), PNG)
  assert.deepEqual(decodeImageBase64(`data:image/png;base64,${encoded.slice(0, 20)}\n${encoded.slice(20)}`), PNG)
})

test('requestImageAPI posts the generate body and returns parsed entries', async () => {
  const { calls, fetchImpl } = scriptedFetch(() => jsonResponse({ data: [{ b64_json: PNG.toString('base64') }] }))
  const result = await requestImageAPI({
    fetchImpl,
    baseURL: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-image-1',
    mode: 'generate',
    prompt: 'a red fox',
    size: '1024x1024',
    quality: '',
    n: 2,
    signal: new AbortController().signal,
  })

  assert.equal(result.mode, 'generate')
  assert.equal(result.model, 'gpt-image-1')
  assert.deepEqual(result.entries, [{ b64: PNG.toString('base64') }])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.example.com/v1/images/generations')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'gpt-image-1',
    prompt: 'a red fox',
    size: '1024x1024',
    n: 2,
  })
})

test('requestImageAPI sends the edit as multipart with every reference image', async () => {
  const { calls, fetchImpl } = scriptedFetch(() => jsonResponse({ data: [{ url: 'https://cdn.example.com/out.png' }] }))
  const result = await requestImageAPI({
    fetchImpl,
    baseURL: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-image-1',
    mode: 'edit',
    prompt: 'make it blue',
    images: [
      { bytes: PNG, name: 'one.png', mediaType: 'image/png' },
      { bytes: PNG, name: 'two.png', mediaType: 'image/png' },
    ],
    mask: { bytes: PNG, name: 'mask.png', mediaType: 'image/png' },
    signal: new AbortController().signal,
  })

  assert.equal(result.mode, 'edit')
  assert.deepEqual(result.entries, [{ url: 'https://cdn.example.com/out.png' }])
  const body = calls[0].init.body
  assert.ok(body instanceof FormData)
  // fetch sets the multipart boundary itself; a manual content-type would drop it.
  assert.equal(calls[0].init.headers['content-type'], undefined)
  assert.equal(body.get('model'), 'gpt-image-1')
  assert.equal(body.get('prompt'), 'make it blue')
  assert.equal(body.getAll('image').length, 2)
  assert.equal(body.get('mask').name, 'mask.png')
})

test('requestImageAPI surfaces the provider error instead of a bare status', async () => {
  const { fetchImpl } = scriptedFetch(() => jsonResponse({ error: { message: 'size is not supported' } }, 400))
  await assert.rejects(
    requestImageAPI({ fetchImpl, baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm', mode: 'generate', prompt: 'p' }),
    /HTTP 400：size is not supported/u,
  )
})

test('requestImageAPI refuses an answer with no images', async () => {
  const { fetchImpl } = scriptedFetch(() => jsonResponse({ data: [] }))
  await assert.rejects(
    requestImageAPI({ fetchImpl, baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm', mode: 'generate', prompt: 'p' }),
    /没有返回任何图片/u,
  )
})

test('resolveImageEntry downloads a URL answer with a byte ceiling', async () => {
  const { calls, fetchImpl } = scriptedFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (name === 'content-length' ? String(PNG.byteLength) : null) },
    async json() { return {} },
    async arrayBuffer() { return PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) },
  }))
  const resolved = await resolveImageEntry({
    fetchImpl,
    entry: { url: 'https://cdn.example.com/a.png', revisedPrompt: 'redrawn' },
    signal: new AbortController().signal,
  })
  assert.equal(calls[0].url, 'https://cdn.example.com/a.png')
  assert.deepEqual(Buffer.from(resolved.bytes), PNG)
  assert.equal(resolved.revisedPrompt, 'redrawn')
  await assert.rejects(
    resolveImageEntry({ fetchImpl, entry: { url: 'https://cdn.example.com/a.png' }, signal: new AbortController().signal, maxBytes: 4 }),
    /上限/u,
  )
  // The base64 path has the same ceiling as the download path.
  await assert.rejects(
    resolveImageEntry({ fetchImpl, entry: { b64: PNG.toString('base64') }, signal: new AbortController().signal, maxBytes: 4 }),
    /上限/u,
  )
})
