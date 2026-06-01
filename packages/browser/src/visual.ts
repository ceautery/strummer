import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

/**
 * Visual-regression comparison for the browser pillar (ROADMAP Phase 3; ADR 0006).
 * A deterministic pixel diff over two PNGs via **pixelmatch** (`pngjs` decodes the
 * bytes to RGBA). This is the engine half of `toHaveScreenshot`: capture a stable
 * screenshot (`animations:'disabled'`, `caret:'hide'`), compare it against a
 * baseline, and gate on a pixel-diff budget.
 *
 * The engine is **pure and deterministic** (same inputs → same verdict), so it is
 * green-gate safe. The flake-prone part — **committing** cross-platform baselines —
 * is deliberately NOT done here: baselines are operator-managed and meant to be
 * generated inside the pinned Playwright Docker image, keyed by (name, browser,
 * platform). See ADR 0006 Consequences + ADR 0007.
 */

/** A rectangle (in image pixels) to ignore — for dynamic regions (timestamps, etc.). */
export interface VisualMaskRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CompareScreenshotsOptions {
  /** pixelmatch per-pixel color sensitivity, 0..1 (default 0.1; lower = stricter). */
  threshold?: number
  /** Max allowed differing pixels as a ratio of the total (default 0). */
  maxDiffPixelRatio?: number
  /** Max allowed differing pixels, absolute. When both this and the ratio are set,
   * BOTH budgets must hold. */
  maxDiffPixels?: number
  /** Rectangles ignored in BOTH images before the compare (dynamic content). */
  mask?: VisualMaskRect[]
  /** Produce the rendered diff PNG in the result (default true). */
  includeDiff?: boolean
}

export interface VisualComparison {
  pass: boolean
  diffPixels: number
  totalPixels: number
  diffPixelRatio: number
  /** True when the two images have different dimensions — an automatic fail
   * (a pixel-by-pixel compare is undefined). No diff PNG is produced. */
  sizeMismatch: boolean
  width: number
  height: number
  /** PNG bytes highlighting the differing pixels (omitted on size mismatch or
   * when `includeDiff` is false). */
  diffPng?: Buffer
}

/** Paint every masked rectangle a constant color in `data` (RGBA, row-major). */
function applyMask(data: Buffer, width: number, height: number, mask: VisualMaskRect[]): void {
  for (const r of mask) {
    const x0 = Math.max(0, Math.floor(r.x))
    const y0 = Math.max(0, Math.floor(r.y))
    const x1 = Math.min(width, Math.floor(r.x + r.width))
    const y1 = Math.min(height, Math.floor(r.y + r.height))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4
        data[i] = 0
        data[i + 1] = 0
        data[i + 2] = 0
        data[i + 3] = 255
      }
    }
  }
}

/**
 * Compare a captured screenshot against a baseline. Decodes both PNGs, optionally
 * blanks masked regions in both, runs pixelmatch, and decides pass/fail against the
 * pixel-diff budget. Different dimensions are a hard fail (`sizeMismatch`).
 */
export function compareScreenshots(
  actual: Buffer,
  baseline: Buffer,
  opts: CompareScreenshotsOptions = {},
): VisualComparison {
  const a = PNG.sync.read(actual)
  const b = PNG.sync.read(baseline)

  if (a.width !== b.width || a.height !== b.height) {
    return {
      pass: false,
      diffPixels: 0,
      totalPixels: a.width * a.height,
      diffPixelRatio: 1,
      sizeMismatch: true,
      width: a.width,
      height: a.height,
    }
  }

  const { width, height } = a
  if (opts.mask?.length) {
    // Blank the same rects in both → pixelmatch sees them identical there.
    applyMask(a.data, width, height, opts.mask)
    applyMask(b.data, width, height, opts.mask)
  }

  const totalPixels = width * height
  const includeDiff = opts.includeDiff ?? true
  const diff = includeDiff ? new PNG({ width, height }) : undefined
  const diffPixels = pixelmatch(a.data, b.data, diff?.data, width, height, {
    threshold: opts.threshold ?? 0.1,
  })
  const diffPixelRatio = totalPixels === 0 ? 0 : diffPixels / totalPixels

  // Budget: ratio always applies (default 0); the absolute cap applies when set.
  const maxRatio = opts.maxDiffPixelRatio ?? 0
  const withinRatio = diffPixelRatio <= maxRatio
  const withinAbsolute = opts.maxDiffPixels === undefined || diffPixels <= opts.maxDiffPixels
  const pass = withinRatio && withinAbsolute

  return {
    pass,
    diffPixels,
    totalPixels,
    diffPixelRatio,
    sizeMismatch: false,
    width,
    height,
    ...(diff ? { diffPng: PNG.sync.write(diff) } : {}),
  }
}
