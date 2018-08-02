export interface IRepo {
  full_name: string
}
interface IPeople {
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
export interface IWeek {
  w: number
  a: number
  d: number
  c: number
}
export interface IStat {
  total: number
  weeks: IWeek[]
  author: IPeople
}

interface IContributor {
  login: string
  name: string
  id: number
  avatar_url: string
  html_url: string
  total: number
  stat: Pick<IWeek, 'a' | 'd' | 'c'>
  firstCommitTime: number
  perRepo: {
    [key: string]: number
  }
}
export interface IContributorCollection {
  [key: string]: IContributor
}

export type IContributorSimple = Pick<
  IContributor,
  'html_url' | 'avatar_url' | 'login'
>
export interface IContributorOverwrite {
  [key: string]: Partial<
    Pick<IContributor, 'html_url' | 'avatar_url' | 'login' | 'name'>
  >
}
export interface IAlias {
  [key: string]: string
}
