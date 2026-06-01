/**
 * Tracks resolved secret values and scrubs them (and common encodings) from any
 * text returned to the agent. Replacement is exact-substring, so no value ever
 * leaks through logs, bodies, headers, or error text. Shared by both pillars
 * (the API runner and the browser artifact/dry-run paths).
 */
export class Redactor {
  private readonly entries: { name: string; encodings: string[] }[] = []

  register(name: string, value: string): void {
    if (!value) return
    const encodings = [
      value,
      Buffer.from(value, 'utf8').toString('base64'),
      encodeURIComponent(value),
    ].filter((e) => e.length > 0)
    this.entries.push({ name, encodings: [...new Set(encodings)] })
  }

  redact(text: string): string {
    let out = text
    for (const { name, encodings } of this.entries) {
      for (const encoding of encodings) {
        out = out.split(encoding).join(`[redacted:${name}]`)
      }
    }
    return out
  }

  redactHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) out[key] = this.redact(value)
    return out
  }
}
