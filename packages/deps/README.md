# @strummer/deps

**Dependency / version intelligence** — the first Phase-4 cross-cutting verification
pillar (see `docs/decisions/0010-phase4-cross-cutting-verification.md`).

The agent-first question it answers: *"is the dependency version actually installed
in my project safe and current to keep using, and what changes if I bump it?"*
Strummer already nailed version-pinning in the docs pillar — answering for **the
version that is installed** (not "latest") is the same prime directive applied to
security and freshness. This is exactly where coding agents hallucinate ("upgrade to
latest") or stay silent on EOL/CVE risk.

The design keeps a **pure, offline-deterministic core** and gates every live fetch
behind operator config:

- **Verdict logic is pure.** Functions like `auditDeprecation(packument,
  installedVersion)` reduce already-fetched registry/advisory data to a structured
  verdict — no network, no subprocess — so the green gate stays deterministic.
- **Advisory data is file-as-data.** Vulnerability lookups read an operator-
  provisioned on-disk OSV snapshot (`STRUMMER_DEPS_OSV_DB_DIR`); network is
  off by default. When enabled, egress is SSRF-pinned via `@strummer/safety`
  `resolveAndPin` + an operator allowlist — never an agent-supplied URL.
- **Big artifacts by handle.** Changelog/release-note diffs are returned by
  resource handle, never inlined.

## Shipped so far

- **`auditDeprecation(packument, installedVersion)`** — given an npm packument and
  the installed version, returns whether that version is deprecated and at what
  scope (`'version'` wins over `'package'`; npm's empty-string "un-deprecate" idiom
  is honoured).

```ts
import { auditDeprecation } from '@strummer/deps'

auditDeprecation(requestPackument, '2.88.2')
// → { isDeprecated: true, message: '…', scope: 'version' }
auditDeprecation(lodashPackument, '4.17.21')
// → { isDeprecated: false }
```

- **`matchVulnerabilities(advisories, pkg, installedVersion)`** — given parsed OSV
  advisories, returns the ones that affect the installed version, with a bucketed
  severity (`critical|high|moderate|low|unknown`) and the `fixedIn` versions. Range
  evaluation follows the OSV schema's documented sort-events-then-scan algorithm
  (SEMVER/ECOSYSTEM ranges via `semver`; `fixed` exclusive, `last_affected`
  inclusive; explicit `versions`; filtered by ecosystem + name).

```ts
import { matchVulnerabilities } from '@strummer/deps'

matchVulnerabilities(lodashAdvisories, { ecosystem: 'npm', name: 'lodash' }, '4.17.15')
// → [{ id: 'GHSA-…', severity: 'moderate', fixedIn: ['4.17.21'], … }]
```

- **`loadOsvSnapshot(dir, ecosystem)`** — read an operator-provisioned on-disk OSV
  snapshot (`<dir>/<ecosystem>/all.zip`, fflate-unzipped, one advisory JSON per
  entry) into `{ ecosystem, advisories, snapshotDate }`. Advisories are sorted by id
  and feed straight into `matchVulnerabilities`; `snapshotDate` (the newest advisory
  `modified`) lets callers flag staleness. Fails loud if the ecosystem's snapshot is
  absent — never a silent "zero vulnerabilities". Zero network.

```ts
import { loadOsvSnapshot, matchVulnerabilities } from '@strummer/deps'

const { advisories, snapshotDate } = loadOsvSnapshot(process.env.STRUMMER_DEPS_OSV_DB_DIR!, 'npm')
matchVulnerabilities(advisories, { ecosystem: 'npm', name: 'lodash' }, '4.17.15')
```

Later slices (staged in `ROADMAP.md`): `auditDependency` (compose detect-version +
deprecation + vuln + freshness into one verdict); `behindBy` freshness vs the
version-pin policy; CVSS-vector → bucket scoring; the `audit_dependency` /
`audit_project` / `changelog_diff` MCP tools + a `strummer-deps-mcp` bin; the
operator-gated network fetch of `all.zip`; and a Python/PyPI adapter.
