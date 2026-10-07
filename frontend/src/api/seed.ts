/**
 * 可验证发牌（commit-reveal）本地验证（Web Crypto）。
 *
 * 编码契约：固证 sha256 = SHA-256(seed 的 UTF-8 字节) 的 hex 小写串。
 * 摊牌收 seedReveal{seed} 后本地重算哈希与开局 seedCommit{sha256} 比对——
 * 一致即「发牌前已承诺、摊牌后未篡改」；全程不发网络请求，纯客户端验证。
 */

/** SHA-256 摘要 → hex 小写 */
export async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('Web Crypto 不可用（需 secure context）')
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 验证揭示种子是否匹配开局固证（大小写不敏感比对） */
export async function verifySeedCommit(seed: string, commit: string): Promise<boolean> {
  const hex = await sha256Hex(seed)
  return hex.toLowerCase() === commit.trim().toLowerCase()
}
