import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { detectInstalledVersion, type Ecosystem } from '@strummer/core'
import {
  auditDependency,
  type DependencyAudit,
  loadOsvSnapshot,
  type OsvAdvisory,
  type Packument,
} from '@strummer/deps'
import { z } from 'zod'

/** Fetch the registry metadata ("packument") for a package. Injected so the pure
 * audit core stays offline/deterministic; the bin wires an operator-gated,
 * SSRF-pinned network fetcher. Absent ⇒ network is off and the audit tools say so. */
export type PackumentFetcher = (packageName: string, ecosystem: string) => Promise<Packument>

export interface DepsToolsOptions {
  /** OPERATOR: directory of the on-disk OSV snapshot (`<dir>/<ecosystem>/all.zip`).
   * Absent ⇒ no advisories are loaded — vulnerability matching is skipped and the
   * audit reports `osvSnapshotLoaded:false` so "no known vulns" is never treated as
   * authoritative. Never an agent input. */
  osvDir?: string
  /** OPERATOR: injected packument source (see {@link PackumentFetcher}). */
  fetchPackument?: PackumentFetcher
}

/** OSV ecosystem names this surface understands, mapped to the `@strummer/core`
 * detection ecosystem. v1 wires npm end-to-end; the others are staged. */
const ECOSYSTEMS = ['npm', 'PyPI', 'RubyGems'] as const
type OsvEcosystem = (typeof ECOSYSTEMS)[number]
const DETECT_ECOSYSTEM: Record<OsvEcosystem, Ecosystem> = {
  npm: 'node',
  PyPI: 'python',
  RubyGems: 'ruby',
}

const INSTRUCTIONS = `Strummer answers dependency/version questions for the version of a
package that is ACTUALLY INSTALLED in a project (not "latest"): is it deprecated, does
it have a known vulnerability, how far behind is it.

Use \`audit_dependency\` for one package, \`audit_project\` for a compact roll-up across
a manifest. Vulnerability data comes from an operator-provisioned offline OSV snapshot;
when none is configured the result carries \`osvSnapshotLoaded:false\` — treat "no known
vulnerabilities" as unknown, not clean. Network access to fetch package metadata is
operator-gated and off by default.`

function text(value: unknown) {
  return { type: 'text' as const, text: JSON.stringify(value, null, 2) }
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

/** Read a project's npm manifest dependency names (prod + optional + optionally dev). */
function manifestDependencies(project: string, includeDev: boolean): string[] {
  const raw = readFileSync(join(project, 'package.json'), 'utf8')
  const pkg = JSON.parse(raw) as {
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const names = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ])
  if (includeDev) for (const n of Object.keys(pkg.devDependencies ?? {})) names.add(n)
  return [...names].sort()
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
    packageName,
    ecosystem,
    installedVersion: detected.version,
    packument,
    advisories,
    snapshotDate,
  })
}

/** Register the dependency-intelligence tools onto a server. */
export function registerDepsTools(server: McpServer, opts: DepsToolsOptions = {}): void {
  const ecosystemArg = z
    .enum(ECOSYSTEMS)
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
        packageName: args.package,
        ecosystem,
        installedVersion: detected.version,
        packument,
        advisories,
        snapshotDate,
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
        'deprecated, outdated, finding count) plus a summary. For full detail on one package ' +
        'call audit_dependency. v1 supports the npm ecosystem.',
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
      if (ecosystem !== 'npm') {
        throw new Error('audit_project currently supports the npm ecosystem only')
      }
      const { advisories, snapshotDate, loaded } = loadAdvisories(opts.osvDir, ecosystem)
      const names = manifestDependencies(args.project, args.includeDev ?? true)

      const dependencies: {
        package: string
        installedVersion: string
        worstSeverity: DependencyAudit['worstSeverity']
        deprecated: boolean
        isOutdated: boolean
        recommendedTarget?: string
        vulnerabilityCount: number
        hasFindings: boolean
      }[] = []
      const errors: { package: string; error: string }[] = []

      // Sequential keeps output deterministic and is gentle on the registry.
      for (const name of names) {
        try {
          const audit = await auditOne(
            args.project,
            name,
            ecosystem,
            opts,
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
            vulnerabilityCount: audit.vulnerabilities.length,
            hasFindings: audit.hasFindings,
          })
        } catch (err) {
          errors.push({ package: name, error: err instanceof Error ? err.message : String(err) })
        }
      }

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
      const structured = { project: args.project, ecosystem, summary, dependencies, errors }
      return { content: [text(structured)], structuredContent: structured }
    },
  )
}

/** Build a standalone Strummer dependency-intelligence MCP server. */
export function createDepsServer(opts: DepsToolsOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'strummer-deps', version: '0.0.0' },
    { instructions: INSTRUCTIONS },
  )
  registerDepsTools(server, opts)
  return server
}
