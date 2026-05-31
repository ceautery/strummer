import {
  getQuickJS,
  type QuickJSWASMModule,
  shouldInterruptAfterDeadline,
} from 'quickjs-emscripten'
import type { ScriptTest } from './model.js'

export type { ScriptTest } from './model.js'

export interface ScriptResponseView {
  status: number
  headers: Record<string, string>
  body: string
  json: unknown
}

export interface ScriptResult {
  /** The full variable scope after the script ran (incl. `bru.setVar` writes). */
  vars: Record<string, unknown>
  tests: ScriptTest[]
  logs: string[]
  /** A top-level (non-`test`) error thrown by the script, if any. */
  error?: string
}

const TIMEOUT_MS = 1000

// Curated API injected into the sandbox. No host bindings — everything is plain
// data, exchanged as JSON, so the only thing crossing the WASM boundary is text.
const PRELUDE = `
globalThis.console = { log: (...a) => __logs.push(a.map(String).join(' ')), error: (...a) => __logs.push(a.map(String).join(' ')) };
globalThis.bru = {
  getVar: (k) => __vars[k],
  setVar: (k, v) => { __vars[k] = v; },
};
function __mk(actual) {
  const fail = (m) => { throw new Error(m); };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return {
    toBe: (e) => { if (actual !== e) fail('expected ' + JSON.stringify(actual) + ' to be ' + JSON.stringify(e)); },
    toEqual: (e) => { if (!eq(actual, e)) fail('expected ' + JSON.stringify(actual) + ' to equal ' + JSON.stringify(e)); },
    toContain: (e) => { if (!String(actual).includes(String(e))) fail('expected ' + JSON.stringify(actual) + ' to contain ' + JSON.stringify(e)); },
    toBeGreaterThan: (e) => { if (!(actual > e)) fail('expected ' + actual + ' > ' + e); },
    toBeLessThan: (e) => { if (!(actual < e)) fail('expected ' + actual + ' < ' + e); },
    toBeTruthy: () => { if (!actual) fail('expected truthy, got ' + JSON.stringify(actual)); },
    toBeFalsy: () => { if (actual) fail('expected falsy, got ' + JSON.stringify(actual)); },
  };
}
globalThis.expect = (actual) => __mk(actual);
globalThis.test = (name, fn) => {
  try { fn(); __tests.push({ name: name, pass: true }); }
  catch (e) { __tests.push({ name: name, pass: false, error: String((e && e.message) || e) }); }
};
`

let modulePromise: Promise<QuickJSWASMModule> | undefined
function quickjs(): Promise<QuickJSWASMModule> {
  if (!modulePromise) modulePromise = getQuickJS()
  return modulePromise
}

/**
 * Run a pre/post-request script in a QuickJS WASM sandbox with the curated
 * `bru`/`expect`/`test`/`console` API and a wall-clock interrupt. The script
 * sees `res` (post-response only) and reads/writes variables via `bru`; nothing
 * from the host process is reachable.
 */
export async function runScript(
  code: string,
  context: { vars: Record<string, unknown>; res?: ScriptResponseView },
): Promise<ScriptResult> {
  const QuickJS = await quickjs()
  const runtime = QuickJS.newRuntime()
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + TIMEOUT_MS))
  const vm = runtime.newContext()

  try {
    const init =
      `globalThis.__vars = ${JSON.stringify(context.vars)};` +
      'globalThis.__tests = [];' +
      'globalThis.__logs = [];' +
      `globalThis.res = ${context.res ? JSON.stringify(context.res) : 'undefined'};` +
      PRELUDE
    const setup = vm.evalCode(init)
    if (setup.error) {
      const message = vm.dump(setup.error)
      setup.error.dispose()
      throw new Error(`script sandbox setup failed: ${JSON.stringify(message)}`)
    }
    setup.value.dispose()

    let error: string | undefined
    const run = vm.evalCode(code)
    if (run.error) {
      const dumped = vm.dump(run.error)
      run.error.dispose()
      error =
        typeof dumped === 'object' && dumped?.message ? String(dumped.message) : String(dumped)
    } else {
      run.value.dispose()
    }

    const read = vm.evalCode('JSON.stringify({ vars: __vars, tests: __tests, logs: __logs })')
    let data = { vars: context.vars, tests: [] as ScriptTest[], logs: [] as string[] }
    if (read.error) {
      read.error.dispose()
    } else {
      data = JSON.parse(vm.dump(read.value))
      read.value.dispose()
    }

    return { vars: data.vars ?? {}, tests: data.tests ?? [], logs: data.logs ?? [], error }
  } finally {
    vm.dispose()
    runtime.dispose()
  }
}
