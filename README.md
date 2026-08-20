# Poi contributor data

This repo holds statistical data of all contributors to poi project and community.

## Repositories included

All repositories under poooi organization, plus:

| repo | comment |
|------|---------|
| magicae/poi-nwjs | Antecedent of poi, ~~Sacred Relic~~ |
| ruiii/plugin-Hairstrength | Plugin |
| dkwingsmt/plugin-wheres-my-fuel-gone | Plugin |
| ruiii/poi_theme_paper_dark | Theme |
| Artoria-0x04/poi-theme-lumendark | Theme |
| govizlora/theme-papercyan | Theme |
| Artoria-0x04/paperblack | Theme |
| kcwikizh/poi-plugin-subtitle | Plugin |
| kcwikizh/poi-statistics | Plugin |
| Javran/poi-plugin-mo2 | Plugin |

## Development

### Prerequisites

- **GitHub CLI (`gh`)** — authenticated (`gh auth login`). The build uses `gh auth token` to authenticate with the GitHub API via Octokit; no hardcoded token is needed.
- **Vite+ (`vp`)** — used for linting/formatting. The local `vite-plus` dependency is installed via yarn, so `yarn lint` / `yarn check` work out of the box (no global install required).

### Commands

| command | description |
|---------|-------------|
| `npm run build` | Fetch contributor data and generate `dist/contributors.json` + `dist/graph.svg`. Uses the checked-in archive in `cache/` when available. |
| `npm run lint` | Lint with Vite+'s Oxlint (`vp lint`). |
| `npm run check` | Format, lint and type-check in one pass (`vp check`). |
| `npm run deploy` | Publish `dist/` to GitHub Pages (`gh-pages`). |
| `npm test` | No tests currently. |

Contributor data is archived in `cache/` (version-controlled). If a repo is missing from the archive, the build falls back to fetching fresh data from the GitHub API.

## Questions

### Why this project is created
With poooi/poi#1542 we introduced a contributor graph on readme, but this graph is not complete since the contribution data only go from poooi/poi repo, and we are missing:
- contributors that do not directly send commit to the project
- contributors from other repo, e.g. plugins

### How are the contributors ordered
Season千 is the creator for poi project icon, and edwardaaaa contributed the vector art icons. Following are contributors for code, art works and themes, sorted by first commit day

### Is this data complete?
Please contact us if there're still efforts and contributions that have not been accounted in the data

### I find something wrong / I want to modify my data
Contributors always have right to customize name, avatar and homepage in this data, please tell us if you like to do so.

## Contact us
Feel free to contact us if you have any questions or suggestions.
