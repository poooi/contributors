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
  'html_url' | 'avatar_url' | 'login'
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
export interface ContributorOverwrite {
  [key: string]: Partial<
    Pick<Contributor, 'html_url' | 'avatar_url' | 'login' | 'name'>
  >
}
export interface Alias {
  [key: string]: string
}
