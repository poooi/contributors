import { Alias, ContributorOverwrite, ContributorSimple } from './types'

export const ORG_REPOS = 'https://api.github.com/orgs/poooi/repos?per_page=100'

export const MORE_REPO = [
  'magicae/poi-nwjs',
  'ruiii/plugin-Hairstrength',
  'dkwingsmt/plugin-wheres-my-fuel-gone',
  'ruiii/poi_theme_paper_dark',
  'Artoria-0x04/poi-theme-lumendark',
  'govizlora/theme-papercyan',
  'Artoria-0x04/paperblack',
  'kcwikizh/poi-plugin-subtitle',
  'kcwikizh/poi-statistics',
  'Javran/poi-plugin-mo2',
]

export const IGNORED_REPO = [
  'poooi/poidb-server', // no commits yet
  'poooi/node-coveralls', // this is a custom folk
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
}

export const IGNORES = ['codacy-badger']

export const OVERWRITES: ContributorOverwrite = {
  'Artoria-0x04': {
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
  magicae: {
    html_url: 'http://weibo.com/maginya',
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
}
