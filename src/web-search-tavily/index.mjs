// Host plugin: Tavily Search Provider for DeepSeek Harness (DSH).
//
// Registers a WebSearchProvider into `ctx.web` with id `tavily`.
// When `ctx.web` is configured with `searchProvider: tavily`,
// any `web_search` tool call routes to the Tavily API.

export const name = 'extra-web-search-tavily'
export const inject = ['web']

export function apply(ctx, config = {}) {
  async function resolveApiKey() {
    const directKey = config?.apiKey?.trim()
    if (directKey) return directKey

    const envName = config?.apiKeyEnv?.trim() || 'TAVILY_API_KEY'

    // 1. Try ctx.get('credentials')
    const credService = ctx.get('credentials')
    if (credService && typeof credService.resolve === 'function') {
      try {
        const res = await credService.resolve(envName)
        if (res?.value) return res.value
      } catch {}
      if (envName !== 'TAVILY_API_KEY') {
        try {
          const res = await credService.resolve('TAVILY_API_KEY')
          if (res?.value) return res.value
        } catch {}
      }
      try {
        const res = await credService.resolve('DEEPSEEK_API_KEY')
        if (res?.value && res.value.startsWith('tvly-')) return res.value
      } catch {}
    }

    // 2. Try process.env
    if (process.env[envName]) return process.env[envName]
    if (process.env.TAVILY_API_KEY) return process.env.TAVILY_API_KEY
    if (process.env.DEEPSEEK_API_KEY?.startsWith('tvly-')) return process.env.DEEPSEEK_API_KEY

    return undefined
  }

  const provider = {
    id: 'tavily',
    available() {
      return true
    },
    async search(request, signal) {
      const apiKey = await resolveApiKey()
      if (!apiKey) {
        throw new Error('Tavily API key not found. Please set TAVILY_API_KEY in credentials or environment.')
      }

      const rawBase = config?.baseURL || 'https://api.tavily.com'
      const baseClean = rawBase.replace(/\/+$/, '')
      const endpoint = baseClean.endsWith('/search') ? baseClean : `${baseClean}/search`

      const maxResults = request?.maxResults || config?.maxResults || 5
      const searchDepth = config?.searchDepth || 'basic'
      const includeAnswer = config?.includeAnswer ?? true

      const payload = {
        api_key: apiKey,
        query: request.query,
        max_results: maxResults,
        search_depth: searchDepth,
        include_answer: includeAnswer,
      }

      let response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'accept': 'application/json',
          },
          body: JSON.stringify(payload),
          signal,
        })
      } catch (err) {
        if (signal?.aborted) throw err
        throw new Error(`Tavily search network request failed: ${err.message}`)
      }

      if (!response.ok) {
        let errorDetail = `HTTP ${response.status}`
        try {
          const errData = await response.json()
          if (errData.detail) {
            errorDetail = typeof errData.detail === 'string' ? errData.detail : JSON.stringify(errData.detail)
          } else if (errData.message) {
            errorDetail = errData.message
          }
        } catch {}
        throw new Error(`Tavily search API error: ${errorDetail}`)
      }

      const data = await response.json()
      const rawResults = Array.isArray(data.results) ? data.results : []
      const sources = rawResults.map((r) => ({
        url: r.url,
        ...(r.title ? { title: r.title } : {}),
        ...(r.content ? { snippet: r.content } : {}),
        ...(r.published_date ? { publishedAt: r.published_date } : {}),
      }))

      return {
        ...(data.answer ? { content: data.answer } : {}),
        sources,
        truncated: false,
      }
    },
  }

  ctx.web.registerSearchProvider(provider)
}
