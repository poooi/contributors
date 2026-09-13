import fs from 'fs-extra'
import os from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  collectSupporters,
  fetchOpenCollectiveMembers,
  loadSupportersArchive,
  MalformedOpenCollectiveError,
  normalizeProfile,
  normalizeSupporters,
  saveSupportersArchive,
  Supporter,
} from './opencollective'

const jsonResponse = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const member = (overrides: Record<string, unknown> = {}) => ({
  MemberId: 1,
  name: 'Alice',
  profile: 'https://opencollective.com/alice',
  image: 'https://images.opencollective.com/alice/avatar.png',
  totalAmountDonated: 10,
  role: 'BACKER',
  ...overrides,
})

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'contributors-oc-'))
})

afterEach(async () => {
  await fs.remove(dir)
})

describe('normalizeProfile', () => {
  it('trims and strips trailing slashes, rejecting non-http(s) values', () => {
    expect(normalizeProfile('  https://opencollective.com/alice/  ')).toBe(
      'https://opencollective.com/alice',
    )
    expect(normalizeProfile('javascript:alert(1)')).toBeNull()
    expect(normalizeProfile('not a url')).toBeNull()
    expect(normalizeProfile('')).toBeNull()
    expect(normalizeProfile(undefined)).toBeNull()
  })
})

describe('normalizeSupporters', () => {
  it('keeps positive donors of every role, dedupes, and preserves order', () => {
    const supporters = normalizeSupporters([
      member({ MemberId: 1, profile: 'https://opencollective.com/a/' }),
      member({ MemberId: 1, profile: 'https://opencollective.com/a', totalAmountDonated: 0 }),
      member({
        MemberId: 2,
        profile: 'https://opencollective.com/b',
        name: 'Bob',
        role: 'ADMIN',
        totalAmountDonated: 5,
      }),
      member({
        MemberId: 2,
        profile: 'https://opencollective.com/b/',
        name: 'Bob',
        role: 'ADMIN',
        totalAmountDonated: 5,
      }),
      member({
        MemberId: 3,
        profile: null,
        name: '   ',
        image: null,
        totalAmountDonated: 1,
      }),
    ])

    expect(supporters.map(supporter => supporter.id)).toEqual([
      'oc:https://opencollective.com/a',
      'oc:https://opencollective.com/b',
      'oc:member:3',
    ])
    expect(supporters[2]).toMatchObject({
      memberId: 3,
      name: '',
      profile: null,
      image: null,
    })
  })

  it('uses the MemberId fallback when the profile is not an http(s) URL', () => {
    const supporters = normalizeSupporters([
      member({ MemberId: 9, profile: 'ftp://example.com/x', totalAmountDonated: 2 }),
    ])
    expect(supporters[0].id).toBe('oc:member:9')
    expect(supporters[0].profile).toBeNull()
  })

  it('rejects malformed members, amounts and MemberIds', () => {
    expect(() => normalizeSupporters([null])).toThrow(MalformedOpenCollectiveError)
    expect(() =>
      normalizeSupporters([member({ totalAmountDonated: '5' })]),
    ).toThrow(MalformedOpenCollectiveError)
    expect(() =>
      normalizeSupporters([member({ totalAmountDonated: Number.NaN })]),
    ).toThrow(MalformedOpenCollectiveError)
    expect(() =>
      normalizeSupporters([member({ totalAmountDonated: undefined })]),
    ).toThrow(MalformedOpenCollectiveError)
    expect(() =>
      normalizeSupporters([member({ MemberId: 'nope' })]),
    ).toThrow(MalformedOpenCollectiveError)
    expect(() =>
      normalizeSupporters([member({ MemberId: 1.5 })]),
    ).toThrow(MalformedOpenCollectiveError)
    expect(() =>
      normalizeSupporters([member({ MemberId: 0 })]),
    ).toThrow(MalformedOpenCollectiveError)
  })
})

describe('fetchOpenCollectiveMembers', () => {
  const pagedFetch = (pages: Array<Record<string, unknown>[]>) =>
    vi.fn(async (url: string) => {
      const parsed = new URL(url)
      const offset = Number(parsed.searchParams.get('offset'))
      const limit = Number(parsed.searchParams.get('limit'))
      const index = offset / limit
      return jsonResponse(pages[index] ?? [])
    })

  it('paginates until a short page and preserves source order', async () => {
    const fetchImpl = pagedFetch([
      [member({ MemberId: 1 }), member({ MemberId: 2 })],
      [member({ MemberId: 3 })],
    ])
    const members = await fetchOpenCollectiveMembers(
      fetchImpl as unknown as typeof fetch,
      { pageLimit: 2 },
    )
    expect(members.map((entry: any) => entry.MemberId)).toEqual([1, 2, 3])
    expect(Number(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('offset'))).toBe(0)
    expect(Number(new URL(fetchImpl.mock.calls[1][0]).searchParams.get('offset'))).toBe(2)
  })

  it('accepts a single full array page shorter than the limit', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([member()]))
    const members = await fetchOpenCollectiveMembers(
      fetchImpl as unknown as typeof fetch,
      { pageLimit: 1000 },
    )
    expect(members).toHaveLength(1)
  })

  it('rejects a non-array page', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ members: [member()] }))
    await expect(
      fetchOpenCollectiveMembers(fetchImpl as unknown as typeof fetch, { pageLimit: 2 }),
    ).rejects.toThrow(MalformedOpenCollectiveError)
  })

  it('rejects pagination that exhausts MAX_PAGES without a short page', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([member()]))
    await expect(
      fetchOpenCollectiveMembers(fetchImpl as unknown as typeof fetch, { pageLimit: 1 }),
    ).rejects.toThrow(/exceeded 100 pages/)
  })

  it('aborts a hanging request', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    await expect(
      fetchOpenCollectiveMembers(fetchImpl as unknown as typeof fetch, {
        pageLimit: 2,
        timeoutMs: 10,
      }),
    ).rejects.toThrow('timed out after 10ms')
  })
})

describe('collectSupporters archive behaviour', () => {
  const archivePath = () => join(dir, 'opencollective', 'supporters.json')

  it('retains the whole previous archive on a late-page failure', async () => {
    const previous: Supporter[] = [
      {
        id: 'oc:https://opencollective.com/old',
        memberId: 100,
        name: 'Old',
        profile: 'https://opencollective.com/old',
        image: null,
      },
    ]
    await saveSupportersArchive(previous, archivePath())

    const fetchImpl = vi.fn(async (url: string) => {
      const offset = Number(new URL(url).searchParams.get('offset'))
      if (offset === 0) {
        return jsonResponse([member({ MemberId: 1 }), member({ MemberId: 2 })])
      }
      throw { status: 500 }
    })

    const result = await collectSupporters({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      archivePath: archivePath(),
      pageLimit: 2,
    })
    expect(result.fromArchive).toBe(true)
    expect(result.supporters).toEqual(previous)
    expect(await loadSupportersArchive(archivePath())).toEqual(previous)
  })

  it('fails when the source fails and there is no previous archive', async () => {
    const fetchImpl = vi.fn(async () => {
      throw { status: 503 }
    })
    await expect(
      collectSupporters({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        archivePath: archivePath(),
        pageLimit: 2,
      }),
    ).rejects.toBeTruthy()
  })

  it('retains the previous archive when fresh data is empty', async () => {
    const previous: Supporter[] = [
      {
        id: 'oc:member:1',
        memberId: 1,
        name: '',
        profile: null,
        image: null,
      },
    ]
    await saveSupportersArchive(previous, archivePath())

    const fetchImpl = vi.fn(async () =>
      jsonResponse([member({ totalAmountDonated: 0 })]),
    )
    const result = await collectSupporters({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      archivePath: archivePath(),
    })
    expect(result.fromArchive).toBe(true)
    expect(result.supporters).toEqual(previous)
  })

  it('saves a fresh collection and skips unchanged writes', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([member()]))
    const first = await collectSupporters({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      archivePath: archivePath(),
    })
    expect(first.fromArchive).toBe(false)
    await saveSupportersArchive(first.supporters, archivePath())
    expect(await loadSupportersArchive(archivePath())).toEqual(first.supporters)
    await expect(saveSupportersArchive(first.supporters, archivePath())).resolves.toBe(
      false,
    )
  })

  it('rejects an archive containing any malformed entry', async () => {
    await fs.outputFile(
      archivePath(),
      JSON.stringify({
        supporters: [
          {
            id: 'oc:member:1',
            memberId: 1,
            name: '',
            profile: null,
            image: null,
          },
          { id: 'bad', memberId: 0, name: '', profile: null, image: null },
        ],
      }),
    )
    expect(await loadSupportersArchive(archivePath())).toBeNull()
  })
})
