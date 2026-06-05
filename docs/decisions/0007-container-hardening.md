# ADR 0007 — Container hardening for the browser pillar

- **Status:** Accepted
- **Date:** 2026-06-01

## Context

The browser pillar (`@sackville/browser` + `sackville-browser-mcp`) runs a **real
Chromium** that loads **attacker-influenced web content** and is driven by an
**LLM agent**. That is the most exposed surface in Sackville: a renderer exploit,
a malicious page, or a confused-deputy agent all execute *inside the server
process's host*.

ADR 0006 established the **in-process** defenses — the two-tier SSRF layer
(Tier-1 route allowlist + the mandatory loopback DNS-pinning proxy), the
deny-by-default action gate (navigation allowlist + dry-run-vs-execute), the
secret boundary (fill/auth resolution + redact-before-write across every
artifact), the upload/download/flow/replay path confinements, and the resource
caps. Those govern what the *browser* and the *agent* can do through the
documented APIs.

They do **not** govern what a **compromised renderer** (renderer-RCE via a
Chromium 0-day) can do once it is executing native code: read the filesystem,
open sockets directly (bypassing the app-level proxy), spawn processes, or pivot
to the host. ADR 0006 §7 named the container posture in one line ("keep the
sandbox: seccomp + dropped caps + read-only FS + non-root; `--no-sandbox` is an
operator-gated fallback"). This ADR specifies that posture in full — it is the
**last line of defense** behind the in-process spine, and the deployment
contract for operators running `sackville-browser-mcp` in production.

> **Scope.** This ADR is **operator deployment guidance** plus the in-process
> launch flags Sackville already sets. The Linux dev-container harness that hosts
> Claude Code (`docker/`, `docker-compose.yml`) is untracked/gitignored local
> tooling and is **not** the production profile described here; the example
> manifests below are illustrative, not shipped files.

## Threat model

Defend against a **compromised renderer or a malicious page** that has achieved
native code execution inside the container, and against a **confused/hostile
agent** that drives the browser toward exfiltration or pivot. Assume the
in-process gate/SSRF/secret layers may be bypassed by native code; the container
+ kernel boundary must still contain the blast radius. We are **not** defending
against a hostile *operator* (they own the config) nor against host-kernel 0-days
(out of scope; mitigated by keeping the host patched).

The properties to preserve under a renderer compromise:

1. **No raw network egress** beyond what the SSRF proxy already permits (native
   sockets must not reach link-local/metadata/private ranges).
2. **No host filesystem read/write** beyond explicitly-mounted, minimal dirs.
3. **No privilege escalation** to root or to new capabilities.
4. **No pivot to the host** (process, IPC, or device access).

## Decisions

### 1. Keep the Chromium sandbox enabled by default

The multi-process Chromium sandbox (the renderer running unprivileged, brokered
through the zygote) is the **primary** containment for a renderer exploit — it
must stay on. Sackville launches with the sandbox **on by default**;
`SACKVILLE_BROWSER_NO_SANDBOX` (→ `--no-sandbox`) is an **explicit operator
opt-in** only (already implemented in `bin-browser.ts`). `--no-sandbox` removes
the in-Chromium renderer/host barrier, leaving the OS/container boundary as the
*only* line — acceptable solely when the container boundary below is fully
applied and the operator accepts the residual renderer-RCE→container risk.

### 2. Resolve the sandbox-in-container tension via unprivileged user namespaces

Chromium's sandbox needs either **unprivileged user namespaces** or the broad
**`SYS_ADMIN`** capability (or it falls back to `--no-sandbox`). The hardened
target is **unprivileged userns**, which lets the sandbox work with **no added
capability**:

- Host: enable unprivileged user namespaces (`kernel.unprivileged_userns_clone=1`
  / `user.max_user_namespaces > 0`).
- Container: a **seccomp profile that permits the sandbox syscalls** Chromium
  needs (`clone`/`unshare` with the namespace flags). Docker's *default* seccomp
  profile permits these on modern kernels; we ship/document a profile derived
  from the default (see §5) rather than relaxing to `SYS_ADMIN`.

Order of preference, most→least hardened: **unprivileged userns + sandbox** →
`SYS_ADMIN` + sandbox (broad cap, discouraged) → `--no-sandbox` (last resort).
Pick the first the host kernel supports.

### 3. Non-root, no-new-privileges

Run the server as a **non-root UID** (the Playwright base image ships `pwuser`);
never UID 0. Set **`no-new-privileges`** so a setuid binary or exploit cannot
gain privileges mid-execution. Writable mount points (below) are chowned to the
runtime UID.

### 4. Drop all Linux capabilities

`cap_drop: ALL`, add back **none** in the userns path (the sandbox does not need
`SYS_ADMIN` there). A browser-testing process legitimately needs no ambient
capability. Operators forced onto the `SYS_ADMIN` path (no userns) add back only
that one, and should treat it as a downgrade documented in their risk register.

### 5. seccomp profile

Apply a seccomp profile (do **not** run `--security-opt seccomp=unconfined`).
Start from **Docker's default** profile (which already blocks the dangerous
syscall classes while permitting Chromium's namespace/clone needs on current
kernels) and tighten from there; pin the exact profile against the same
**`mcr.microsoft.com/playwright:v1.60.0-noble`** image the lockfile pins, so a
core/image bump re-validates it (consistent with ADR 0006's lockstep rule).
Unconfined seccomp would re-open the kernel attack surface the rest of this ADR
is trying to close.

### 6. Read-only root filesystem + minimal writable mounts

Mount the **root filesystem read-only** (`read_only: true`). Provide writable
space only where genuinely needed, each as a **tmpfs or an explicit volume**:

- `tmpfs` `/tmp` (and the browser's user-data/cache dir under it).
- A **dedicated `/dev/shm`** sized for Chromium (default 64 MB crashes it):
  prefer **`--shm-size=1g`** (or set `SACKVILLE_BROWSER_*` to pass
  `--disable-dev-shm-usage`, which routes shared memory to `/tmp`). **Avoid
  `--ipc=host`** — it punches a hole in process isolation for the sake of shared
  memory, defeating part of this ADR.
- The operator artifact/IO dirs that already exist as env-gated knobs —
  `SACKVILLE_BROWSER_ARTIFACTS_DIR`, and (only if enabled) `DOWNLOAD_DIR`,
  `UPLOAD_DIR`, `HAR_DIR`, `REPLAY_HAR_DIR`, `FLOWS_DIR`, `VIDEO_DIR` — mounted as
  **named volumes**, writable, owned by the runtime UID. Everything else stays
  read-only.

This means a compromised renderer cannot persist to or tamper with the image,
and can only touch the few dirs the operator deliberately exposed (which are
already path-confined in-process).

### 7. Disable WebRTC and QUIC in the hardened profile

WebRTC and QUIC are **alternate egress paths** that can sidestep an HTTP(S)
forward proxy. Sackville already neutralizes WebRTC at launch
(`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, ADR 0006 §5). The
hardened profile additionally **disables QUIC** (`--disable-quic`) so all
traffic is forced onto the TCP HTTP(S) paths the SSRF proxy actually sees, and
documents WebRTC neutralization as part of the deployment contract (not just an
in-process default). Belt-and-suspenders with §8.

### 8. Container-level egress firewalling as defense-in-depth

The SSRF proxy is **application-level** — a compromised renderer with native
sockets can ignore it. So the container should **also** restrict egress at the
network layer (a default-deny egress policy / firewall to the app's allowlisted
destinations, or running behind an explicit egress proxy with no direct route to
link-local/metadata/RFC-1918). This is the network mirror of §6's filesystem
confinement: the in-process SSRF layer is the precise control, the network policy
is the coarse backstop for when native code bypasses it. Cloud metadata endpoints
(`169.254.169.254`) must be unreachable at this layer regardless.

### 9. How it composes with the in-process spine

Defense-in-depth, two boundaries:

| Threat | In-process (ADR 0006) | Container/kernel (this ADR) |
| --- | --- | --- |
| Agent drives toward a blocked host | action gate + Tier-1 routes + DNS-pinning proxy | egress firewall (§8); metadata unreachable |
| DNS-rebinding an allowlisted host | Tier-2 proxy re-pins per request | egress firewall (§8) |
| Secret in an artifact | redact-before-write everywhere | read-only FS + minimal mounts (§6) |
| Exfiltrate a local file via upload | upload-dir path confinement | read-only FS; only mounted dirs exist (§6) |
| **Renderer RCE → raw sockets** | *(bypassed)* | sandbox (§1–2), egress policy (§8), no QUIC/WebRTC (§7) |
| **Renderer RCE → host FS / pivot** | *(bypassed)* | read-only FS (§6), cap_drop ALL (§4), non-root + no-new-privs (§3), seccomp (§5) |

The bottom two rows are exactly what this ADR adds: the in-process layer assumes
the documented APIs; the container layer assumes those are bypassed.

## Illustrative profile (not a shipped file)

```yaml
# docker-compose snippet — the OPERATOR's production profile, not the dev harness.
services:
  sackville-browser-mcp:
    image: sackville-browser-mcp        # FROM mcr.microsoft.com/playwright:v1.60.0-noble
    user: "pwuser"                     # non-root (§3)
    read_only: true                    # read-only rootfs (§6)
    cap_drop: ["ALL"]                  # no ambient caps (§4)
    security_opt:
      - "no-new-privileges:true"       # (§3)
      - "seccomp=./seccomp-chromium.json"  # default-derived, sandbox-permitting (§5)
    shm_size: "1g"                     # Chromium /dev/shm (§6); NOT --ipc=host
    tmpfs: ["/tmp"]                    # writable scratch + user-data-dir (§6)
    volumes:
      - artifacts:/var/sackville/artifacts   # the only writable persistence (§6)
    environment:
      SACKVILLE_BROWSER_ALLOWED_HOSTS: "app.example.com"
      # SACKVILLE_BROWSER_NO_SANDBOX stays UNSET — keep the sandbox (§1)
    # egress restricted to the allowlist at the network layer (§8)
```

`# --disable-quic` and the existing WebRTC arg are passed by the bin's launch
args in the hardened profile (§7).

## Consequences

- **Kernel-dependent.** The most-hardened path (unprivileged userns + sandbox +
  dropped `SYS_ADMIN`) requires a host kernel/policy that allows unprivileged
  user namespaces. Where that is unavailable, operators fall back to `SYS_ADMIN`
  (broad) or `--no-sandbox` (worst) — both **documented downgrades**, not the
  default.
- **`--no-sandbox` residual risk** (carried over from ADR 0006): removes the
  in-Chromium renderer/host barrier; only acceptable with the full container
  profile applied and the risk explicitly accepted. Re-examined if the container
  trust boundary changes.
- **`/dev/shm` is a real operational footgun** — the default 64 MB crashes
  Chromium under load; `--shm-size` (preferred) or `--disable-dev-shm-usage` must
  be set. We avoid `--ipc=host` despite its convenience because it weakens
  isolation.
- **Profile is image-coupled.** The seccomp profile and sandbox behavior are
  validated against the pinned Playwright image; a `playwright-core`/image bump is
  a **milestone change** that re-validates this profile, in lockstep with ADR
  0006's binary-pinning rule.
- **Operator burden.** This is deployment configuration the operator must apply;
  Sackville ships the launch flags (`--no-sandbox` gating, WebRTC arg, `--disable-
  quic` in the hardened profile) but cannot enforce the host-level mounts, seccomp,
  caps, or egress policy from inside the process. The ADR is the contract; CI/Docs
  reference it.
- **Defense-in-depth, not redundancy.** The network egress policy (§8) overlaps
  the SSRF proxy *by design* — they cover different failure modes (documented-API
  vs native-code bypass), so keeping both is intentional, not duplication.
