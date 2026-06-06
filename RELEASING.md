# Releasing Sackville

How the unscoped `sackville-mcp` aggregate + the 18 `@sackville-mcp/*` packages (19 in all) get published to npm. The pipeline
is **Changesets** (fixed/lockstep) + a GitHub Actions workflow (`.github/workflows/release.yml`)
that publishes via **pnpm over OIDC trusted publishing** (no npm token, SLSA provenance attached).

> TL;DR: add a changeset → push → merge the auto-opened **"Version Packages" PR** → CI publishes.
> A normal push **never** publishes; publishing happens only when that PR is merged.

---

## One-time operator setup (npmjs.com + GitHub)

These are not in the repo and must be done by an account owner:

1. **Trusted publishing — per package (all 19).** On npmjs.com, for each package's
   *Settings → Publishing access → Trusted Publisher → GitHub Actions*:
   - Repository: `ceautery/sackville`
   - Workflow: `release.yml`
   - Environment: `npm`

   The 18 `@sackville-mcp/*` packages live under the **org** (`npmjs.com/org/sackville-mcp`);
   the unscoped `sackville-mcp` is under your **user** account — both need configuring. There is
   no org-wide bulk setting; it's per-package.
2. **GitHub Actions environment** named `npm` (repo *Settings → Environments*). No protection
   rules needed — merging the Version PR is already the human gate. The name must match the
   `environment:` in `release.yml` and the npm trusted-publisher config exactly.
3. **Allow Actions to open PRs.** Repo *Settings → Actions → General → Workflow permissions →*
   ☑ **"Allow GitHub Actions to create and approve pull requests."** Without this the
   changesets action cannot open the Version PR (it pushes the branch, then 403s).
4. **Branch protection on `main`** with required status checks = the **`gate`** and
   **`package-checks`** jobs. This is what enforces "green gate before publish" — `release.yml`
   itself only builds, it does not run the test gate.

**Token fallback (if OIDC ever won't work):** add a repo secret `NPM_TOKEN` (an automation /
"bypass 2FA" granular token) and uncomment the `NODE_AUTH_TOKEN:` line in `release.yml`. A token
makes npm ignore OIDC, so don't set it if you want to keep using/verifying trusted publishing.

---

## Adding a new package

When the package graph grows a new `@sackville-mcp/*` package (e.g. `@sackville-mcp/spawn`),
it needs a **one-time bootstrap before its first OIDC release** — because npm **cannot publish a
package's first version over OIDC**: a trusted publisher can only be configured on a package that
already exists, and there is no "create empty package" UI (unlike PyPI, which allows pre-config;
see [npm/cli#8544](https://github.com/npm/cli/issues/8544), open).

1. **Bootstrap-publish it once with a token**, at the *current* group version and on the `alpha`
   tag, from a clean build:
   ```sh
   pnpm -r build
   cd packages/<name>
   npm publish --tag alpha --access public   # token needs publish + "Bypass 2FA" on @sackville-mcp
   ```
   Do this **before** the next Version-PR merge — otherwise `release.yml`'s OIDC publish reaches a
   package that doesn't exist yet and the release job fails mid-run. (A first publish also sets
   `latest`; that's fine — it matches the siblings' current `latest`.)
2. **Configure its trusted publisher** on npmjs.com with the *same* values as every other package
   (repo `ceautery/sackville`, workflow `release.yml`, environment `npm`). Org-scoped package →
   under the org; the bootstrap above created it there.
3. **Nothing else.** The package is already in the fixed group (the `@sackville-mcp/*` glob), so
   `changeset version` bumps it with the set **and auto-adds it to `pre.json.initialVersions`** —
   no manual `pre.json` edit. From the next release on, it publishes over OIDC like the rest.
   (Hygiene: glance at the "Version Packages" PR to confirm the new package is listed at the same
   `alpha.N` as the group before merging.)

---

## Cutting a release

### Alpha / prerelease (current channel)

```sh
pnpm changeset pre enter alpha     # once, to enter pre mode (commits .changeset/pre.json)
pnpm changeset                     # describe the change; pick bump levels (fixed → all 19 move together)
git add -A && git commit -m "..." && git push origin main
# → release.yml opens a "Version Packages (alpha)" PR
# review it (it bumps all 19 + writes CHANGELOGs), then MERGE it
# → release.yml publishes 0.0.1-alpha.<n> to the `alpha` dist-tag, over OIDC
```

### Stable release

```sh
pnpm changeset pre exit            # leave pre mode (if you were in it)
pnpm changeset                     # describe the change
git add -A && git commit -m "..." && git push origin main
# → merge the "Version Packages" PR → publishes to the `latest` dist-tag
```

### Fixed / lockstep

`.changeset/config.json` has `"fixed": [["sackville-mcp", "@sackville-mcp/*"]]`, so **all 19
version together** — a changeset touching any one bumps the whole set to the same version. You
can list one package or all; the result is identical.

---

## dist-tags (important)

- **Pre mode publishes only to the `alpha` tag and never moves `latest`** (`scripts/release.sh`
  reads `.changeset/pre.json` and passes `--tag alpha`). So after an alpha release, a bare
  `npm i sackville-mcp` still resolves to whatever `latest` last pointed at.
- To make a bare install track the newest alpha, repoint `latest` manually:
  ```sh
  for p in sackville-mcp $(your @sackville-mcp/* list); do
    npm dist-tag add "$p@<version>" latest
  done
  ```
  Note the **unscoped `sackville-mcp`** is user-owned, so a token scoped only to the
  `@sackville-mcp` org will 403 on it — repoint it in the npm UI or with a broader token.
- A first-ever publish of a package always sets `latest` regardless of `--tag` (the alpha.0
  trap). `release.sh`'s prerelease-aware tagging avoids this for subsequent releases.

---

## Verifying a release

```sh
# all at the new version on the alpha tag
npm view sackville-mcp@alpha version
npm view sackville-mcp dist-tags

# provenance present (proves OIDC, not a token, did the publish)
npm view @sackville-mcp/verdict@<version> --json | jq .dist.attestations

# native-free smoke (api+deps+verify enabled, docs disabled; optional peers absent):
npx -y sackville-mcp@alpha    # prints: sackville-mcp: enabled [api, deps, verify]; disabled [docs]
```

Local pre-publish packaging audit (no publish): `pnpm package-checks` — packs all 19, runs
`attw --profile esm-only` + `publint` on each tarball, and asserts the aggregate `bin.mjs`
startup closure is native-free.

---

## Gotchas (learned the hard way)

- **Node version in `release.yml` must be `22` (latest 22.x), not the bare `22.14.0` floor.**
  22.14.0 is too old for tsdown to load its config natively; it falls back to an optional
  `unrun` loader that isn't installed and **every build fails**. Latest 22.x still satisfies
  the §18 OIDC floor (≥ 22.14.0).
- **`.changeset/` is excluded from Biome** (`biome.json`). `changeset version` writes
  `pre.json` in a format Biome would reformat, which otherwise fails the gate on a
  tool-generated file (and would block the Version PR merge under branch protection).
- **A consumed changeset `.md` lingers on disk in pre mode** — it's recorded in
  `pre.json.changesets`, so `changeset status` shows nothing pending and no duplicate PR opens.
  Do **not** delete it manually; it clears on `pre exit`.
- **Publishing needs OIDC or a bypass-2FA token.** A `npm login` web session and a granular
  token *without* "Bypass 2FA" both 403 on publish.
- **ESM-only**: `attw` is run with `--profile esm-only`; the legacy top-level `types` field is
  overlaid to `./dist/index.d.mts` via `publishConfig.types` (the dev value points at `./src`
  for the no-build gate).

---

See `docs/decisions/0019-packaging-distribution.md` (slices 2/10/13) and `STATUS.md`.
