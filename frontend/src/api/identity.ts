/**
 * 房间身份恢复（v2，02-state-contract.md §4）。
 *
 * 只在 sessionStorage 按房间码保存：participantId / resumeToken / roomInstanceId。
 * 不写 URL、日志或邀请链接；凭据与房间实例绑定，重建同码房间不继承。
 */
import type { JoinResponse } from './client'

export interface StoredIdentity {
  participantId?: string
  resumeToken?: string
  roomInstanceId?: string
}

const identityKey = (code: string) => `anitexas:identity:${code.toUpperCase()}`

export function loadIdentity(code: string): StoredIdentity | null {
  try {
    const raw = window.sessionStorage.getItem(identityKey(code))
    return raw ? (JSON.parse(raw) as StoredIdentity) : null
  } catch {
    return null
  }
}

export function saveIdentity(code: string, r: JoinResponse): void {
  try {
    window.sessionStorage.setItem(
      identityKey(code),
      JSON.stringify({
        participantId: r.participantId,
        resumeToken: r.resumeToken,
        roomInstanceId: r.roomInstanceId,
      } satisfies StoredIdentity),
    )
  } catch {
    // 隐私模式/配额满：仅本次会话有效，不影响入座
  }
}
