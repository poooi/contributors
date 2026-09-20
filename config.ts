import { Alias, ContributorOverwrite, ContributorSimple } from './types'

export const ORG_REPOS = 'https://api.github.com/orgs/poooi/repos?per_page=100'

export const MORE_REPO = [
  'hanzhao/poi-nwjs',
  'ruiii/plugin-Hairstrength',
  'dkwingsmt/plugin-wheres-my-fuel-gone',
  'ruiii/poi_theme_paper_dark',
  'Astra-RX/poi-theme-lumendark',
  'govizlora/theme-papercyan',
  'Astra-RX/paperblack',
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

export const ALIAS: Alias = {
  dazzyd: 'yukixz',
  magicae: 'hanzhao',
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


export const OVERWRITES: ContributorOverwrite = {
  'Astra-RX': {
    html_url: 'http://www.weibo.com/pheliox',
  },
  Chibaheit: {
    html_url: 'http://weibo.com/chibaheit',
  },
  Javran: {
    avatar_url:
      'https://gist.githubusercontent.com/Javran/02ac7ebefc307829d02e5dc942f8ef28/raw/250x250.png',
  },
  JenningsWu: {
    html_url: 'http://www.weibo.com/jenningswu',
    name: '吴钩霜雪明',
  },
  KochiyaOcean: {
    html_url: 'http://www.kochiyaocean.org',
  },
  malichan: {
    html_url: 'http://www.weibo.com/1791427467',
    name: '马里酱',
  },
  myzWILLmake: {
    html_url: 'http://weibo.com/myzwillmake',
  },
  yukixz: {
    html_url: 'http://dazzyd.org/',
  },
  zyc434343: {
    html_url: 'http://weibo.com/zyc43',
    name: 'ZYC',
  },
  hanzhao: {
    html_url: 'https://github.com/hanzhao',
  }
}
