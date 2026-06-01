import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { auditDeprecation, type Packument } from './deprecation.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(here, '../test/fixtures')

function loadPackument(name: string): Packument {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8')) as Packument
}

describe('auditDeprecation — installed-version deprecation verdict', () => {
  const request = loadPackument('request-packument.json')
  const lodash = loadPackument('lodash-packument.json')

  it('reports a version-scoped deprecation, and it wins over a package-level one', () => {
    expect(auditDeprecation(request, '2.88.2')).toEqual({
      isDeprecated: true,
      message: 'this specific build of request@2.88.2 is deprecated',
      scope: 'version',
    })
  })

  it('falls back to the package-level message when the installed version has none', () => {
    expect(auditDeprecation(request, '2.88.0')).toEqual({
      isDeprecated: true,
      message: 'request has been deprecated, see https://github.com/request/request/issues/3142',
      scope: 'package',
    })
  })

  it('reports not-deprecated for a clean packument', () => {
    expect(auditDeprecation(lodash, '4.17.21')).toEqual({ isDeprecated: false })
  })

  it('treats an empty deprecated string as not deprecated (npm un-deprecate idiom)', () => {
    const undeprecated: Packument = {
      name: 'x',
      deprecated: '   ',
      versions: { '1.0.0': { version: '1.0.0', deprecated: '' } },
    }
    expect(auditDeprecation(undeprecated, '1.0.0')).toEqual({ isDeprecated: false })
  })
})
