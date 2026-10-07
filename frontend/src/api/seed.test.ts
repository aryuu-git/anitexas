// seed 验证纯逻辑（Web Crypto）：已知向量 + 比对语义（大小写不敏感）。
import { describe, it, expect } from 'vitest'
import { sha256Hex, verifySeedCommit } from './seed'

describe('seed.ts 固证哈希', () => {
  it('sha256Hex 对齐已知向量（SHA-256("abc")）', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('verifySeedCommit：匹配通过、换种子失败', async () => {
    const commit = await sha256Hex('anitexas-mock-seed-2026')
    expect(await verifySeedCommit('anitexas-mock-seed-2026', commit)).toBe(true)
    expect(await verifySeedCommit('anitexas-mock-seed-2027', commit)).toBe(false)
  })

  it('固证比对大小写不敏感（服务端 hex 大小写无关）', async () => {
    const commit = await sha256Hex('abc')
    expect(await verifySeedCommit('abc', commit.toUpperCase())).toBe(true)
  })
})
