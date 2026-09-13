import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Bypass p-retry's real backoff; the fallback logic under test runs after the
// retry loop, so one attempt is enough and keeps the test fast.
vi.mock('p-retry', () => ({ default: (fn: () => Promise<unknown>) => fn() }))

import { buildSvg, getImage, parseEmbeddedAvatars } from './utils'
import { ContributorSimple } from './types'

const mockedFetch = vi.fn()

const alice: ContributorSimple = {
  login: 'alice',
  avatar_url: 'https://avatars.example/alice.png',
  html_url: 'https://github.com/alice',
}

const existingSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <a xlink:href="https://github.com/alice" target="_blank" id="alice">
    <image xlink:href="data:png;base64,UHJpb3I="/>
  </a>
</svg>`

beforeEach(() => {
  mockedFetch.mockReset()
  vi.stubGlobal('fetch', mockedFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('parseEmbeddedAvatars', () => {
  it('extracts embedded avatars keyed by login', () => {
    expect(parseEmbeddedAvatars(existingSvg).get('alice')).toBe('UHJpb3I=')
  })

  it('returns an empty map for an SVG without embedded avatars', () => {
    expect(parseEmbeddedAvatars('<svg></svg>').size).toBe(0)
  })
})

describe('getImage', () => {
  it('reuses the previous avatar when the image fetch fails', async () => {
    mockedFetch.mockRejectedValue(new Error('offline'))
    await expect(getImage(alice.avatar_url, 'UHJpb3I=')).resolves.toBe('UHJpb3I=')
  })

  it('rejects when the fetch fails and no fallback exists', async () => {
    mockedFetch.mockRejectedValue(new Error('offline'))
    await expect(getImage(alice.avatar_url)).rejects.toThrow('offline')
  })
})

describe('buildSvg avatar fallback', () => {
  it('keeps a known contributor image from the previous SVG when fetching fails', async () => {
    mockedFetch.mockRejectedValue(new Error('offline'))
    const svg = await buildSvg([alice], { existingSvg })
    expect(svg).toContain('data:png;base64,UHJpb3I=')
    expect(svg).toContain('id="alice"')
  })

  it('fails the render when an avatar cannot be fetched and has no fallback', async () => {
    mockedFetch.mockRejectedValue(new Error('offline'))
    await expect(buildSvg([alice])).rejects.toThrow('offline')
  })
})
