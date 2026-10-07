import { memo, useState } from 'react'
import { verifySeedCommit } from '../api/seed'

/**
 * 可验证发牌徽章（commit-reveal）：开局收 seedCommit → 「发牌已固证」小徽章；
 * 摊牌收 seedReveal → 「验证」按钮本地算 SHA-256（Web Crypto）与固证比对，
 * 通过/失败明确反馈（不发网络请求）。
 */

/** 验证状态机：idle 未验 / pending 计算中 / pass 通过 / fail 失败 */
export type VerifyState = 'idle' | 'pending' | 'pass' | 'fail'

export interface SeedBadgeProps {
  /** 本手固证（SHA-256(seed) hex 小写）；null = 未收到固证，不展示徽章 */
  seedCommit: string | null
  /** 摊牌揭示的种子；null = 未到摊牌，「验证」按钮不出现 */
  seedReveal: string | null
}

const VERIFY_LABEL: Record<VerifyState, string> = {
  idle: '验证',
  pending: '验证中…',
  pass: '验证通过 · 发牌未被篡改',
  fail: '验证失败 · 种子与固证不符',
}

export const SeedBadge = memo(function SeedBadge({ seedCommit, seedReveal }: SeedBadgeProps) {
  const [verify, setVerify] = useState<VerifyState>('idle')
  // 固证/种子换手后验证结论即失效（以提交值记账，避免残留上一手的结论）
  const [verifiedPair, setVerifiedPair] = useState<string | null>(null)
  const pair = seedCommit && seedReveal ? `${seedCommit}:${seedReveal}` : null
  const shown: VerifyState = verifiedPair === pair ? verify : 'idle'

  const onVerify = async () => {
    if (!seedCommit || !seedReveal || shown === 'pending') return
    setVerify('pending')
    setVerifiedPair(pair)
    const ok = await verifySeedCommit(seedReveal, seedCommit)
    setVerify(ok ? 'pass' : 'fail')
  }

  if (!seedCommit) return null

  return (
    <div
      data-testid="seed-badge"
      data-verify={shown}
      className="inline-flex items-center gap-2 rounded-chip border border-gold-foil/45 bg-gold-foil/10 px-3 py-1.5"
    >
      <span className="text-micro text-gold-foil">发牌已固证</span>
      {seedReveal && (
        <button
          type="button"
          onClick={() => void onVerify()}
          disabled={shown === 'pending'}
          className="rounded-chip border border-gold/30 bg-ink-deep/40 px-2.5 py-1 text-micro text-gold-light transition-[transform,border-color,background-color,opacity] duration-fast ease-standard hover:-translate-y-px hover:border-gold/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70 disabled:pointer-events-none disabled:opacity-40"
        >
          {VERIFY_LABEL[shown === 'pass' || shown === 'fail' ? 'idle' : shown]}
        </button>
      )}
      {shown === 'pass' && (
        <span className="text-micro text-gold-foil" data-testid="verify-result">
          {VERIFY_LABEL.pass}
        </span>
      )}
      {shown === 'fail' && (
        <span className="text-micro text-danger" data-testid="verify-result">
          {VERIFY_LABEL.fail}
        </span>
      )}
    </div>
  )
})
