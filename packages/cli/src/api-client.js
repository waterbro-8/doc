const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024
const DOCUMENTS_PATH = '/api/v1/documents'
const ME_PATH = '/api/v1/me'

export function stripTerminalControlCharacters(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
}

export class ApiClientError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.code = options.code || 'api_request_failed'
    this.status = options.status
    this.requestId = options.requestId
  }
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (normalized === '::1' || normalized === '[::1]') return true
  if (!/^127(?:\.\d{1,3}){3}$/.test(normalized)) return false
  return normalized
    .split('.')
    .slice(1)
    .every((part) => Number(part) >= 0 && Number(part) <= 255)
}

export function normalizeApiBaseUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new ApiClientError('API URL must be an absolute HTTP or HTTPS URL', { code: 'invalid_api_url' })
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ApiClientError('API URL must use HTTP or HTTPS', { code: 'invalid_api_url' })
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ApiClientError('API URL must not include credentials, a query, or a fragment', {
      code: 'invalid_api_url',
    })
  }
  if (url.pathname !== '/') {
    throw new ApiClientError('API URL must be an origin without a path', {
      code: 'invalid_api_url',
    })
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new ApiClientError('Plain HTTP is only allowed for localhost or loopback API URLs', {
      code: 'insecure_api_url',
    })
  }
  return url.origin
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength
}

async function readResponseText(response, maximumBytes) {
  const contentLength = response.headers?.get?.('content-length')
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maximumBytes) {
    throw new ApiClientError(`API response exceeds ${maximumBytes} bytes`, { code: 'response_too_large' })
  }

  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let total = 0
    let content = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        try {
          await reader.cancel()
        } catch {}
        throw new ApiClientError(`API response exceeds ${maximumBytes} bytes`, { code: 'response_too_large' })
      }
      content += decoder.decode(value, { stream: true })
    }
    return content + decoder.decode()
  }

  const content = await response.text()
  if (byteLength(content) > maximumBytes) {
    throw new ApiClientError(`API response exceeds ${maximumBytes} bytes`, { code: 'response_too_large' })
  }
  return content
}

function parseResponseBody(content, response) {
  if (!content.trim()) {
    throw new ApiClientError(`API returned an empty response (${response.status})`, {
      code: 'invalid_api_response',
      status: response.status,
    })
  }
  try {
    const payload = JSON.parse(content)
    if (payload == null || Array.isArray(payload) || typeof payload !== 'object') {
      throw new Error('not an object')
    }
    return payload
  } catch {
    throw new ApiClientError(`API returned invalid JSON (${response.status})`, {
      code: 'invalid_api_response',
      status: response.status,
    })
  }
}

function redact(value, token) {
  if (typeof value !== 'string') return value
  const safeValue = stripTerminalControlCharacters(value)
  const safeToken = stripTerminalControlCharacters(token)
  return safeToken ? safeValue.split(safeToken).join('[redacted]') : safeValue
}

function responseError(response, payload, token) {
  const apiError = payload?.error
  const rawMessage =
    apiError && typeof apiError === 'object' && typeof apiError.message === 'string'
      ? apiError.message
      : `API request failed (${response.status})`
  const rawCode =
    apiError && typeof apiError === 'object' && typeof apiError.code === 'string' ? apiError.code : 'api_request_failed'
  return new ApiClientError(redact(rawMessage, token), {
    code: redact(rawCode, token),
    status: response.status,
    requestId: typeof payload.requestId === 'string' ? redact(payload.requestId, token) : undefined,
  })
}

function assertSuccessPayload(response, payload, token) {
  if (!response.ok) throw responseError(response, payload, token)
  if (!Object.prototype.hasOwnProperty.call(payload, 'data')) {
    throw new ApiClientError('API success response is missing data', {
      code: 'invalid_api_response',
      status: response.status,
    })
  }
  return payload
}

export function createApiClient({
  baseUrl,
  token,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}) {
  const origin = normalizeApiBaseUrl(baseUrl)

  async function request(path, options = {}) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (options.ifMatch) headers['if-match'] = options.ifMatch

    try {
      const response = await fetchImpl(new URL(path, origin), {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: 'error',
        signal: controller.signal,
      })
      const content = await readResponseText(response, maxResponseBytes)
      const payload = assertSuccessPayload(response, parseResponseBody(content, response), token)
      return {
        payload,
        etag: response.headers?.get?.('etag') || null,
      }
    } catch (error) {
      if (error instanceof ApiClientError) throw error
      const timedOut = controller.signal.aborted || error?.name === 'AbortError'
      throw new ApiClientError(timedOut ? 'API request timed out' : 'Unable to reach the doc API', {
        code: timedOut ? 'api_timeout' : 'api_unavailable',
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    me() {
      return request(ME_PATH)
    },
    async list(options = {}) {
      const query = new URLSearchParams()
      if (options.query) query.set('query', options.query)
      if (options.starred) query.set('starred', 'true')
      if (options.trash) query.set('trash', 'true')
      if (options.limit) query.set('limit', String(options.limit))
      if (options.cursor) query.set('cursor', options.cursor)
      const suffix = query.size > 0 ? `?${query}` : ''
      return request(`${DOCUMENTS_PATH}${suffix}`)
    },
    get(id) {
      return request(`${DOCUMENTS_PATH}/${encodeURIComponent(id)}`)
    },
    create(data) {
      return request(DOCUMENTS_PATH, { method: 'POST', body: data })
    },
    update(id, data, options = {}) {
      return request(`${DOCUMENTS_PATH}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: data,
        ifMatch: options.force ? '*' : options.ifMatch,
      })
    },
    listVersions(id, options = {}) {
      const query = new URLSearchParams()
      if (options.limit) query.set('limit', String(options.limit))
      if (options.cursor) query.set('cursor', options.cursor)
      const suffix = query.size > 0 ? `?${query}` : ''
      return request(`${DOCUMENTS_PATH}/${encodeURIComponent(id)}/versions${suffix}`)
    },
    getVersion(id, versionId) {
      return request(`${DOCUMENTS_PATH}/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`)
    },
    listComments(id, options = {}) {
      const query = new URLSearchParams()
      if (options.includeResolved) query.set('include', 'resolved')
      const suffix = query.size > 0 ? `?${query}` : ''
      return request(`${DOCUMENTS_PATH}/${encodeURIComponent(id)}/comments${suffix}`)
    },
    createComment(id, data) {
      return request(`${DOCUMENTS_PATH}/${encodeURIComponent(id)}/comments`, { method: 'POST', body: data })
    },
    exportBundle() {
      return request(`${DOCUMENTS_PATH}/export`)
    },
    importBundle(bundle) {
      return request(`${DOCUMENTS_PATH}/import`, { method: 'POST', body: bundle })
    },
  }
}
