/**
 * Source-repository derivation — the pure half of `changelog_diff`'s "where is the CHANGELOG?"
 * step, shared by the MCP deps server bin AND the `strummer deps` CLI (one source of truth, like
 * {@link ./ecosystem.js}). Each ecosystem advertises its source repo differently:
 *   - **npm**: the packument `repository` field (a string or `{ url }`).
 *   - **PyPI**: `info.project_urls` — a free-form label→URL map (`Source`/`Repository`/`Homepage`…).
 *   - **RubyGems**: the gem's `source_code_uri` (preferred) or `homepage_uri`.
 *
 * These helpers extract a candidate URL from each metadata shape; {@link githubOwnerRepo} reduces
 * any GitHub URL to `{owner, repo}`. The actual HTTP fetch (SSRF-pinned, operator-gated) of both
 * the metadata and the raw CHANGELOG stays at the surface layer — this module is pure so the gate
 * stays deterministic. Non-GitHub forges (GitLab/Bitbucket) are out of scope (the raw fetch
 * targets `raw.githubusercontent.com`), so they resolve to `undefined` and the fetcher fails loud.
 */

import type { Packument } from './deprecation.js'
import type { PyPiJson } from './pypi.js'

/** CHANGELOG filenames seen in the wild, in priority order; the first 200 wins. */
export const CHANGELOG_FILENAMES = [
  'CHANGELOG.md',
  'CHANGELOG.markdown',
  'CHANGELOG',
  'changelog.md',
  'History.md',
  'HISTORY.md',
] as const

/** Reduce any GitHub URL (https/ssh, with or without `.git`/path/fragment) to `{owner, repo}`. */
export function githubOwnerRepo(
  url: string | undefined,
): { owner: string; repo: string } | undefined {
  const m = url?.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?(?:[/#].*)?$/i)
  return m ? { owner: m[1] as string, repo: m[2] as string } : undefined
}

/** The repository URL from an npm packument `repository` field (string or `{ url }`). */
export function npmRepoUrl(packument: Packument): string | undefined {
  const repo = (packument as { repository?: unknown }).repository
  return typeof repo === 'string' ? repo : (repo as { url?: string } | undefined)?.url
}

/** Project-URL labels (lowercased) that conventionally name the source repository, preferred first. */
const PYPI_SOURCE_LABELS = ['source', 'source code', 'repository', 'code', 'github', 'homepage']

/**
 * A GitHub URL from a PyPI project's `info.project_urls`. Prefers a source/repository-labelled
 * entry that points to GitHub; otherwise the first GitHub URL among any value.
 */
export function pypiRepoUrl(json: PyPiJson): string | undefined {
  const urls = json.info?.project_urls
  if (!urls) return undefined
  const entries = Object.entries(urls)
  for (const label of PYPI_SOURCE_LABELS) {
    const hit = entries.find(([k, v]) => k.toLowerCase() === label && /github\.com/i.test(v))
    if (hit) return hit[1]
  }
  return entries.find(([, v]) => /github\.com/i.test(v))?.[1]
}

/** The subset of the RubyGems gem JSON (`/api/v1/gems/<name>.json`) used to find the repo. */
export interface RubyGemMetadata {
  source_code_uri?: string
  homepage_uri?: string
}

/** The source-repository URL for a gem: `source_code_uri` preferred, else `homepage_uri`. */
export function gemRepoUrl(meta: RubyGemMetadata): string | undefined {
  return meta.source_code_uri ?? meta.homepage_uri
}
