import pRetry from 'p-retry'
import fs from 'fs-extra'
import { dirname, join } from 'path'
import { writeIfChanged } from './atomic'

// Public, unauthenticated OpenCollective REST endpoint. Never the /v2 GraphQL
// API and never any GitHub credentials.
export const OC_COLLECTIVE = 'poi'
export const OC_MEMBERS_URL = `https://rest.opencollective.com/${OC_COLLECTIVE}/members/all.json`
export const OC_PAGE_LIMIT = 1000
export const SUPPORTERS_ARCHIVE_PATH = join(
  __dirname,
  'cache',
  'opencollective',
  'supporters.json',
)

const REQUEST_TIMEOUT_MS = 15_000
const REQUEST_RETRIES = 1
const MAX_PAGES = 100

// Only public display fields are ever persisted. Amount, email, role and the
// rest of the raw export are deliberately dropped.
export interface Supporter {
  id: string
  memberId: number
  name: string
  profile: string | null
  image: string | null
}

export class MalformedOpenCollectiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MalformedOpenCollectiveError'
  }
}

export interface SupporterCollection {
  supporters: Supporter[]
  // True when fresh collection failed and the previous archive was reused.
  fromArchive: boolean
}

const fetchPage = async (
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      const requestId =
        response.headers.get('x-request-id') ??
        response.headers.get('x-oc-request-id') ??
        'unknown'
      throw new Error(
        `OpenCollective request failed: ${response.status} ${response.statusText} (request id: ${requestId})`,
      )
    }
    return await response.json()
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`OpenCollective request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

const extractMembers = (payload: unknown): unknown[] => {
  if (!Array.isArray(payload)) {
    throw new MalformedOpenCollectiveError(
      'OpenCollective response is not a member array',
    )
  }
  return payload
}

// Page through the public members list until a page is shorter than the page
// limit. A malformed page or pagination that never terminates aborts the
// collection so a partial list can never replace a good archive.
export const fetchOpenCollectiveMembers = async (
  fetchImpl: typeof fetch = fetch,
  options: { pageLimit?: number; timeoutMs?: number } = {},
): Promise<unknown[]> => {
  const pageLimit = options.pageLimit ?? OC_PAGE_LIMIT
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const members: unknown[] = []
  let offset = 0
  let completed = false

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${OC_MEMBERS_URL}?limit=${pageLimit}&offset=${offset}`
    const payload = await pRetry(() => fetchPage(url, fetchImpl, timeoutMs), {
      retries: REQUEST_RETRIES,
      minTimeout: 0,
      maxTimeout: 0,
    })
    const pageMembers = extractMembers(payload)
    members.push(...pageMembers)
    if (pageMembers.length < pageLimit) {
      completed = true
      break
    }
    offset += pageMembers.length
  }

  if (!completed) {
    throw new MalformedOpenCollectiveError(
      `OpenCollective pagination exceeded ${MAX_PAGES} pages without a short page`,
    )
  }
  return members
}

export const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

// trim + strip trailing slashes; empty or non-http(s) becomes null.
export const normalizeProfile = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim().replace(/\/+$/, '')
  return trimmed.length > 0 && isHttpUrl(trimmed) ? trimmed : null
}

// Supporter names are blank rather than falling back to a login.
export const normalizeSupporterName = (value: unknown): string => {
  if (typeof value !== 'string') {
    return ''
  }
  return value.trim() === '' ? '' : value
}

// Keep positive donors of every role (including ADMIN), preserve source order,
// and dedupe on the normalized profile with MemberId as fallback key.
export const normalizeSupporters = (members: unknown[]): Supporter[] => {
  const seen = new Set<string>()
  const supporters: Supporter[] = []

  members.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new MalformedOpenCollectiveError(
        `OpenCollective member at index ${index} is not an object`,
      )
    }
    const member = raw as Record<string, unknown>
    const amount = member.totalAmountDonated
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new MalformedOpenCollectiveError(
        `OpenCollective member at index ${index} has a malformed donation amount`,
      )
    }
    if (!(amount > 0)) {
      return
    }
    const memberId = member.MemberId
    if (
      typeof memberId !== 'number' ||
      !Number.isInteger(memberId) ||
      memberId <= 0
    ) {
      throw new MalformedOpenCollectiveError(
        `OpenCollective member at index ${index} has no valid positive integer MemberId`,
      )
    }
    const profile = normalizeProfile(member.profile)
    const key = profile ?? `member:${memberId}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)

    const image =
      typeof member.image === 'string' && member.image.trim() !== ''
        ? member.image.trim()
        : null
    supporters.push({
      id: profile ? `oc:${profile}` : `oc:member:${memberId}`,
      memberId,
      name: normalizeSupporterName(member.name),
      profile,
      image,
    })
  })

  return supporters
}

const isSupporter = (value: unknown): value is Supporter => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const supporter = value as Record<string, unknown>
  return (
    typeof supporter.id === 'string' &&
    supporter.id.length > 0 &&
    typeof supporter.memberId === 'number' &&
    Number.isInteger(supporter.memberId) &&
    supporter.memberId > 0 &&
    typeof supporter.name === 'string' &&
    (supporter.profile === null || typeof supporter.profile === 'string') &&
    (supporter.image === null || typeof supporter.image === 'string')
  )
}

export const loadSupportersArchive = async (
  archivePath: string = SUPPORTERS_ARCHIVE_PATH,
): Promise<Supporter[] | null> => {
  try {
    if (!(await fs.pathExists(archivePath))) {
      return null
    }
    const parsed = await fs.readJson(archivePath)
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as { supporters?: unknown } | null)?.supporters
    if (!Array.isArray(list)) {
      return null
    }
    // Any malformed entry invalidates the whole archive; never keep a partial.
    return list.every(isSupporter) ? (list as Supporter[]) : null
  } catch (error) {
    console.warn('Failed to load OpenCollective supporters archive:', error)
    return null
  }
}

export const saveSupportersArchive = async (
  supporters: Supporter[],
  archivePath: string = SUPPORTERS_ARCHIVE_PATH,
): Promise<boolean> => {
  await fs.ensureDir(dirname(archivePath))
  return writeIfChanged(
    archivePath,
    `${JSON.stringify({ supporters }, null, 2)}\n`,
  )
}

// Collect fresh supporters, falling back to the previous archive when the
// source fails or comes back empty. Throws when there is nothing to fall back
// to, so a first run never publishes a false empty donor list.
export const collectSupporters = async (
  options: {
    fetchImpl?: typeof fetch
    archivePath?: string
    pageLimit?: number
    timeoutMs?: number
  } = {},
): Promise<SupporterCollection> => {
  const archivePath = options.archivePath ?? SUPPORTERS_ARCHIVE_PATH
  try {
    const members = await fetchOpenCollectiveMembers(options.fetchImpl, {
      pageLimit: options.pageLimit,
      timeoutMs: options.timeoutMs,
    })
    const supporters = normalizeSupporters(members)
    if (supporters.length > 0) {
      return { supporters, fromArchive: false }
    }
    const previous = await loadSupportersArchive(archivePath)
    if (previous && previous.length > 0) {
      console.warn(
        '⚠️  OpenCollective returned no positive donors; keeping previous archive',
      )
      return { supporters: previous, fromArchive: true }
    }
    throw new MalformedOpenCollectiveError(
      'OpenCollective returned no positive donors',
    )
  } catch (error) {
    const previous = await loadSupportersArchive(archivePath)
    if (previous && previous.length > 0) {
      console.warn(
        `⚠️  OpenCollective collection failed; keeping previous archive: ${String(
          error,
        )}`,
      )
      return { supporters: previous, fromArchive: true }
    }
    throw error
  }
}
