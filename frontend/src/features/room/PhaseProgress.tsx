import type { PhaseStep } from '../../api/experienceState'

/**
 * 阶段进度（对局页第二区）：四轮下注一条线，当前轮高亮。
 * 提前结束未发生的轮次标「跳过」，全下直发标「全下发牌」——不把未发生的阶段标成完成。
 */
export interface PhaseProgressProps {
  steps: PhaseStep[]
  handSeq: number
  runout?: boolean
}

const STATUS_TEXT: Record<PhaseStep['status'], string | null> = {
  done: '已完成',
  current: '进行中',
  pending: '未开始',
  skipped: '跳过',
}

export function PhaseProgress({ steps, handSeq, runout = false }: PhaseProgressProps) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-panel border border-gold/15 bg-panel px-4 py-3 shadow-panel md:px-6"
      data-testid="phase-progress"
    >
      <span className="font-serif text-body-lg text-gold-light">第 {handSeq} 手</span>
      <ol className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5">
        {steps.map((step, i) => {
          const statusText = STATUS_TEXT[step.status]
          return (
            <li key={step.key} className="flex items-center gap-2" data-testid={`phase-step-${step.key}`} data-status={step.status}>
              {i > 0 && <span className="h-px w-4 bg-gold/25 md:w-6" aria-hidden="true" />}
              <span
                className={`flex h-5 w-5 flex-none items-center justify-center rounded-chip border text-micro ${
                  step.status === 'current'
                    ? 'border-gold-foil bg-gold-foil/20 text-gold-foil'
                    : step.status === 'done'
                      ? 'border-gold/40 text-gold-light'
                      : step.status === 'skipped'
                        ? 'border-gold/15 text-muted/60'
                        : 'border-gold/15 text-muted'
                }`}
                aria-hidden="true"
              >
                {step.status === 'done' ? '✓' : i + 1}
              </span>
              <span
                className={`text-body ${
                  step.status === 'current'
                    ? 'text-gold-foil'
                    : step.status === 'skipped'
                      ? 'text-muted/60 line-through'
                      : step.status === 'done'
                        ? 'text-gold-light/80'
                        : 'text-muted'
                }`}
              >
                {step.label}
              </span>
              {statusText && step.status !== 'pending' && (
                <span className="text-micro text-muted">（{statusText}）</span>
              )}
            </li>
          )
        })}
      </ol>
      {runout && (
        <span className="rounded-chip border border-gold-foil/50 bg-gold-foil/15 px-2.5 py-0.5 text-micro text-gold-foil">
          全下发牌
        </span>
      )}
    </div>
  )
}
