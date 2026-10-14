export interface Repo {
  full_name: string
}
interface People {
  login: string
  id: number
  node_id: string
  avatar_url: string
  gravatar_id: string
  url: string
  html_url: string
  followers_url: string
  following_url: string
  gists_url: string
  starred_url: string
  subscriptions_url: string
  organizations_url: string
  repos_url: string
  events_url: string
  received_events_url: string
  type: string
  site_admin: false
  contributions: number
}
export interface Week {
  w: number
  a: number
  d: number
  c: number
}
export interface Stat {
  total: number
  weeks: Week[]
  author: People | null
}

export interface Contributor {
  login: string
  // GitHub returns `null` for an unset display name; keep the key so a null
  // from the API or a previous archive is preserved rather than stripped.
  name?: string | null
  id?: number | null
  avatar_url: string
  html_url: string
  total: number
  stat: Pick<Week, 'a' | 'd' | 'c'>
  firstCommitTime: number
  perRepo: {
    [key: string]: number
  }
}
export interface ContributorCollection {
  [key: string]: Contributor
}

export type ContributorSimple = Pick<
  Contributor,
  'html_url' | 'avatar_url' | 'login' | 'id'
>

// Fields used to render and aggregate a contributor. A profile may be partial
// (e.g. recovered from a previous build) so every field except login is
// optional.
export interface UserProfile {
  login: string
  name?: string | null
  id?: number | null
  avatar_url: string
  html_url: string
}
export type ContributorOverride = Partial<
  Pick<Contributor, 'html_url' | 'avatar_url' | 'login' | 'name'>
>
export interface ContributorOverwrite {
  [key: string]: ContributorOverride
}
// Overrides pinned to a stable numeric GitHub ID so a curated link/name/avatar
// follows a legitimate rename and can never be inherited by a recycled login.
export interface ContributorOverwriteById {
  [id: number]: ContributorOverride
}
export interface Alias {
  [key: string]: string
}

// Deliberate cross-account merges, pinned by stable numeric GitHub ID
// (sourceId -> targetId). Because the pair is explicit, a recycled login can
// never inherit the merge: only these exact IDs are joined.
export interface AccountAlias {
  [id: number]: number
}
