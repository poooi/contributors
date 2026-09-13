// Daily Cron Trigger that authenticates as a GitHub App and dispatches the
// fixed poooi/contributors update workflow. No HTTP trigger is exposed.

export interface Env {
  GITHUB_APP_ID: string
  GITHUB_INSTALLATION_ID: string
  GITHUB_APP_PRIVATE_KEY: string
}

const OWNER = 'poooi'
const REPO = 'contributors'
const WORKFLOW_FILE = 'update-contributors.yml'
const REF = 'master'
const API_BASE = 'https://api.github.com'
const REQUEST_TIMEOUT_MS = 10_000
const JWT_CLOCK_SKEW_SECONDS = 60
const JWT_TTL_SECONDS = 9 * 60

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'contributors-scheduler',
}

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const encodeBase64UrlJson = (value: unknown): string =>
  toBase64Url(new TextEncoder().encode(JSON.stringify(value)))

// Decode a PKCS#8 PEM private key. Cloudflare secrets may arrive with escaped
// newlines, so both real newlines and literal "\n" are tolerated.
const decodePkcs8Pem = (pem: string): ArrayBuffer => {
  const base64 = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}

// Run a request under a real abort timeout. The label keeps timeout errors
// specific without echoing any request or response body.
const withTimeout = async <T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await run(controller.signal)
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

// Surface the status and GitHub request id, never the raw response body.
const assertOk = (response: Response, label: string): void => {
  if (response.ok) {
    return
  }
  const requestId = response.headers.get('x-github-request-id') ?? 'unknown'
  throw new Error(
    `${label} failed: ${response.status} ${response.statusText} (request id: ${requestId})`,
  )
}

// Mint a short-lived RS256 app JWT with native WebCrypto. No dependencies and
// no token cache; every scheduled run mints a fresh JWT.
export const createAppJwt = async (
  env: Env,
  now: number = Date.now(),
): Promise<string> => {
  const appId = env.GITHUB_APP_ID?.trim()
  if (!appId) {
    throw new Error('GITHUB_APP_ID is not configured')
  }
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY?.trim()
  if (!privateKeyPem) {
    throw new Error('GITHUB_APP_PRIVATE_KEY is not configured')
  }

  const key = await crypto.subtle.importKey(
    'pkcs8',
    decodePkcs8Pem(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const nowSeconds = Math.floor(now / 1000)
  const header = encodeBase64UrlJson({ alg: 'RS256', typ: 'JWT' })
  const payload = encodeBase64UrlJson({
    iat: nowSeconds - JWT_CLOCK_SKEW_SECONDS,
    exp: nowSeconds + JWT_TTL_SECONDS,
    iss: appId,
  })
  const signingInput = `${header}.${payload}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`
}

// Exchange the app JWT for an installation token restricted to this repo and
// the Actions:write permission.
export const requestInstallationToken = async (
  env: Env,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  now: number = Date.now(),
): Promise<string> => {
  const installationId = env.GITHUB_INSTALLATION_ID?.trim()
  if (!installationId) {
    throw new Error('GITHUB_INSTALLATION_ID is not configured')
  }

  const jwt = await createAppJwt(env, now)
  // The whole exchange, including reading and validating the response body,
  // runs under the abort timeout so a stalled body cannot outlive it.
  return await withTimeout(
    async signal => {
      const response = await fetchImpl(
        `${API_BASE}/app/installations/${installationId}/access_tokens`,
        {
          method: 'POST',
          headers: {
            ...GITHUB_HEADERS,
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            repositories: [REPO],
            permissions: { actions: 'write' },
          }),
          signal,
        },
      )
      assertOk(response, 'GitHub installation token request')

      let data: unknown
      try {
        data = await response.json()
      } catch (error) {
        // A body aborted by the timeout must stay a timeout error, not look
        // like a malformed payload.
        if (signal.aborted) {
          throw error
        }
        throw new Error('GitHub installation token response was not valid JSON')
      }
      const token = (data as { token?: unknown } | null)?.token
      if (typeof token !== 'string' || token.trim().length === 0) {
        throw new Error('GitHub installation token response did not include a token')
      }
      return token
    },
    timeoutMs,
    'GitHub installation token request',
  )
}

export const dispatchWorkflow = async (
  env: Env,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  now: number = Date.now(),
): Promise<void> => {
  const token = await requestInstallationToken(env, fetchImpl, timeoutMs, now)
  const response = await withTimeout(
    signal =>
      fetchImpl(
        `${API_BASE}/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
        {
          method: 'POST',
          headers: {
            ...GITHUB_HEADERS,
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ref: REF }),
          signal,
        },
      ),
    timeoutMs,
    'GitHub workflow dispatch',
  )
  assertOk(response, 'GitHub workflow dispatch')
}

export default {
  async scheduled(_event: unknown, env: Env, _ctx: unknown): Promise<void> {
    await dispatchWorkflow(env)
  },
  async fetch(): Promise<Response> {
    return new Response('Not Found', { status: 404 })
  },
}
