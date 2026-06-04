import { describe, expect, it } from 'vitest'
import { gemRepoUrl, githubOwnerRepo, npmRepoUrl, pypiRepoUrl } from './repo.js'

describe('githubOwnerRepo — owner/repo from any GitHub URL', () => {
  it('parses an https URL', () => {
    expect(githubOwnerRepo('https://github.com/psf/requests')).toEqual({
      owner: 'psf',
      repo: 'requests',
    })
  })

  it('strips a trailing .git, path, or fragment', () => {
    expect(githubOwnerRepo('git+https://github.com/lodash/lodash.git')).toEqual({
      owner: 'lodash',
      repo: 'lodash',
    })
    expect(githubOwnerRepo('https://github.com/rails/rails/tree/v7.0.4')).toEqual({
      owner: 'rails',
      repo: 'rails',
    })
  })

  it('returns undefined for a non-GitHub or missing URL', () => {
    expect(githubOwnerRepo('https://gitlab.com/foo/bar')).toBeUndefined()
    expect(githubOwnerRepo(undefined)).toBeUndefined()
  })
})

describe('npmRepoUrl — npm packument repository field', () => {
  it('reads a string or {url} object', () => {
    expect(npmRepoUrl({ name: 'x', versions: {}, repository: 'https://github.com/a/b' })).toBe(
      'https://github.com/a/b',
    )
    expect(
      npmRepoUrl({
        name: 'x',
        versions: {},
        repository: { url: 'git+https://github.com/a/b.git' },
      }),
    ).toBe('git+https://github.com/a/b.git')
    expect(npmRepoUrl({ name: 'x', versions: {} })).toBeUndefined()
  })
})

describe('pypiRepoUrl — derive a GitHub URL from PyPI info.project_urls', () => {
  it('prefers a Source/Repository link over Homepage', () => {
    const json = {
      info: {
        project_urls: {
          Homepage: 'https://requests.readthedocs.io',
          Source: 'https://github.com/psf/requests',
        },
      },
    }
    expect(pypiRepoUrl(json)).toBe('https://github.com/psf/requests')
  })

  it('falls back to any github.com value when no priority key matches', () => {
    const json = {
      info: { project_urls: { Homepage: 'https://github.com/owner/proj', Docs: 'https://x' } },
    }
    expect(pypiRepoUrl(json)).toBe('https://github.com/owner/proj')
  })

  it('returns undefined when no project_urls point to GitHub', () => {
    expect(
      pypiRepoUrl({ info: { project_urls: { Homepage: 'https://gitlab.com/a/b' } } }),
    ).toBeUndefined()
    expect(pypiRepoUrl({ info: {} })).toBeUndefined()
    expect(pypiRepoUrl({})).toBeUndefined()
  })
})

describe('gemRepoUrl — RubyGems metadata source_code_uri ?? homepage_uri', () => {
  it('prefers source_code_uri', () => {
    expect(
      gemRepoUrl({
        source_code_uri: 'https://github.com/rails/rails',
        homepage_uri: 'https://rubyonrails.org',
      }),
    ).toBe('https://github.com/rails/rails')
  })

  it('falls back to homepage_uri', () => {
    expect(gemRepoUrl({ homepage_uri: 'https://github.com/sinatra/sinatra' })).toBe(
      'https://github.com/sinatra/sinatra',
    )
  })

  it('returns undefined when neither is set', () => {
    expect(gemRepoUrl({})).toBeUndefined()
  })
})
