import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { bruToJsonV2 } from '@usebruno/lang'
import { parse as parseYaml } from 'yaml'
import type { BrowserAssertionResult, BrowserAssertionSpec } from './assertions.js'
import type { PageDriver, StepResult, WouldRequest } from './driver.js'

/**
 * Persisted, replayable browser **flows** — `.bru` + sidecar (ROADMAP Phase 3;
 * mirrors ADR 0004's API-pillar pattern). A Bruno-openable `<name>.bru` carries
 * the flow's meta (its name); the colocated `<name>.sackville.yml` sidecar holds
 * the ordered **steps**. Steps key off **semantic locators** (`role` + optional
 * accessible `name` + `nth`), NOT the ephemeral per-snapshot refs — so a flow is
 * stable across runs. `{{var}}` / `{{secret:NAME}}` interpolation is resolved at
 * run time (see `runFlow`), exactly as in the API pillar.
 */

/** A snapshot-independent element locator: `getByRole(role,{name}).nth(nth)`. */
export interface SemanticLocator {
  role: string
  name?: string
  /** Disambiguate when several elements share role+name. Default 0 (the first). */
  nth?: number
}

export type WaitState = 'attached' | 'detached' | 'visible' | 'hidden'

/** One step in a persisted flow. */
export type FlowStep =
  | { action: 'navigate'; url: string }
  | { action: 'click'; target: SemanticLocator }
  | { action: 'fill'; target: SemanticLocator; value: string }
  | { action: 'select'; target: SemanticLocator; values: string | string[] }
  | { action: 'press'; target?: SemanticLocator; key: string }
  | { action: 'wait_for'; target: SemanticLocator; state?: WaitState; timeout?: number }
  | { action: 'assert'; assertions: BrowserAssertionSpec[] }

export interface BrowserFlow {
  name: string
  steps: FlowStep[]
}

export interface FlowCollection {
  dir: string
  /** Flows keyed by name (meta.name, falling back to the .bru filename stem). */
  flows: Map<string, BrowserFlow>
}

// Collection/folder-level .bru files are settings, not flows.
const NON_FLOW = new Set(['collection.bru', 'folder.bru'])

interface BruJson {
  meta?: { name?: string }
}

interface Sidecar {
  steps?: unknown[]
}

/** Pull a `{role, name?, nth?}` locator out of a raw step object (role required). */
function toTarget(raw: Record<string, unknown>, action: string): SemanticLocator {
  const role = raw.role
  if (typeof role !== 'string' || role === '') {
    throw new Error(`flow step "${action}" requires a string "role"`)
  }
  const target: SemanticLocator = { role }
  if (typeof raw.name === 'string') target.name = raw.name
  if (typeof raw.nth === 'number') target.nth = raw.nth
  return target
}

/** A flow step in the sidecar is a single-key object: `{ <action>: <value> }`. */
function parseStep(raw: unknown, index: number): FlowStep {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`flow step #${index + 1} must be a single-key object like { click: {...} }`)
  }
  const keys = Object.keys(raw as Record<string, unknown>)
  if (keys.length !== 1) {
    throw new Error(
      `flow step #${index + 1} must have exactly one action key, got: ${keys.join(', ')}`,
    )
  }
  const action = keys[0] as string
  const value = (raw as Record<string, unknown>)[action]

  switch (action) {
    case 'navigate': {
      if (typeof value !== 'string') throw new Error('flow step "navigate" requires a URL string')
      return { action, url: value }
    }
    case 'click': {
      return { action, target: toTarget(value as Record<string, unknown>, action) }
    }
    case 'fill': {
      const o = (value ?? {}) as Record<string, unknown>
      if (typeof o.value !== 'string') throw new Error('flow step "fill" requires a string "value"')
      return { action, target: toTarget(o, action), value: o.value }
    }
    case 'select': {
      const o = (value ?? {}) as Record<string, unknown>
      const ok =
        typeof o.values === 'string' ||
        (Array.isArray(o.values) && o.values.every((v) => typeof v === 'string'))
      if (!ok) throw new Error('flow step "select" requires "values" (a string or string[])')
      return { action, target: toTarget(o, action), values: o.values as string | string[] }
    }
    case 'press': {
      const o = (value ?? {}) as Record<string, unknown>
      if (typeof o.key !== 'string') throw new Error('flow step "press" requires a string "key"')
      // role optional: press on a target element, or on the page when omitted
      const target = typeof o.role === 'string' ? toTarget(o, action) : undefined
      return { action, key: o.key, ...(target ? { target } : {}) }
    }
    case 'wait_for': {
      const o = (value ?? {}) as Record<string, unknown>
      const step: Extract<FlowStep, { action: 'wait_for' }> = {
        action,
        target: toTarget(o, action),
      }
      if (typeof o.state === 'string') step.state = o.state as WaitState
      if (typeof o.timeout === 'number') step.timeout = o.timeout
      return step
    }
    case 'assert': {
      if (!Array.isArray(value))
        throw new Error('flow step "assert" requires an array of assertions')
      return { action, assertions: value as BrowserAssertionSpec[] }
    }
    default:
      throw new Error(`unknown step action "${action}" in flow step #${index + 1}`)
  }
}

/** Load a single persisted flow from its `<name>.bru` (+ `<name>.sackville.yml`). */
export function loadFlow(bruPath: string): BrowserFlow {
  const stem = basename(bruPath, '.bru')
  const parsed = bruToJsonV2(readFileSync(bruPath, 'utf8')) as BruJson
  const name = parsed.meta?.name ?? stem

  const sidecarPath = bruPath.replace(/\.bru$/, '.sackville.yml')
  if (!existsSync(sidecarPath)) {
    throw new Error(`flow "${stem}" has no ${stem}.sackville.yml sidecar (the steps live there)`)
  }
  const sidecar = (parseYaml(readFileSync(sidecarPath, 'utf8')) ?? {}) as Sidecar
  const steps = (sidecar.steps ?? []).map((raw, i) => parseStep(raw, i))
  return { name, steps }
}

/** Load every flow in a directory, keyed by name (skips collection/folder .bru). */
export function loadFlowCollection(dir: string): FlowCollection {
  const flows = new Map<string, BrowserFlow>()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.bru') || NON_FLOW.has(file)) continue
    const flow = loadFlow(join(dir, file))
    flows.set(flow.name, flow)
  }
  return { dir, flows }
}

// ── Running a flow ────────────────────────────────────────────────────────────

// `{{var}}` (no colon → not a secret ref) and `{{secret:NAME}}`.
const VAR_REF = /\{\{\s*([^}\s:]+)\s*\}\}/g
const SECRET_REF = /\{\{\s*secret:\s*([^}\s]+)\s*\}\}/g

export interface RunFlowOptions {
  /** Values for `{{var}}` interpolation (e.g. `baseUrl`). */
  vars?: Record<string, unknown>
  /** Resolve a `{{secret:NAME}}` to the operator secret (fail-closed on unknown).
   * Used for input data (fill/select values, the navigate URL) — the driver's
   * redactor scrubs the cleartext from every result. Omit to disable secret refs. */
  resolveSecret?: (name: string) => string | undefined
}

export interface FlowStepResult {
  action: string
  /** False only when the step threw (gate deny, locator timeout, …); an assertion
   * that simply did not hold is `ok:true` with `assertions[].pass=false`. */
  ok: boolean
  error?: string
  /** True when the mutation ran in dry-run (gate not unlocked) — nothing executed. */
  dryRun?: boolean
  wouldRequest?: WouldRequest | null
  /** Assertion outcomes (for an `assert` step). Observed values are redacted. */
  assertions?: BrowserAssertionResult[]
}

export interface FlowResult {
  name: string
  /** True iff every step ran without error AND every assertion held. */
  passed: boolean
  steps: FlowStepResult[]
}

/** Interpolate `{{var}}` from `vars` (unknown names left intact). */
function interpolateVars(s: string, vars: Record<string, unknown>): string {
  return s.replace(VAR_REF, (m, name: string) => (name in vars ? String(vars[name]) : m))
}

/** Carry the gate's dry-run preview onto a step result, when present. */
function dryRunFields(r: StepResult): Pick<FlowStepResult, 'dryRun' | 'wouldRequest'> {
  return r.dryRun ? { dryRun: true, wouldRequest: r.wouldRequest ?? null } : {}
}

async function runStep(
  driver: PageDriver,
  step: FlowStep,
  opts: RunFlowOptions,
): Promise<FlowStepResult> {
  const vars = opts.vars ?? {}
  // Data fields (URL, fill/select values): interpolate vars THEN resolve secrets.
  const resolveData = (s: string): string => {
    const withVars = interpolateVars(s, vars)
    return withVars.replace(SECRET_REF, (_m, name: string) => {
      const v = opts.resolveSecret?.(name)
      if (v === undefined)
        throw new Error(`unknown secret "${name}" — not configured by the operator`)
      return v
    })
  }

  switch (step.action) {
    case 'navigate':
      return {
        action: step.action,
        ok: true,
        ...dryRunFields(await driver.navigate(resolveData(step.url))),
      }
    case 'click':
      return { action: step.action, ok: true, ...dryRunFields(await driver.clickAt(step.target)) }
    case 'fill':
      return {
        action: step.action,
        ok: true,
        ...dryRunFields(await driver.fillAt(step.target, resolveData(step.value))),
      }
    case 'select': {
      const values = Array.isArray(step.values)
        ? step.values.map(resolveData)
        : resolveData(step.values)
      return {
        action: step.action,
        ok: true,
        ...dryRunFields(await driver.selectAt(step.target, values)),
      }
    }
    case 'press':
      return {
        action: step.action,
        ok: true,
        ...dryRunFields(await driver.pressAt(step.target ?? null, step.key)),
      }
    case 'wait_for':
      await driver.waitFor({
        role: step.target.role,
        name: step.target.name,
        nth: step.target.nth,
        state: step.state,
        timeout: step.timeout,
      })
      return { action: step.action, ok: true }
    case 'assert': {
      // Interpolate vars into string expected-values; do NOT resolve secrets here
      // (a cleartext `expected` would surface unredacted — assert against vars).
      const specs = step.assertions.map((a) =>
        typeof a.value === 'string' ? { ...a, value: interpolateVars(a.value, vars) } : a,
      )
      return { action: step.action, ok: true, assertions: await driver.assert(specs) }
    }
  }
}

/**
 * Replay a persisted flow against a live `PageDriver`. Steps run sequentially;
 * `{{var}}`/`{{secret:NAME}}` are resolved per step. A step that throws (gate
 * deny, locator timeout) stops the flow and is reported `ok:false`; an assertion
 * that does not hold leaves the step `ok:true` but fails the overall flow. The
 * driver's gate (dry-run vs execute) and redactor apply exactly as in a live
 * session — so unlocking execution + an allowlisted host are the operator's call.
 */
export async function runFlow(
  driver: PageDriver,
  flow: BrowserFlow,
  opts: RunFlowOptions = {},
): Promise<FlowResult> {
  const steps: FlowStepResult[] = []
  let passed = true
  for (const step of flow.steps) {
    try {
      const result = await runStep(driver, step, opts)
      steps.push(result)
      if (!result.ok || result.assertions?.some((a) => !a.pass)) passed = false
    } catch (err) {
      steps.push({ action: step.action, ok: false, error: (err as Error).message })
      passed = false
      break // sequential flow: later steps depend on this one having succeeded
    }
  }
  return { name: flow.name, passed, steps }
}
