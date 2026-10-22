/**
 * 大厅昵称（docs/experience-handoff/01-product-design.md §2）。
 *
 * 建房与加入共用同一个昵称；trim 后 1–12 个 Unicode 字符（按码点计数，与后端
 * `len([]rune(nick))` 一致）。昵称偏好存 localStorage；房间身份凭据不放这里。
 */

const NICK_STORAGE_KEY = 'anitexas:nick'

export const NICK_MAX_CHARS = 12

/** 按 Unicode 码点计长（emoji 等代理对不重复计数） */
export function nickLength(nick: string): number {
  return [...nick.trim()].length
}

/** 校验昵称；合法返回 null，否则返回字段下错误文案 */
export function validateNick(nick: string): string | null {
  const n = nick.trim()
  if (n.length === 0) return '请先填写昵称'
  if (nickLength(n) > NICK_MAX_CHARS) return `昵称最长 ${NICK_MAX_CHARS} 个字`
  return null
}

/** 读取昵称偏好（无记录/隐私模式 → 空串） */
export function loadNick(): string {
  try {
    return window.localStorage.getItem(NICK_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

/** 保存昵称偏好（提交成功时调用；失败不影响建房/加入） */
export function saveNick(nick: string): void {
  try {
    window.localStorage.setItem(NICK_STORAGE_KEY, nick.trim())
  } catch {
    // 隐私模式/配额满：仅本次会话有效
  }
}
