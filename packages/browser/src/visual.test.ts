import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import { compareScreenshots } from './visual.js'

/** Build a solid-color RGBA PNG of the given size. */
function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rgba[0]
    png.data[i * 4 + 1] = rgba[1]
    png.data[i * 4 + 2] = rgba[2]
    png.data[i * 4 + 3] = rgba[3]
  }
  return PNG.sync.write(png)
}

/** A solid white PNG with one rectangle painted black. */
function pngWithRect(
  width: number,
  height: number,
  rect: { x: number; y: number; w: number; h: number },
): Buffer {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const inRect = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
      const v = inRect ? 0 : 255
      png.data[i] = v
      png.data[i + 1] = v
      png.data[i + 2] = v
      png.data[i + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

describe('compareScreenshots — pixelmatch over decoded PNGs', () => {
  const WHITE: [number, number, number, number] = [255, 255, 255, 255]

  it('passes with zero diff on identical images', () => {
    const a = solidPng(20, 20, WHITE)
    const r = compareScreenshots(a, solidPng(20, 20, WHITE))
    expect(r.pass).toBe(true)
    expect(r.diffPixels).toBe(0)
    expect(r.diffPixelRatio).toBe(0)
    expect(r.sizeMismatch).toBe(false)
    expect(r.totalPixels).toBe(400)
  })

  it('fails when pixels differ and surfaces a diff PNG', () => {
    const baseline = solidPng(20, 20, WHITE)
    const actual = pngWithRect(20, 20, { x: 0, y: 0, w: 4, h: 4 }) // 16 black pixels
    const r = compareScreenshots(actual, baseline)
    expect(r.pass).toBe(false)
    expect(r.diffPixels).toBe(16)
    expect(r.diffPixelRatio).toBeCloseTo(16 / 400, 5)
    // a real PNG diff image is produced (PNG magic)
    expect(r.diffPng?.subarray(0, 4).toString('hex')).toBe('89504e47')
  })

  it('tolerates a small diff under maxDiffPixelRatio', () => {
    const baseline = solidPng(20, 20, WHITE)
    const actual = pngWithRect(20, 20, { x: 0, y: 0, w: 4, h: 4 }) // 16/400 = 0.04
    const r = compareScreenshots(actual, baseline, { maxDiffPixelRatio: 0.05 })
    expect(r.pass).toBe(true)
    expect(r.diffPixels).toBe(16)
  })

  it('ignores a masked region (dynamic content)', () => {
    const baseline = solidPng(20, 20, WHITE)
    const actual = pngWithRect(20, 20, { x: 0, y: 0, w: 4, h: 4 })
    // masking the changed rect makes the comparison pass
    const r = compareScreenshots(actual, baseline, {
      mask: [{ x: 0, y: 0, width: 4, height: 4 }],
    })
    expect(r.pass).toBe(true)
    expect(r.diffPixels).toBe(0)
  })

  it('hard-fails on a size mismatch (no pixel compare possible)', () => {
    const r = compareScreenshots(solidPng(20, 20, WHITE), solidPng(30, 20, WHITE))
    expect(r.pass).toBe(false)
    expect(r.sizeMismatch).toBe(true)
    expect(r.diffPng).toBeUndefined()
  })

  it('omits the diff PNG when includeDiff is false', () => {
    const a = pngWithRect(20, 20, { x: 0, y: 0, w: 4, h: 4 })
    const r = compareScreenshots(a, solidPng(20, 20, WHITE), { includeDiff: false })
    expect(r.pass).toBe(false)
    expect(r.diffPng).toBeUndefined()
  })
})
