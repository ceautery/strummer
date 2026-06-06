import { execFile } from 'node:child_process'
import { resolve } from 'node:path'

/**
 * Build the child env for a spawned project tool: prepend the project's own
 * `<cwd>/node_modules/.bin` to PATH. Without this a bare `vitest`/`pytest`/
 * `stryker`/`mutmut`/`cosmic-ray` is resolved only from the *invoking* shell's
 * PATH — so a gated runner invoked from a **global** `sackville-cli` (whose PATH
 * does not include the target project's `.bin`) fails to start the tool and dies
 * with an opaque "did not produce a report". Returns a fresh env; never mutates
 * the input.
 *
 * Shared by `@sackville-mcp/coverage`, `@sackville-mcp/flake`, and
 * `@sackville-mcp/mutate` — every pillar that spawns a project-local tool.
 */
export function runnerEnv(cwd: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const localBin = resolve(cwd, 'node_modules', '.bin')
  const sep = process.platform === 'win32' ? ';' : ':'
  const current = env.PATH
  return { ...env, PATH: current ? `${localBin}${sep}${current}` : localBin }
}

/**
 * The shape of a spawned tool runner: take an argv + run options, resolve with the
 * child's exit code and captured streams. It **never rejects on a non-zero exit** —
 * a tool exiting non-zero on a test/lint/mutation failure is data, not an error.
 * The verification pillars accept this as an injected seam so the green gate never
 * spawns a real tool (ADR 0010); the pillars alias it to their own public name
 * (`TestRunner` / `MutationRunner`).
 */
export type SpawnedRunner = (
  argv: string[],
  opts: { cwd: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

/**
 * The default live runner: spawn `command` as a subprocess with the project-local
 * `node_modules/.bin` on PATH (via {@link runnerEnv}), surfacing the exit code
 * instead of rejecting. Used by the server bins / CLI — never in the green gate
 * (the gate injects a fake {@link SpawnedRunner}).
 */
export function spawnRunner(command: string): SpawnedRunner {
  return (argv, opts) =>
    new Promise((res) => {
      execFile(
        command,
        argv,
        {
          cwd: opts.cwd,
          timeout: opts.timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
          env: runnerEnv(opts.cwd),
        },
        (err, stdout, stderr) => {
          // The tool exits non-zero on a test/mutation failure — surface the code, don't reject.
          const code =
            err && typeof (err as { code?: unknown }).code === 'number'
              ? (err as { code: number }).code
              : err
                ? 1
                : 0
          res({ exitCode: code, stdout: String(stdout), stderr: String(stderr) })
        },
      )
    })
}
