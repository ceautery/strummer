import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { matchVulnerabilities, type OsvAdvisory } from './osv.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(here, '../test/fixtures')

function loadAdvisories(name: string): OsvAdvisory[] {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8')) as OsvAdvisory[]
}

const npm = (name: string) => ({ ecosystem: 'npm', name })

describe('matchVulnerabilities — installed-version OSV range matching', () => {
  const lodash = loadAdvisories('lodash-osv.json')

  it('matches every advisory whose fix is after the installed version', () => {
    const matches = matchVulnerabilities(lodash, npm('lodash'), '4.17.11')
    expect(matches.map((m) => m.id).sort()).toEqual(['GHSA-35jh-r3h4-6jhm', 'GHSA-jf85-cpcp-j695'])
  })

  it('excludes an advisory once the installed version reaches its fixed version (exclusive)', () => {
    const matches = matchVulnerabilities(lodash, npm('lodash'), '4.17.15')
    expect(matches).toEqual([
      {
        id: 'GHSA-35jh-r3h4-6jhm',
        aliases: ['CVE-2021-23337'],
        summary: 'Command injection in lodash',
        severity: 'moderate',
        fixedIn: ['4.17.21'],
      },
    ])
  })

  it('reports nothing once the installed version is at/after every fix', () => {
    expect(matchVulnerabilities(lodash, npm('lodash'), '4.17.21')).toEqual([])
  })

  it('ignores advisories for a different package or ecosystem', () => {
    expect(matchVulnerabilities(lodash, npm('underscore'), '4.17.11')).toEqual([])
    expect(matchVulnerabilities(lodash, { ecosystem: 'PyPI', name: 'lodash' }, '4.17.11')).toEqual(
      [],
    )
  })

  it('honours a last_affected event (inclusive upper bound) and reports unknown severity', () => {
    const advisories: OsvAdvisory[] = [
      {
        id: 'OSV-LAST',
        summary: 'affects up to and including 2.0.0',
        affected: [
          {
            package: { ecosystem: 'npm', name: 'widget' },
            ranges: [
              { type: 'SEMVER', events: [{ introduced: '1.0.0' }, { last_affected: '2.0.0' }] },
            ],
          },
        ],
      },
    ]
    expect(matchVulnerabilities(advisories, npm('widget'), '2.0.0')).toEqual([
      {
        id: 'OSV-LAST',
        aliases: [],
        summary: 'affects up to and including 2.0.0',
        severity: 'unknown',
        fixedIn: [],
      },
    ])
    expect(matchVulnerabilities(advisories, npm('widget'), '2.0.1')).toEqual([])
    expect(matchVulnerabilities(advisories, npm('widget'), '0.9.0')).toEqual([])
  })

  it('matches an explicitly enumerated affected version', () => {
    const advisories: OsvAdvisory[] = [
      {
        id: 'OSV-ENUM',
        affected: [
          {
            package: { ecosystem: 'npm', name: 'gadget' },
            versions: ['1.2.3', '1.2.4'],
            database_specific: { severity: 'CRITICAL' },
          },
        ],
      },
    ]
    expect(matchVulnerabilities(advisories, npm('gadget'), '1.2.3')[0]?.severity).toBe('critical')
    expect(matchVulnerabilities(advisories, npm('gadget'), '1.2.5')).toEqual([])
  })
})
