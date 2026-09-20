import { describe, expect, it } from 'vitest'
import { isExcludedContributor, isExcludedLogin } from './config'

describe('isExcludedContributor', () => {
  it('excludes GitHub Apps with type Bot (case-insensitive)', () => {
    expect(isExcludedContributor({ login: 'some-app', type: 'Bot' })).toBe(true)
    expect(isExcludedContributor({ login: 'some-app', type: 'bot' })).toBe(true)
  })

  it('excludes [bot]-suffixed logins regardless of type', () => {
    expect(isExcludedContributor({ login: 'github-actions[bot]', type: 'Bot' })).toBe(
      true,
    )
    expect(isExcludedContributor({ login: 'CustomTool[bot]', type: 'User' })).toBe(true)
  })

  it('excludes the curated ignore list and known user-account bots', () => {
    expect(isExcludedLogin('dependabot[bot]')).toBe(true)
    expect(isExcludedLogin('renovate[bot]')).toBe(true)
    expect(isExcludedLogin('codacy-badger')).toBe(true)
    expect(isExcludedLogin('chiba-bot')).toBe(true)
    expect(isExcludedLogin('Claude')).toBe(true)
  })

  it('retains ordinary humans, including names containing "bot"', () => {
    expect(isExcludedLogin('Javran')).toBe(false)
    expect(isExcludedLogin('robotman')).toBe(false)
    expect(isExcludedLogin('botanist')).toBe(false)
    expect(isExcludedLogin('abbot')).toBe(false)
    expect(isExcludedContributor(null)).toBe(false)
    expect(isExcludedContributor(undefined)).toBe(false)
  })
})
