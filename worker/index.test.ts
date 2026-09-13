import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import handler, {
  createAppJwt,
  dispatchWorkflow,
  Env,
  requestInstallationToken,
} from './index'

const APP_ID = '12345'
const INSTALLATION_ID = '67890'

const tokenUrl = `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`
const dispatchUrl =
  'https://api.github.com/repos/poooi/contributors/actions/workflows/update-contributors.yml/dispatches'

let env: Env
let publicKey: CryptoKey

const toPem = (label: string, bytes: ArrayBuffer): string => {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)))
  const lines = base64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`
}

const fromBase64Url = (value: string) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded =
    normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

const jsonResponse = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

// Headers arrive immediately but the body never completes until the request is
// aborted, so only reading the body under the timeout can catch it.
const stalledBodyResponse = (signal: AbortSignal): Response => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener('abort', () => {
        controller.error(
          Object.assign(new Error('aborted'), { name: 'AbortError' }),
        )
      })
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const asFetch = (impl: unknown): typeof fetch => impl as typeof fetch

beforeAll(async () => {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  publicKey = keyPair.publicKey
  env = {
    GITHUB_APP_ID: APP_ID,
    GITHUB_INSTALLATION_ID: INSTALLATION_ID,
    GITHUB_APP_PRIVATE_KEY: toPem(
      'PRIVATE KEY',
      await crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
    ),
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createAppJwt', () => {
  it('mints a verifiable RS256 JWT with iat now-60s and exp now+9min', async () => {
    const now = Date.UTC(2026, 0, 2, 3, 4, 5)
    const jwt = await createAppJwt(env, now)
    const [header, payload, signature] = jwt.split('.')

    expect(
      JSON.parse(new TextDecoder().decode(fromBase64Url(header))),
    ).toEqual({ alg: 'RS256', typ: 'JWT' })
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)))
    expect(claims.iss).toBe(APP_ID)
    expect(claims.iat).toBe(Math.floor(now / 1000) - 60)
    expect(claims.exp).toBe(Math.floor(now / 1000) + 9 * 60)

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      fromBase64Url(signature),
      new TextEncoder().encode(`${header}.${payload}`),
    )
    expect(valid).toBe(true)
  })

  it('rejects a tampered signature', async () => {
    const jwt = await createAppJwt(env, 0)
    const [header, payload, signature] = jwt.split('.')
    const tampered = fromBase64Url(signature)
    tampered[0] ^= 0xff

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      tampered,
      new TextEncoder().encode(`${header}.${payload}`),
    )
    expect(valid).toBe(false)
  })
})

describe('requestInstallationToken', () => {
  it('POSTs a scoped token request with an app JWT bearer', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ token: 'installation-token' }),
    )
    const token = await requestInstallationToken(env, asFetch(fetchImpl), 1000, 0)

    expect(token).toBe('installation-token')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(tokenUrl)
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(
      JSON.stringify({
        repositories: ['contributors'],
        permissions: { actions: 'write' },
      }),
    )
    const headers = init?.headers as Record<string, string>
    expect(headers.Accept).toBe('application/vnd.github+json')
    expect(headers.Authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/)
  })

  it('rejects a non-JSON token response', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('not json', { status: 200 }),
    )
    await expect(
      requestInstallationToken(env, asFetch(fetchImpl), 1000, 0),
    ).rejects.toThrow('was not valid JSON')
  })

  it('rejects a token response without a token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ expires_at: 'later' }))
    await expect(
      requestInstallationToken(env, asFetch(fetchImpl), 1000, 0),
    ).rejects.toThrow('did not include a token')
  })

  it('reports status and request id without leaking secrets or the body', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('upstream body', {
          status: 403,
          statusText: 'Forbidden',
          headers: { 'x-github-request-id': 'req-123' },
        }),
    )
    let message = ''
    try {
      await requestInstallationToken(env, asFetch(fetchImpl), 1000, 0)
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain('403 Forbidden (request id: req-123)')
    expect(message).not.toContain('upstream body')
    expect(message).not.toContain(env.GITHUB_APP_PRIVATE_KEY)
  })

  it('aborts a hanging token request', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          )
        }),
    )
    await expect(
      requestInstallationToken(env, asFetch(fetchImpl), 10, 0),
    ).rejects.toThrow('token request timed out after 10ms')
  })

  it('requires app id, installation id and private key', async () => {
    await expect(
      requestInstallationToken({ ...env, GITHUB_APP_ID: '' }),
    ).rejects.toThrow('GITHUB_APP_ID is not configured')
    await expect(
      requestInstallationToken({ ...env, GITHUB_INSTALLATION_ID: '' }),
    ).rejects.toThrow('GITHUB_INSTALLATION_ID is not configured')
    await expect(
      requestInstallationToken({ ...env, GITHUB_APP_PRIVATE_KEY: '' }),
    ).rejects.toThrow('GITHUB_APP_PRIVATE_KEY is not configured')
  })
})

describe('dispatchWorkflow', () => {
  it('exchanges a token then dispatches with the installation token', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === tokenUrl) {
        return jsonResponse({ token: 'installation-token' })
      }
      return new Response(null, { status: 204 })
    })
    await dispatchWorkflow(env, asFetch(fetchImpl), 1000, 0)

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [url, init] = fetchImpl.mock.calls[1]
    expect(url).toBe(dispatchUrl)
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer installation-token',
    )
    expect(init?.body).toBe(JSON.stringify({ ref: 'master' }))
  })

  it('does not dispatch when the token request fails', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === tokenUrl) {
        return new Response('nope', {
          status: 403,
          statusText: 'Forbidden',
          headers: { 'x-github-request-id': 'req-1' },
        })
      }
      return new Response(null, { status: 204 })
    })
    await expect(
      dispatchWorkflow(env, asFetch(fetchImpl), 1000, 0),
    ).rejects.toThrow('403 Forbidden (request id: req-1)')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch when the token response is malformed', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === tokenUrl) {
        return jsonResponse({})
      }
      return new Response(null, { status: 204 })
    })
    await expect(
      dispatchWorkflow(env, asFetch(fetchImpl), 1000, 0),
    ).rejects.toThrow('did not include a token')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reports dispatch errors without leaking the token or body', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === tokenUrl) {
        return jsonResponse({ token: 'secret-install-token' })
      }
      return new Response('upstream body', {
        status: 500,
        statusText: 'Server Error',
        headers: { 'x-github-request-id': 'req-2' },
      })
    })
    let message = ''
    try {
      await dispatchWorkflow(env, asFetch(fetchImpl), 1000, 0)
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain('500 Server Error (request id: req-2)')
    expect(message).not.toContain('secret-install-token')
    expect(message).not.toContain('upstream body')
  })

  it('aborts a hanging dispatch request', async () => {
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      if (url === tokenUrl) {
        return Promise.resolve(jsonResponse({ token: 'installation-token' }))
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('aborted')),
        )
      })
    })
    await expect(
      dispatchWorkflow(env, asFetch(fetchImpl), 10, 0),
    ).rejects.toThrow('dispatch timed out after 10ms')
  })

  it('times out a stalled token body after headers and does not dispatch', async () => {
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      if (url === tokenUrl) {
        return Promise.resolve(stalledBodyResponse(init?.signal as AbortSignal))
      }
      return Promise.resolve(new Response(null, { status: 204 }))
    })
    await expect(
      dispatchWorkflow(env, asFetch(fetchImpl), 10, 0),
    ).rejects.toThrow('token request timed out after 10ms')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('worker entrypoint', () => {
  it('does not expose an HTTP trigger', async () => {
    const response = await handler.fetch()
    expect(response.status).toBe(404)
  })

  it('dispatches on the scheduled trigger', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === tokenUrl) {
        return jsonResponse({ token: 'installation-token' })
      }
      return new Response(null, { status: 204 })
    })
    const original = globalThis.fetch
    globalThis.fetch = asFetch(fetchImpl)
    try {
      await handler.scheduled({}, env, {})
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      expect(fetchImpl.mock.calls[1][0]).toBe(dispatchUrl)
    } finally {
      globalThis.fetch = original
    }
  })
})
