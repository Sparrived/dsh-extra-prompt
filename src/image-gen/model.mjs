// Pure request and response rules shared by the image-gen Host plugin and its tests.
//
// Nothing here touches a DSH service: URL composition, endpoint selection,
// payload assembly, response parsing and byte sniffing are ordinary functions,
// and the two network helpers take the caller's `fetch`. That keeps the whole
// protocol — including the multipart edit request — exercisable against a local
// fake server without a running Host. `index.mjs` owns the parts that do need a
// context: settings, credential lookup, the filesystem and the attachment store.
//
// The API is the OpenAI images shape because it is what compatible gateways
// (GPUStack, vLLM, one-api, …) implement: `POST /images/generations` with a JSON
// body, `POST /images/edits` with multipart, and a `data[]` array answering with
// either base64 bytes or a URL per image.

/** Settings namespace, profile row id and plugin `name`, all the same identifier. */
export const IMAGE_GEN_NAMESPACE = 'extra-image-gen'

/** The model-facing tool name. DSH style keeps tool names snake_case. */
export const TOOL_NAME = 'image_gen'

/** Path appended to the configured base URL for each endpoint. */
const ENDPOINT_PATHS = {
  generate: '/images/generations',
  edit: '/images/edits',
}

/** Ceiling for one downloaded image, so a hostile or broken URL cannot exhaust memory. */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024

/** Ceiling for one API JSON answer: a 64MB image is ~86MB once base64-encoded. */
export const MAX_API_RESPONSE_BYTES = 128 * 1024 * 1024

/** Whether a value is a plain record, not an array or null. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Trimmed non-empty string, or undefined. */
function text(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Normalize a configured base URL.
 *
 * Accepts either a service root (`https://host/v1`), a directory ending in
 * `/images`, or a complete endpoint; `endpointURL` is what resolves the third
 * case. A trailing slash is dropped so joining never doubles it.
 *
 * @param value - the `baseURL` setting or tool default.
 * @returns the trimmed URL without trailing slashes, or undefined when blank.
 */
export function normalizeBaseURL(value) {
  const trimmed = text(value)
  if (trimmed === undefined) return undefined
  return trimmed.replace(/\/+$/u, '')
}

/**
 * Resolve the request URL for one endpoint.
 *
 * Three shapes are accepted for `baseURL`, because users paste all three from
 * provider docs: a service root, a root ending in `/images`, and a complete
 * `…/images/generations` or `…/images/edits` address. The complete form is
 * re-pointed at the requested endpoint instead of being appended to again, which
 * is what makes a copy-pasted endpoint usable for both modes.
 *
 * @param baseURL - configured base URL.
 * @param endpoint - `generate` or `edit`.
 * @returns the absolute request URL.
 */
export function endpointURL(baseURL, endpoint) {
  const base = normalizeBaseURL(baseURL)
  if (base === undefined) throw new Error(`${TOOL_NAME}: 接口地址（baseURL）未配置`)
  const mode = endpoint === 'edit' ? 'edit' : 'generate'
  const wanted = ENDPOINT_PATHS[mode]
  const complete = base.replace(/\/images\/(?:generations|edits)$/iu, wanted)
  if (complete !== base) return complete
  if (/\/images$/iu.test(base)) return `${base}${wanted.slice('/images'.length)}`
  return `${base}${wanted}`
}

/**
 * Normalize an endpoint name from settings or tool arguments.
 * @param value - candidate endpoint.
 * @returns `generate` or `edit`, or undefined when the value is neither.
 */
export function normalizeMode(value) {
  return value === 'generate' || value === 'edit' ? value : undefined
}

/**
 * Pick the endpoint for one call.
 *
 * An explicit `mode` always wins; otherwise reference images select the edit
 * endpoint, because a provider cannot apply edits without an input image; and a
 * call with no image falls back to the configured default. The auto-selection is
 * what lets the model pass an image without also having to know which endpoint
 * that implies.
 *
 * @param requested - the tool call's `mode` argument.
 * @param configured - the settings `endpoint` default.
 * @param imageCount - number of reference images supplied by the call.
 * @returns the endpoint for this call.
 */
export function resolveMode(requested, configured, imageCount) {
  const explicit = normalizeMode(requested)
  if (explicit !== undefined) return explicit
  if (imageCount > 0) return 'edit'
  return normalizeMode(configured) ?? 'generate'
}

/**
 * Normalize the `images` argument: non-empty strings, trimmed, de-duplicated in
 * order. Malformed entries are dropped rather than failing the whole call, so a
 * model repeating one path does not turn into a protocol error.
 * @param value - candidate `images` argument.
 * @returns the usable references.
 */
export function normalizeImageRefs(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const refs = []
  for (const candidate of value) {
    const ref = text(candidate)
    if (ref === undefined || seen.has(ref)) continue
    seen.add(ref)
    refs.push(ref)
  }
  return refs
}

/**
 * Build the JSON body (and the edit form's scalar fields) for one request.
 *
 * Blank `size`/`quality` are omitted instead of sent as empty strings: providers
 * differ on which optional fields they accept, and an empty string is not the
 * same request as "use the provider default". `n` is only sent when the caller
 * asked for more than the implicit one image.
 *
 * @param options - resolved model, prompt and optional request knobs.
 * @returns the fields shared by both endpoints.
 */
export function buildImagePayload(options = {}) {
  const model = text(options.model)
  const prompt = text(options.prompt)
  if (model === undefined) throw new Error(`${TOOL_NAME}: 生图模型未配置，请先在设置的「图片生成」里填写模型`)
  if (prompt === undefined) throw new Error(`${TOOL_NAME}: prompt 不能为空`)

  const payload = { model, prompt }
  const size = text(options.size)
  if (size !== undefined) payload.size = size
  const quality = text(options.quality)
  if (quality !== undefined) payload.quality = quality
  if (Number.isInteger(options.n) && options.n > 1) payload.n = options.n
  return payload
}

/**
 * Extract the image entries from a provider response.
 *
 * The OpenAI shape is `data: [{ b64_json | url, revised_prompt? }]`. A few
 * compatible gateways use `images` as the array name or `image` as the field, so
 * both spellings are accepted; anything else is ignored rather than guessed at.
 *
 * @param body - parsed JSON response.
 * @returns image entries in provider order, each with `b64` or `url`.
 */
export function parseImageResponse(body) {
  const data = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.images)
      ? body.images
      : []
  const entries = []
  for (const candidate of data) {
    if (!isRecord(candidate)) continue
    const revisedPrompt = text(candidate.revised_prompt) ?? text(candidate.revisedPrompt)
    const b64 = text(candidate.b64_json) ?? text(candidate.b64)
    if (b64 !== undefined) {
      entries.push({ b64, ...revisedPrompt === undefined ? {} : { revisedPrompt } })
      continue
    }
    const url = text(candidate.url)
    if (url !== undefined) {
      entries.push({ url, ...revisedPrompt === undefined ? {} : { revisedPrompt } })
      continue
    }
    const image = text(candidate.image)
    if (image !== undefined) {
      entries.push(/^https?:\/\//iu.test(image)
        ? { url: image, ...revisedPrompt === undefined ? {} : { revisedPrompt } }
        : { b64: image, ...revisedPrompt === undefined ? {} : { revisedPrompt } })
    }
  }
  return entries
}

/**
 * Render the provider's error envelope as one line fit for a tool failure.
 * @param body - parsed JSON error body, when there is one.
 * @param status - HTTP status code.
 * @returns the provider's message when it has one, otherwise the status.
 */
export function errorDetail(body, status) {
  const message = text(body?.error?.message)
    ?? text(body?.error)
    ?? text(body?.message)
    ?? text(body?.detail)
    ?? `HTTP ${status}`
  return message.length > 500 ? `${message.slice(0, 500)}…` : message
}

/**
 * Fetch one URL with a byte ceiling.
 * @param fetchImpl - the fetch implementation (the global one in production).
 * @param url - absolute image URL.
 * @param signal - cancellation signal for the whole tool call.
 * @param maxBytes - ceiling for the response body.
 * @returns the response bytes.
 */
export async function fetchImageBytes(fetchImpl, url, signal, maxBytes = MAX_DOWNLOAD_BYTES) {
  let response
  try {
    response = await fetchImpl(url, { signal })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error(`${TOOL_NAME}: 下载生成的图片失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`${TOOL_NAME}: 下载生成的图片失败：HTTP ${response.status}`)
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${TOOL_NAME}: 生成的图片超过 ${maxBytes} 字节上限`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) throw new Error(`${TOOL_NAME}: 生成的图片超过 ${maxBytes} 字节上限`)
  return bytes
}

/**
 * Decode a base64 image body, tolerating whitespace and a `data:` prefix.
 * @param value - provider base64 payload.
 * @returns the decoded bytes.
 */
export function decodeImageBase64(value) {
  const raw = text(value)
  if (raw === undefined) throw new Error(`${TOOL_NAME}: 接口返回了空的 base64 图片`)
  const comma = raw.startsWith('data:') ? raw.indexOf(',') : -1
  const body = comma === -1 ? raw : raw.slice(comma + 1)
  return Buffer.from(body.replace(/\s+/gu, ''), 'base64')
}

/**
 * Turn one parsed response entry into bytes.
 * @param options - fetch implementation, entry, signal and ceiling.
 * @returns the image bytes and the provider's revised prompt when present.
 */
export async function resolveImageEntry(options) {
  const { fetchImpl, entry, signal, maxBytes = MAX_DOWNLOAD_BYTES } = options
  if (typeof entry?.b64 === 'string') {
    const bytes = decodeImageBase64(entry.b64)
    if (bytes.byteLength > maxBytes) throw new Error(`${TOOL_NAME}: 生成的图片超过 ${maxBytes} 字节上限`)
    return { bytes, ...entry.revisedPrompt === undefined ? {} : { revisedPrompt: entry.revisedPrompt } }
  }
  if (typeof entry?.url === 'string') {
    const bytes = await fetchImageBytes(fetchImpl, entry.url, signal, maxBytes)
    return { bytes, ...entry.revisedPrompt === undefined ? {} : { revisedPrompt: entry.revisedPrompt } }
  }
  throw new Error(`${TOOL_NAME}: 接口返回的图片条目既没有 b64_json 也没有 url`)
}

/**
 * Call one images endpoint and parse its answer.
 *
 * `images` are already-loaded reference files (`{ bytes, name, mediaType }`):
 * reading a local path is the plugin's job, while the multipart encoding is the
 * protocol's, which keeps this function testable with a fake server.
 *
 * @param options - endpoint, credentials, request fields and reference files.
 * @returns the endpoint, model and parsed image entries.
 */
export async function requestImageAPI(options) {
  const {
    fetchImpl = fetch,
    baseURL,
    apiKey,
    model,
    mode,
    prompt,
    size,
    quality,
    n,
    images = [],
    mask,
    signal,
  } = options
  const endpoint = normalizeMode(mode) ?? 'generate'
  const payload = buildImagePayload({ model, prompt, size, quality, n })
  const url = endpointURL(baseURL, endpoint)
  const authorization = typeof apiKey === 'string' && apiKey !== '' ? { authorization: `Bearer ${apiKey}` } : {}

  let response
  try {
    if (endpoint === 'generate') {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...authorization },
        body: JSON.stringify(payload),
        signal,
      })
    } else {
      const form = new FormData()
      for (const [key, value] of Object.entries(payload)) form.append(key, String(value))
      for (const image of images) {
        form.append(
          'image',
          new Blob([image.bytes], { type: image.mediaType ?? 'application/octet-stream' }),
          image.name,
        )
      }
      if (mask !== undefined) {
        form.append(
          'mask',
          new Blob([mask.bytes], { type: mask.mediaType ?? 'application/octet-stream' }),
          mask.name,
        )
      }
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { accept: 'application/json', ...authorization },
        body: form,
        signal,
      })
    }
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error(`${TOOL_NAME}: 请求 ${url} 失败：${error instanceof Error ? error.message : String(error)}`)
  }

  if (!response.ok) {
    let body
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    throw new Error(`${TOOL_NAME}: ${endpoint} 端点返回 HTTP ${response.status}：${errorDetail(body, response.status)}`)
  }

  const declaredLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_API_RESPONSE_BYTES) {
    throw new Error(`${TOOL_NAME}: ${endpoint} 端点的应答超过 ${MAX_API_RESPONSE_BYTES} 字节上限`)
  }
  let body
  try {
    body = await response.json()
  } catch (error) {
    throw new Error(`${TOOL_NAME}: ${endpoint} 端点返回的不是 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const entries = parseImageResponse(body)
  if (entries.length === 0) {
    throw new Error(`${TOOL_NAME}: ${endpoint} 端点没有返回任何图片：${errorDetail(body, response.status)}`)
  }
  return { mode: endpoint, model: text(model), entries }
}

/**
 * Sniff the media type from the file's own magic bytes.
 *
 * The response's `content-type` and the URL extension are provider claims; the
 * attachment store checks the bytes anyway, so the bytes are what this tool
 * believes. Only the four formats DSH can admit are recognized.
 *
 * @param bytes - encoded image bytes.
 * @returns the media type, or undefined for an unsupported format.
 */
export function detectImageMediaType(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const ascii = (start, end) => String.fromCharCode(...data.subarray(start, end))
  if (data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
    return 'image/png'
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif'
  if (data.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

/**
 * Filename extension for one media type; unsupported formats keep a neutral one.
 * @param mediaType - sniffed media type, when there is one.
 * @returns the extension without a dot.
 */
export function extensionForMediaType(mediaType) {
  switch (mediaType) {
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'img'
  }
}

/**
 * Build a collision-resistant filename for one generated image.
 *
 * The stamp is UTC so a filename never jumps by an hour across a daylight-saving
 * change, and the random segment keeps two calls in the same second apart.
 *
 * @param date - clock value for the stamp.
 * @param random - short random hex segment.
 * @param index - zero-based image index within the call.
 * @param mediaType - sniffed media type.
 * @returns the filename, without a directory.
 */
export function imageFileName(date, random, index, mediaType) {
  const stamp = date.toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15)
  const suffix = String(index + 1).padStart(2, '0')
  return `image-${stamp}-${random}-${suffix}.${extensionForMediaType(mediaType)}`
}
