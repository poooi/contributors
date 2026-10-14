import {
  AccountAlias,
  Alias,
  ContributorOverride,
  ContributorOverwrite,
  ContributorOverwriteById,
  ContributorSimple,
} from './types'

export const ORG_REPOS = 'https://api.github.com/orgs/poooi/repos?per_page=100'

export const MORE_REPO = [
  'hanzhao/poi-nwjs',
  'ruiii/plugin-Hairstrength',
  'dkwingsmt/plugin-wheres-my-fuel-gone',
  'ruiii/poi_theme_paper_dark',
  'Artoria9/poi-theme-lumendark',
  'govizlora/theme-papercyan',
  'Artoria9/paperblack',
  'kcwikizh/poi-plugin-subtitle',
  'kcwikizh/poi-statistics',
  'Javran/poi-plugin-mo2',
]

export const IGNORED_REPO = [
  'poooi/node-coveralls', // this is a custom folk
  'poooi/website-kai2', // no commits yet
  'poooi/plugin-aircraft-optimize', // no actual commit
  'poooi/settings-panel', // commits not identifiable
]

export const MORE_PEOPLE: ContributorSimple[] = [
  {
    avatar_url:
      'https://raw.githubusercontent.com/poooi/contributors/master/assets/season.png',
    html_url: 'http://www.pixiv.net/member.php?id=3991162',
    login: 'Season千',
  },
  {
    avatar_url: 'https://avatars1.githubusercontent.com/u/11089376?v=4',
    html_url: 'https://github.com/edwardaaaa',
    login: 'edwardaaaa',
  },
]

// Login-based alias: retained only for legacy archive rows that carry no
// stable GitHub ID. Identified data uses ACCOUNT_ALIAS below instead, so a
// recycled login can never inherit a curated merge.
export const ALIAS: Alias = {
  dazzyd: 'yukixz',
  magicae: 'hanzhao',
}

// Deliberate cross-account merges pinned by stable numeric GitHub ID. These are
// intentional policy (two accounts, same person), not same-ID renames, and the
// target ID is explicit so it is never inferred from a fresh username lookup.
export const ACCOUNT_ALIAS: AccountAlias = {
  17616866: 3337921, // dazzyd -> yukixz
  155210104: 6753092, // magicae -> hanzhao
}

export const IGNORES = ['codacy-badger', 'dependabot-preview[bot]', 'renovate[bot]', 'dependabot[bot]']

// Bot accounts that report as ordinary users rather than `type: Bot`.
export const BOT_LOGINS = ['chiba-bot', 'claude']

const EXCLUDED_LOGINS = new Set(
  [...IGNORES, ...BOT_LOGINS].map(login => login.trim().toLowerCase()),
)

export interface ExcludableAuthor {
  login: string
  type?: string | null
}

// Shared, case-insensitive bot exclusion: GitHub `type: Bot`, `[bot]`-suffixed
// logins, and the curated IGNORES/BOT_LOGINS lists. Deliberately does not match
// arbitrary "bot" substrings, which appear in human names.
export const isExcludedContributor = (
  author: ExcludableAuthor | null | undefined,
): boolean => {
  if (!author || typeof author.login !== 'string') {
    return false
  }
  if (
    typeof author.type === 'string' &&
    author.type.trim().toLowerCase() === 'bot'
  ) {
    return true
  }
  const login = author.login.trim().toLowerCase()
  return login.endsWith('[bot]') || EXCLUDED_LOGINS.has(login)
}

// Login-only variant for stored people that no longer carry the GitHub type.
export const isExcludedLogin = (login: string): boolean =>
  isExcludedContributor({ login })


// Curated override bodies, defined once and referenced by both the ID-pinned
// and login-keyed maps so there is no duplicated configuration.
const artoria9: ContributorOverride = { html_url: 'http://www.weibo.com/pheliox' }
const chibaheit: ContributorOverride = { html_url: 'http://weibo.com/chibaheit' }
const javran: ContributorOverride = {
  avatar_url:
    'https://gist.githubusercontent.com/Javran/02ac7ebefc307829d02e5dc942f8ef28/raw/250x250.png',
}
const jenningswu: ContributorOverride = {
  html_url: 'http://www.weibo.com/jenningswu',
  name: '吴钩霜雪明',
}
const kochiyaocean: ContributorOverride = { html_url: 'http://www.kochiyaocean.org' }
const malichan: ContributorOverride = {
  html_url: 'http://www.weibo.com/1791427467',
  name: '马里酱',
}
const myzwillmake: ContributorOverride = { html_url: 'http://weibo.com/myzwillmake' }
const yukixz: ContributorOverride = { html_url: 'http://dazzyd.org/' }
const zyc434343: ContributorOverride = {
  html_url: 'http://weibo.com/zyc43',
  name: 'ZYC',
}
const hanzhao: ContributorOverride = { html_url: 'https://github.com/hanzhao' }

// Login-keyed overrides, applied only to legacy rows that carry no stable
// numeric ID. Identified contributors use OVERWRITES_BY_ID below.
export const OVERWRITES: ContributorOverwrite = {
  Artoria9: artoria9,
  Chibaheit: chibaheit,
  Javran: javran,
  JenningsWu: jenningswu,
  KochiyaOcean: kochiyaocean,
  malichan,
  myzWILLmake: myzwillmake,
  yukixz,
  zyc434343,
  hanzhao,
}

// Overrides pinned to stable numeric GitHub IDs, so a curated link/name/avatar
// follows a legitimate rename and a recycled login can never inherit it. The
// original id 1183568 account is now `Artoria9`; the login-keyed map above only
// covers no-ID legacy rows.
export const OVERWRITES_BY_ID: ContributorOverwriteById = {
  1183568: artoria9,
  6986642: chibaheit,
  1096354: javran,
  6861365: jenningswu,
  8194131: kochiyaocean,
  10855724: malichan,
  3362438: myzwillmake,
  3337921: yukixz,
  13725370: zyc434343,
  6753092: hanzhao,
}
