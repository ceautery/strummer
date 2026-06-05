import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ArtifactStore } from '@sackville/artifacts'
import { detectInstalledVersion, type Ecosystem } from '@sackville/core'
import {
  auditDependency,
  comparatorFor,
  type DependencyAudit,
  dependencyNames,
  loadOsvSnapshot,
  matchName,
  OSV_ECOSYSTEMS,
  type OsvAdvisory,
  type OsvEcosystem,
  type Packument,
  sliceChangelog,
} from '@sackville/deps'
import { z } from 'zod'

/** Fetch the registry metadata ("packument") for a package. Injected so the pure
 * audit core stays offline/deterministic; the bin wires an operator-gated,
 * SSRF-pinned network fetcher. Absent ⇒ network is off and the audit tools say so. */
export type PackumentFetcher = (packageName: string, ecosystem: string) => Promise<Packument>

/** Fetch a package's raw CHANGELOG markdown. Injected like {@link PackumentFetcher};
 * the bin wires an operator-gated, SSRF-pinned fetch. Returns the text + its source. */
export type ChangelogFetcher = (
  packageName: string,
  ecosystem: string,
) => Promise<{ text: string; source: string }>

export interface DepsToolsOptions {
  /** OPERATOR: directory of the on-disk OSV snapshot (`<dir>/<ecosystem>/all.zip`).
   * Absent ⇒ no advisories are loaded — vulnerability matching is skipped and the
   * audit reports `osvSnapshotLoaded:false` so "no known vulns" is never treated as
   * authoritative. Never an agent input. */
  osvDir?: string
  /** OPERATOR: injected packument source (see {@link PackumentFetcher}). */
  fetchPackument?: PackumentFetcher
  /** OPERATOR: injected changelog source (see {@link ChangelogFetcher}). Absent ⇒
   * `changelog_diff` reports it is not enabled. */
  fetchChangelog?: ChangelogFetcher
  /** OPERATOR: on-disk artifact store (prefix `deps`) backing by-handle output —
   * `changelog_diff`'s sliced markdown and `audit_project`'s full per-package
   * verdicts. Absent ⇒ `changelog_diff` is not registered and `audit_project` omits
   * its `detailHandle` (large/multi-package output is returned by handle, never inlined). */
  artifacts?: ArtifactStore
}

/** Map an OSV ecosystem to the `@sackville/core` installed-version detection ecosystem.
 * (Comparator/match-name/manifest dispatch lives in `@sackville/deps`; this mapping needs
 * `core`, which the engine deliberately does not depend on, so it stays here.) */
const DETECT_ECOSYSTEM: Record<OsvEcosystem, Ecosystem> = {
  npm: 'node',
  PyPI: 'python',
  RubyGems: 'ruby',
}

const INSTRUCTIONS = `Sackville answers dependency/version questions for the version of a
package that is ACTUALLY INSTALLED in a project (not "latest"): is it deprecated, does
it have a known vulnerability, how far behind is it.

Use \`audit_dependency\` for one package, \`audit_project\` for a compact roll-up across
a manifest, and \`changelog_diff\` to see WHAT CHANGED between the installed version and
an upgrade target (the sliced changelog is returned by handle — read the
\`sackville://deps/{id}/{kind}\` resource). Vulnerability data comes from an
operator-provisioned offline OSV snapshot; when none is configured the result carries
\`osvSnapshotLoaded:false\` — treat "no known vulnerabilities" as unknown, not clean.
Network access to fetch package metadata/changelogs is operator-gated and off by default.`

function text(value: unknown) {
  return { type: 'text' as const, text: JSON.stringify(value, null, 2) }
}

/** Filesystem-safe artifact id (it becomes a directory name under the store). */
function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-')
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

/** Detect → fetch → audit one package. Throws a clear error on a missing version or
 * a disabled fetcher; returns the pure {@link auditDependency} verdict otherwise. */
async function auditOne(
  project: string,
  packageName: string,
  ecosystem: OsvEcosystem,
  opts: DepsToolsOptions,
  advisories: OsvAdvisory[],
  snapshotDate: string | undefined,
): Promise<DependencyAudit> {
  const detected = detectInstalledVersion(project, packageName, {
    ecosystem: DETECT_ECOSYSTEM[ecosystem],
  })
  if (detected.version === null) {
    throw new Error(`could not detect an installed version of "${packageName}" in ${project}`)
  }
  if (opts.fetchPackument === undefined) {
    throw new Error(
      'package-metadata fetch is not enabled (the operator must enable network access for the deps server)',
    )
  }
  const packument = await opts.fetchPackument(packageName, ecosystem)
  return auditDependency({
    packageName: matchName(packageName, ecosystem),
    ecosystem,
    installedVersion: detected.version,
    packument,
    advisories,
    snapshotDate,
    comparator: comparatorFor(ecosystem),
  })
}

/** Config for the reusable project-audit pipeline (the run-driving deps runner reuses
 * this, scoped to the diff-changed packages via {@link ProjectAuditConfig.names}). */
export interface ProjectAuditConfig {
  /** Absolute project root. */
  project: string
  /** OSV ecosystem (default `npm`). */
  ecosystem?: OsvEcosystem
  /** Include devDependencies when reading the manifest (default true). Ignored when
   * `names` is supplied (the caller already chose the scope). */
  includeDev?: boolean
  /** Scope: audit ONLY these declared package names (e.g. the diff-changed deps). When
   * omitted, every declared manifest dependency is audited. */
  names?: string[]
  /** OPERATOR: on-disk OSV snapshot dir (absent ⇒ `osvSnapshotLoaded:false`). */
  osvDir?: string
  /** OPERATOR: injected, SSRF-pinned packument fetcher. Absent ⇒ every package errors. */
  fetchPackument?: PackumentFetcher
}

/** The reusable per-package audit roll-up: the full verdicts + provenance + isolated
 * per-package errors. The `verify_change` deps runner consumes `{audits, osvSnapshotLoaded}`. */
export interface ProjectAuditResult {
  audits: DependencyAudit[]
  osvSnapshotLoaded: boolean
  /** Newest advisory `modified` date in the loaded snapshot (undefined when none). */
  snapshotDate?: string
  errors: { package: string; error: string }[]
}

/**
 * Detect → fetch → audit each declared (or `names`-scoped) dependency of a project,
 * isolating per-package failures. Surface-agnostic: `audit_project` builds its compact
 * roll-up from this, and the run-driving `verify_change` deps runner (bin-verify) calls
 * it scoped to `changedDependencies(diff)`. Sequential — deterministic + gentle on the
 * registry.
 */
export async function auditProjectDependencies(
  config: ProjectAuditConfig,
): Promise<ProjectAuditResult> {
  const ecosystem = config.ecosystem ?? 'npm'
  const { advisories, snapshotDate, loaded } = loadAdvisories(config.osvDir, ecosystem)
  const names =
    config.names ?? dependencyNames(config.project, ecosystem, config.includeDev ?? true)
  const opts: DepsToolsOptions = { fetchPackument: config.fetchPackument, osvDir: config.osvDir }

  const audits: DependencyAudit[] = []
  const errors: { package: string; error: string }[] = []
  for (const name of names) {
    try {
      audits.push(await auditOne(config.project, name, ecosystem, opts, advisories, snapshotDate))
    } catch (err) {
      errors.push({ package: name, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { audits, osvSnapshotLoaded: loaded, snapshotDate, errors }
}

/** Register the dependency-intelligence tools onto a server. */
export function registerDepsTools(server: McpServer, opts: DepsToolsOptions = {}): void {
  const ecosystemArg = z
    .enum(OSV_ECOSYSTEMS)
    .optional()
    .describe('OSV ecosystem (default "npm"; v1 wires npm end-to-end)')

  server.registerTool(
    'audit_dependency',
    {
      title: 'Audit one installed dependency',
      description:
        'Audit the INSTALLED version of one package for deprecation, known vulnerabilities ' +
        '(from the offline OSV snapshot), and freshness. Reports osvSnapshotLoaded so "no ' +
        'known vulns" is never mistaken for authoritative when no snapshot is configured.',
      inputSchema: {
        project: z.string().describe('absolute path to the project root'),
        package: z.string().describe('package name to audit'),
        ecosystem: ecosystemArg,
        version: z
          .string()
          .optional()
          .describe('override the detected installed version (rarely needed)'),
      },
    },
    async (args) => {
      const ecosystem = (args.ecosystem ?? 'npm') as OsvEcosystem
      const { advisories, snapshotDate, loaded } = loadAdvisories(opts.osvDir, ecosystem)
      const detected = args.version
        ? { version: args.version, source: 'override' as const }
        : detectInstalledVersion(args.project, args.package, {
            ecosystem: DETECT_ECOSYSTEM[ecosystem],
          })
      if (detected.version === null) {
        throw new Error(
          `could not detect an installed version of "${args.package}" in ${args.project}`,
        )
      }
      if (opts.fetchPackument === undefined) {
        throw new Error(
          'package-metadata fetch is not enabled (the operator must enable network access for the deps server)',
        )
      }
      const packument = await opts.fetchPackument(args.package, ecosystem)
      const audit = auditDependency({
        packageName: matchName(args.package, ecosystem),
        ecosystem,
        installedVersion: detected.version,
        packument,
        advisories,
        snapshotDate,
        comparator: comparatorFor(ecosystem),
      })
      const structured = { ...audit, detectedSource: detected.source, osvSnapshotLoaded: loaded }
      return { content: [text(structured)], structuredContent: structured }
    },
  )

  server.registerTool(
    'audit_project',
    {
      title: 'Audit every installed dependency in a project',
      description:
        'Scan a project manifest and roll up a COMPACT per-dependency verdict (severity, ' +
        'deprecated, outdated, finding count) plus a summary. When an artifact store is ' +
        'configured the full per-package verdicts (vulnerability lists, deprecation messages, ' +
        'freshness) are stored BY HANDLE (`detailHandle` → the sackville://deps/{id}/{kind} ' +
        'resource); otherwise drill into one package with audit_dependency. Supports npm ' +
        '(package.json), PyPI (pyproject/requirements.txt), and RubyGems (Gemfile.lock/Gemfile).',
      inputSchema: {
        project: z.string().describe('absolute path to the project root'),
        ecosystem: ecosystemArg,
        includeDev: z
          .boolean()
          .optional()
          .describe('include devDependencies in the scan (default true)'),
      },
    },
    async (args) => {
      const ecosystem = (args.ecosystem ?? 'npm') as OsvEcosystem
      // The full per-package verdicts (vulnerability lists, deprecation messages,
      // freshness) — too large to inline, surfaced by handle when a store is set.
      const {
        audits: fullAudits,
        osvSnapshotLoaded: loaded,
        snapshotDate,
        errors,
      } = await auditProjectDependencies({
        project: args.project,
        ecosystem,
        includeDev: args.includeDev ?? true,
        osvDir: opts.osvDir,
        fetchPackument: opts.fetchPackument,
      })

      const dependencies = fullAudits.map((audit) => ({
        package: audit.package,
        installedVersion: audit.installedVersion,
        worstSeverity: audit.worstSeverity,
        deprecated: audit.deprecated.isDeprecated,
        isOutdated: audit.freshness.isOutdated,
        recommendedTarget: audit.recommendedTarget,
        minimumSafeUpgrade: audit.minimumSafeUpgrade,
        vulnerabilityCount: audit.vulnerabilities.length,
        hasFindings: audit.hasFindings,
      }))

      const bySeverity: Record<string, number> = {}
      for (const d of dependencies) {
        if (d.worstSeverity !== 'none') {
          bySeverity[d.worstSeverity] = (bySeverity[d.worstSeverity] ?? 0) + 1
        }
      }
      const summary = {
        total: dependencies.length,
        withFindings: dependencies.filter((d) => d.hasFindings).length,
        deprecated: dependencies.filter((d) => d.deprecated).length,
        outdated: dependencies.filter((d) => d.isOutdated).length,
        bySeverity,
        osvSnapshotLoaded: loaded,
        snapshotDate,
      }

      // When an artifact store is configured, persist the full verdicts by handle so
      // the agent can drill into one package's vulnerabilities without re-running the
      // scan; the inline result stays a compact roll-up either way.
      const detailHandle = opts.artifacts?.put(
        safeId(args.project),
        'audit',
        JSON.stringify({ project: args.project, ecosystem, audits: fullAudits }, null, 2),
        'application/json',
      )
      const structured = {
        project: args.project,
        ecosystem,
        summary,
        dependencies,
        errors,
        detailHandle,
      }
      return { content: [text(structured)], structuredContent: structured }
    },
  )

  // Anything emitted by handle (changelog slices, full audit_project detail) is
  // served by one resource, registered whenever an artifact store is configured.
  if (opts.artifacts !== undefined) {
    const store = opts.artifacts

    server.registerResource(
      'deps-artifact',
      new ResourceTemplate('sackville://deps/{id}/{kind}', { list: undefined }),
      {
        title: 'Dependency artifact',
        description: 'A stored deps artifact (a sliced changelog or full audit detail) by handle',
        mimeType: 'application/json',
      },
      (uri, variables) => {
        const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
        const handle = `sackville://deps/${pick(variables.id)}/${pick(variables.kind)}`
        const artifact = store.get(handle)
        if (!artifact) {
          throw new Error(`No stored deps artifact for ${handle}`)
        }
        return {
          contents: [
            { uri: uri.href, mimeType: artifact.contentType, text: artifact.body.toString('utf8') },
          ],
        }
      },
    )

    // changelog_diff emits large, multi-version markdown by handle, so beyond the
    // store it additionally needs a changelog fetcher — deny-by-default: absent the
    // fetcher, the tool is not registered at all.
    if (opts.fetchChangelog !== undefined) {
      const fetchChangelog = opts.fetchChangelog

      server.registerTool(
        'changelog_diff',
        {
          title: 'Diff a dependency changelog across an upgrade',
          description:
            'Slice a package CHANGELOG to the versions between the INSTALLED version (from) and ' +
            'an upgrade target (to), so you can see what actually changed before recommending a ' +
            'bump. Returns a COMPACT summary (versions covered, source) + the sliced markdown by ' +
            'handle — read the sackville://deps/{id}/{kind} resource for the full text.',
          inputSchema: {
            project: z
              .string()
              .optional()
              .describe('project root, to auto-detect the installed `from` version'),
            package: z.string().describe('package name'),
            ecosystem: ecosystemArg,
            from: z
              .string()
              .optional()
              .describe('lower bound (exclusive); defaults to the detected installed version'),
            to: z
              .string()
              .optional()
              .describe('upgrade target (inclusive); omit for everything newer than `from`'),
          },
        },
        async (args) => {
          const ecosystem = (args.ecosystem ?? 'npm') as OsvEcosystem
          let from = args.from
          if (from === undefined) {
            if (args.project === undefined) {
              throw new Error(
                'provide `from` or `project` so the installed version can be detected',
              )
            }
            const detected = detectInstalledVersion(args.project, args.package, {
              ecosystem: DETECT_ECOSYSTEM[ecosystem],
            })
            if (detected.version === null) {
              throw new Error(
                `could not detect an installed version of "${args.package}" in ${args.project}`,
              )
            }
            from = detected.version
          }

          const { text: markdown, source } = await fetchChangelog(args.package, ecosystem)
          const slice = sliceChangelog(markdown, {
            from,
            to: args.to,
            comparator: comparatorFor(ecosystem),
          })
          const body = slice.entries.map((e) => e.body).join('\n\n')

          const id = safeId(`${args.package}-${slice.from}-to-${slice.to ?? 'latest'}`)
          const handle = store.put(id, 'changelog', body, 'text/markdown')
          const structured = {
            package: args.package,
            ecosystem,
            from: slice.from,
            to: slice.to ?? null,
            versionsCovered: slice.entries.map((e) => e.version),
            entryCount: slice.entries.length,
            allVersions: slice.allVersions,
            source,
            handle,
            byteSize: Buffer.byteLength(body),
            contentType: 'text/markdown',
            note:
              slice.entries.length === 0
                ? 'no changelog sections fall in the requested range'
                : undefined,
          }
          return { content: [text(structured)], structuredContent: structured }
        },
      )
    }
  }
}

/** Build a standalone Sackville dependency-intelligence MCP server. */
export function createDepsServer(opts: DepsToolsOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'sackville-deps', version: '0.0.0' },
    { instructions: INSTRUCTIONS },
  )
  registerDepsTools(server, opts)
  return server
}
