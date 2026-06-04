import { parseArgs } from 'node:util'
import { detectInstalledVersion, type Ecosystem } from '@strummer/core'
import {
  auditDependency,
  CHANGELOG_FILENAMES,
  comparatorFor,
  type DependencyAudit,
  dependencyNames,
  gemRepoUrl,
  githubOwnerRepo,
  loadOsvSnapshot,
  matchName,
  normalizePypiName,
  npmRepoUrl,
  type OsvAdvisory,
  type OsvEcosystem,
  type Packument,
  type PyPiJson,
  pypiJsonToPackument,
  pypiRepoUrl,
  type RubyGemMetadata,
  type RubyGemsVersion,
  rubygemsToPackument,
  sliceChangelog,
} from '@strummer/deps'
import { resolveAndPin } from '@strummer/safety'
import type { CliIO } from './index.js'

/** Injected (so tests stay offline) registry-metadata fetcher; the real one is SSRF-pinned. */
export type PackumentFetcher = (packageName: string, ecosystem: OsvEcosystem) => Promise<Packument>
/** Injected CHANGELOG fetcher (npm only); the real one is SSRF-pinned to raw.githubusercontent. */
type ChangelogFetcher = (
  packageName: string,
  ecosystem: OsvEcosystem,
) => Promise<{ text: string; source: string }>

/** Map an OSV ecosystem to the `@strummer/core` installed-version detection ecosystem. */
const DETECT_ECOSYSTEM: Record<OsvEcosystem, Ecosystem> = {
  npm: 'node',
  PyPI: 'python',
  RubyGems: 'ruby',
}

/**
 * `strummer deps` — the human surface over `@strummer/deps`. Answers deprecation /
 * vulnerability / freshness for the version ACTUALLY INSTALLED in a project (not "latest").
 *
 * The human invoked the audit, so the CLI fetches by default (operator intent), with the
 * same SSRF pre-flight the bins use (`resolveAndPin`: metadata/link-local always refused,
 * private registries gated by `--allow-private`). Network + comparator dispatch reuse the
 * ecosystem helpers lifted into `@strummer/deps`. `audit`/`audit-project` exit 1 on a
 * security or deprecation finding (CI-actionable); `changelog` is informational.
 */
export async function runDeps(
  args: string[],
  io: CliIO,
  deps: { fetchPackument?: PackumentFetcher; fetchChangelog?: ChangelogFetcher } = {},
): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'audit':
      return cmdAudit(rest, io, deps)
    case 'audit-project':
      return cmdAuditProject(rest, io, deps)
    case 'changelog':
      return cmdChangelog(rest, io, deps)
    default:
      io.err(`unknown deps subcommand: ${sub ?? '(none)'}\n`)
      return 1
  }
}

/** Operator registry/SSRF flags shared by every deps command. */
const REGISTRY_OPTIONS = {
  ecosystem: { type: 'string' },
  'osv-db': { type: 'string' },
  registry: { type: 'string' },
  'pypi-registry': { type: 'string' },
  'rubygems-registry': { type: 'string' },
  'allow-private': { type: 'boolean' },
  json: { type: 'boolean' },
} as const

interface Registries {
  registry: string
  pypiRegistry: string
  rubygemsRegistry: string
  allowPrivate: boolean
}

export function registriesFrom(values: Record<string, unknown>): Registries {
  return {
    registry: (values.registry as string) || 'https://registry.npmjs.org',
    pypiRegistry: (values['pypi-registry'] as string) || 'https://pypi.org/pypi',
    rubygemsRegistry: (values['rubygems-registry'] as string) || 'https://rubygems.org/api/v1',
    allowPrivate: (values['allow-private'] as boolean) ?? false,
  }
}

function ecosystemFrom(values: Record<string, unknown>, io: CliIO): OsvEcosystem | null {
  const e = (values.ecosystem as string) ?? 'npm'
  if (e !== 'npm' && e !== 'PyPI' && e !== 'RubyGems') {
    io.err(`unknown ecosystem: ${e} (expected npm|PyPI|RubyGems)\n`)
    return null
  }
  return e
}

/** npm packument path: keep a scope's `@` but escape the `/` (registry idiom). */
function packumentUrl(registry: string, packageName: string): string {
  return `${registry.replace(/\/+$/, '')}/${packageName.replace('/', '%2f')}`
}

/** Build the SSRF-pinned packument fetcher (npm/PyPI/RubyGems), mirroring the deps bin. */
export function makeFetcher(r: Registries): PackumentFetcher {
  return async (packageName, ecosystem) => {
    if (ecosystem === 'npm') {
      const url = packumentUrl(r.registry, packageName)
      await resolveAndPin(new URL(url).hostname, undefined, { allowPrivate: r.allowPrivate })
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`registry returned ${res.status} for ${packageName}`)
      return (await res.json()) as Packument
    }
    if (ecosystem === 'PyPI') {
      const base = r.pypiRegistry.replace(/\/+$/, '')
      const url = `${base}/${encodeURIComponent(normalizePypiName(packageName))}/json`
      await resolveAndPin(new URL(url).hostname, undefined, { allowPrivate: r.allowPrivate })
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`PyPI returned ${res.status} for ${packageName}`)
      return pypiJsonToPackument((await res.json()) as PyPiJson)
    }
    const base = r.rubygemsRegistry.replace(/\/+$/, '')
    const url = `${base}/versions/${encodeURIComponent(packageName)}.json`
    await resolveAndPin(new URL(url).hostname, undefined, { allowPrivate: r.allowPrivate })
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`RubyGems returned ${res.status} for ${packageName}`)
    return rubygemsToPackument(packageName, (await res.json()) as RubyGemsVersion[])
  }
}

/** SSRF-pinned JSON GET (pre-flight resolve-and-refuse, then fetch). */
async function pinnedFetchJson(url: string, allowPrivate: boolean): Promise<unknown> {
  await resolveAndPin(new URL(url).hostname, undefined, { allowPrivate })
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`metadata fetch returned ${res.status} for ${url}`)
  return res.json()
}

/**
 * Build the SSRF-pinned changelog fetcher (npm/PyPI/RubyGems). Resolves the source GitHub repo
 * from registry metadata — npm packument `repository`, PyPI `info.project_urls`, or the RubyGems
 * `/api/v1/gems/<name>.json` `source_code_uri`/`homepage_uri` — then fetches the CHANGELOG from
 * `raw.githubusercontent.com/<owner>/<repo>/HEAD/<file>`, pinning every request.
 */
function makeChangelogFetcher(r: Registries): ChangelogFetcher {
  const fetchPackument = makeFetcher(r)
  const repoUrlFor = async (
    packageName: string,
    ecosystem: string,
  ): Promise<string | undefined> => {
    if (ecosystem === 'npm') return npmRepoUrl(await fetchPackument(packageName, 'npm'))
    if (ecosystem === 'PyPI') {
      const base = r.pypiRegistry.replace(/\/+$/, '')
      const url = `${base}/${encodeURIComponent(normalizePypiName(packageName))}/json`
      return pypiRepoUrl((await pinnedFetchJson(url, r.allowPrivate)) as PyPiJson)
    }
    if (ecosystem === 'RubyGems') {
      const base = r.rubygemsRegistry.replace(/\/+$/, '')
      const url = `${base}/gems/${encodeURIComponent(packageName)}.json`
      return gemRepoUrl((await pinnedFetchJson(url, r.allowPrivate)) as RubyGemMetadata)
    }
    throw new Error(`changelog fetch supports npm, PyPI, and RubyGems (got "${ecosystem}")`)
  }
  return async (packageName, ecosystem) => {
    const gh = githubOwnerRepo(await repoUrlFor(packageName, ecosystem))
    if (!gh) throw new Error(`could not resolve a GitHub repository for "${packageName}"`)
    for (const file of CHANGELOG_FILENAMES) {
      const url = `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/HEAD/${file}`
      await resolveAndPin(new URL(url).hostname, undefined, { allowPrivate: r.allowPrivate })
      const res = await fetch(url)
      if (res.ok) return { text: await res.text(), source: url }
    }
    throw new Error(`no CHANGELOG found in github.com/${gh.owner}/${gh.repo}`)
  }
}

/** Load advisories + snapshotDate for an ecosystem, or empty when no snapshot dir is set. */
function loadAdvisories(
  osvDir: string | undefined,
  ecosystem: string,
): { advisories: OsvAdvisory[]; snapshotDate?: string; loaded: boolean } {
  if (osvDir === undefined) return { advisories: [], loaded: false }
  const snapshot = loadOsvSnapshot(osvDir, ecosystem)
  return { advisories: snapshot.advisories, snapshotDate: snapshot.snapshotDate, loaded: true }
}

/** Detect → fetch → audit one package (the thin orchestration the pure core needs). */
async function auditOne(
  project: string,
  packageName: string,
  ecosystem: OsvEcosystem,
  fetchPackument: PackumentFetcher,
  advisories: OsvAdvisory[],
  snapshotDate: string | undefined,
  versionOverride?: string,
): Promise<DependencyAudit> {
  const version =
    versionOverride ??
    detectInstalledVersion(project, packageName, { ecosystem: DETECT_ECOSYSTEM[ecosystem] }).version
  if (version === null || version === undefined) {
    throw new Error(`could not detect an installed version of "${packageName}" in ${project}`)
  }
  const packument = await fetchPackument(packageName, ecosystem)
  return auditDependency({
    packageName: matchName(packageName, ecosystem),
    ecosystem,
    installedVersion: version,
    packument,
    advisories,
    snapshotDate,
    comparator: comparatorFor(ecosystem),
  })
}

/**
 * Detect → fetch → audit each declared (or `names`-scoped) dependency of a project,
 * isolating per-package failures — the reusable project audit the `verify run --deps`
 * path reuses (mirrors the MCP `auditProjectDependencies`). Returns the
 * `{audits, osvSnapshotLoaded}` shape the verify orchestrator's deps adapter consumes.
 */
export async function auditProjectScoped(input: {
  project: string
  ecosystem: OsvEcosystem
  /** Audit ONLY these names (the diff-changed deps); omitted ⇒ all declared deps. */
  names?: string[]
  osvDir?: string
  fetchPackument: PackumentFetcher
}): Promise<{
  audits: DependencyAudit[]
  osvSnapshotLoaded: boolean
  errors: { package: string; error: string }[]
}> {
  const { advisories, snapshotDate, loaded } = loadAdvisories(input.osvDir, input.ecosystem)
  const names = input.names ?? dependencyNames(input.project, input.ecosystem, true)
  const audits: DependencyAudit[] = []
  const errors: { package: string; error: string }[] = []
  for (const name of names) {
    try {
      audits.push(
        await auditOne(
          input.project,
          name,
          input.ecosystem,
          input.fetchPackument,
          advisories,
          snapshotDate,
        ),
      )
    } catch (e) {
      errors.push({ package: name, error: (e as Error).message })
    }
  }
  return { audits, osvSnapshotLoaded: loaded, errors }
}

/** A security or deprecation finding — the CI-actionable signal (outdated alone is not). */
function isActionable(audit: DependencyAudit): boolean {
  return audit.worstSeverity !== 'none' || audit.deprecated.isDeprecated
}

function printAudit(
  io: CliIO,
  audit: DependencyAudit,
  loaded: boolean,
  snapshotDate?: string,
): void {
  io.out(`${audit.package}  ${audit.installedVersion}  (${audit.ecosystem})\n`)
  io.out(
    audit.deprecated.isDeprecated
      ? `deprecated [${audit.deprecated.scope}]: ${audit.deprecated.message}\n`
      : 'deprecated: no\n',
  )
  if (audit.vulnerabilities.length > 0) {
    io.out(`vulnerabilities (${audit.vulnerabilities.length}):\n`)
    for (const v of audit.vulnerabilities) {
      const fixed = v.fixedIn.length ? `  fixed in: ${v.fixedIn.join(', ')}` : ''
      io.out(`  ${v.id} [${v.severity}]  ${v.summary ?? ''}${fixed}\n`)
    }
  } else {
    io.out('vulnerabilities: none\n')
  }
  const f = audit.freshness
  io.out(
    `freshness: installed ${f.installed}, latest ${f.latest ?? '?'}, same-major ${f.latestSameMajor ?? '?'}, outdated ${f.isOutdated ? 'yes' : 'no'}\n`,
  )
  if (audit.recommendedTarget) io.out(`recommended target: ${audit.recommendedTarget}\n`)
  if (audit.minimumSafeUpgrade) io.out(`minimum safe upgrade: ${audit.minimumSafeUpgrade}\n`)
  io.out(
    loaded
      ? `osv snapshot: loaded${snapshotDate ? ` (${snapshotDate})` : ''}\n`
      : 'osv snapshot: NOT loaded — treat "no known vulnerabilities" as unknown, not clean\n',
  )
}

async function cmdAudit(
  args: string[],
  io: CliIO,
  deps: { fetchPackument?: PackumentFetcher },
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...REGISTRY_OPTIONS, version: { type: 'string' } },
  })
  const [project, packageName] = positionals
  if (!project || !packageName) {
    io.err('deps audit needs <project> <package>\n')
    return 1
  }
  const ecosystem = ecosystemFrom(values, io)
  if (!ecosystem) return 1
  const r = registriesFrom(values)
  const fetchPackument = deps.fetchPackument ?? makeFetcher(r)
  const { advisories, snapshotDate, loaded } = loadAdvisories(values['osv-db'], ecosystem)

  try {
    const audit = await auditOne(
      project,
      packageName,
      ecosystem,
      fetchPackument,
      advisories,
      snapshotDate,
      values.version,
    )
    if (values.json) {
      io.out(`${JSON.stringify({ ...audit, osvSnapshotLoaded: loaded }, null, 2)}\n`)
    } else {
      printAudit(io, audit, loaded, snapshotDate)
    }
    return isActionable(audit) ? 1 : 0
  } catch (e) {
    io.err(`${(e as Error).message}\n`)
    return 1
  }
}

async function cmdAuditProject(
  args: string[],
  io: CliIO,
  deps: { fetchPackument?: PackumentFetcher },
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...REGISTRY_OPTIONS, 'skip-dev': { type: 'boolean' } },
  })
  const project = positionals[0]
  if (!project) {
    io.err('deps audit-project needs <project>\n')
    return 1
  }
  const ecosystem = ecosystemFrom(values, io)
  if (!ecosystem) return 1
  const r = registriesFrom(values)
  const fetchPackument = deps.fetchPackument ?? makeFetcher(r)
  const { advisories, snapshotDate, loaded } = loadAdvisories(values['osv-db'], ecosystem)
  const names = dependencyNames(project, ecosystem, !values['skip-dev'])

  const dependencies: {
    package: string
    installedVersion: string
    worstSeverity: DependencyAudit['worstSeverity']
    deprecated: boolean
    isOutdated: boolean
    recommendedTarget?: string
    minimumSafeUpgrade?: string
    vulnerabilityCount: number
  }[] = []
  const errors: { package: string; error: string }[] = []
  for (const name of names) {
    try {
      const audit = await auditOne(
        project,
        name,
        ecosystem,
        fetchPackument,
        advisories,
        snapshotDate,
      )
      dependencies.push({
        package: name,
        installedVersion: audit.installedVersion,
        worstSeverity: audit.worstSeverity,
        deprecated: audit.deprecated.isDeprecated,
        isOutdated: audit.freshness.isOutdated,
        recommendedTarget: audit.recommendedTarget,
        minimumSafeUpgrade: audit.minimumSafeUpgrade,
        vulnerabilityCount: audit.vulnerabilities.length,
      })
    } catch (err) {
      errors.push({ package: name, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const bySeverity: Record<string, number> = {}
  for (const d of dependencies) {
    if (d.worstSeverity !== 'none')
      bySeverity[d.worstSeverity] = (bySeverity[d.worstSeverity] ?? 0) + 1
  }
  const summary = {
    total: dependencies.length,
    withFindings: dependencies.filter((d) => d.worstSeverity !== 'none' || d.deprecated).length,
    deprecated: dependencies.filter((d) => d.deprecated).length,
    outdated: dependencies.filter((d) => d.isOutdated).length,
    bySeverity,
    osvSnapshotLoaded: loaded,
    snapshotDate,
  }

  if (values.json) {
    io.out(`${JSON.stringify({ project, ecosystem, summary, dependencies, errors }, null, 2)}\n`)
    return summary.withFindings > 0 ? 1 : 0
  }
  io.out(
    `${project}  (${ecosystem})  ${summary.total} deps; findings ${summary.withFindings}, deprecated ${summary.deprecated}, outdated ${summary.outdated}\n`,
  )
  io.out(
    loaded
      ? `osv snapshot: loaded${snapshotDate ? ` (${snapshotDate})` : ''}\n`
      : 'osv snapshot: NOT loaded — "no known vulnerabilities" is unknown, not clean\n',
  )
  for (const d of dependencies) {
    if (d.worstSeverity === 'none' && !d.deprecated && !d.isOutdated) continue
    const tags = [
      d.worstSeverity !== 'none' ? `[${d.worstSeverity}]` : '',
      d.deprecated ? 'deprecated' : '',
      d.isOutdated ? 'outdated' : '',
    ]
      .filter(Boolean)
      .join(' ')
    const target = d.minimumSafeUpgrade ?? d.recommendedTarget
    io.out(`  ${d.package} ${d.installedVersion}  ${tags}${target ? ` → ${target}` : ''}\n`)
  }
  for (const e of errors) io.out(`  ! ${e.package}: ${e.error}\n`)
  return summary.withFindings > 0 ? 1 : 0
}

async function cmdChangelog(
  args: string[],
  io: CliIO,
  deps: { fetchPackument?: PackumentFetcher; fetchChangelog?: ChangelogFetcher },
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...REGISTRY_OPTIONS,
      project: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
    },
  })
  const packageName = positionals[0]
  if (!packageName) {
    io.err(
      'deps changelog needs <package> (with --from or --project to detect the installed version)\n',
    )
    return 1
  }
  const ecosystem = ecosystemFrom(values, io)
  if (!ecosystem) return 1
  const r = registriesFrom(values)
  const fetchChangelog = deps.fetchChangelog ?? makeChangelogFetcher(r)

  try {
    let from = values.from
    if (from === undefined) {
      if (!values.project) {
        io.err('provide --from <version> or --project <dir> to determine the installed version\n')
        return 1
      }
      const detected = detectInstalledVersion(values.project, packageName, {
        ecosystem: DETECT_ECOSYSTEM[ecosystem],
      })
      if (!detected.version) {
        io.err(`could not detect an installed version of "${packageName}" in ${values.project}\n`)
        return 1
      }
      from = detected.version
    }
    const { text: markdown, source } = await fetchChangelog(packageName, ecosystem)
    const slice = sliceChangelog(markdown, {
      from,
      to: values.to,
      comparator: comparatorFor(ecosystem),
    })

    if (values.json) {
      io.out(
        `${JSON.stringify(
          {
            package: packageName,
            from: slice.from,
            to: slice.to ?? null,
            versionsCovered: slice.entries.map((e) => e.version),
            source,
            body: slice.entries.map((e) => e.body).join('\n\n'),
          },
          null,
          2,
        )}\n`,
      )
      return 0
    }
    io.out(
      `${packageName} ${slice.from} → ${slice.to ?? 'latest'}  (${slice.entries.length} section(s))  [${source}]\n`,
    )
    if (slice.entries.length === 0) {
      io.out('(no changelog sections in the requested range)\n')
      return 0
    }
    for (const e of slice.entries) io.out(`\n## ${e.version}\n${e.body}\n`)
    return 0
  } catch (e) {
    io.err(`${(e as Error).message}\n`)
    return 1
  }
}
