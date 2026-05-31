const VAR_RE = /\{\{\s*([^}\s]+)\s*\}\}/g

/**
 * Interpolate `{{name}}` placeholders from a variable scope. Unknown names are
 * left intact (so callers can detect them). Secret resolution is layered on
 * later, at the transport boundary.
 */
export function interpolate(template: string, scope: Record<string, unknown>): string {
  return template.replace(VAR_RE, (match, name: string) => {
    const value = scope[name]
    return value === undefined ? match : String(value)
  })
}
