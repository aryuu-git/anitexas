import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Icon, type IconName } from './Icons'

/**
 * 统一按钮（A5.3 五状态契约）：
 * hover（提亮 + 上浮）/ active（回缩）/ focus-visible（金粉焦点环）/
 * disabled（半透明 + 禁点）/ loading（旋标 + 锁定不可重点）。
 * 视觉延续规则书描金按钮族；状态样式只允许来自本组件与 token。
 */
export type ButtonVariant = 'gold' | 'outline' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** 加载态：图标旋转、按钮锁定（loading 时自动 disabled 语义） */
  loading?: boolean
  /** 左侧图标 */
  icon?: IconName
  children?: ReactNode
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  gold: 'text-ink bg-gold-gradient shadow-glow hover:brightness-110',
  outline:
    'text-gold-light border border-gold/50 bg-transparent hover:border-gold hover:bg-gold/10 hover:shadow-glow',
  ghost: 'text-muted bg-transparent hover:text-gold-light hover:bg-gold/5',
  danger:
    'text-danger border border-danger/40 bg-danger/10 hover:bg-danger/20 hover:border-danger/60',
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-body',
  md: 'px-6 py-2.5 text-body-lg',
  lg: 'px-7 py-3 text-body-lg',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'gold',
    size = 'md',
    loading = false,
    icon,
    className = '',
    disabled,
    children,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled ?? loading
  // data-state 暴露五状态（loading > disabled > ready；hover/active/focus 为 CSS 交互态）
  const state = loading ? 'loading' : isDisabled ? 'disabled' : 'ready'
  return (
    <button
      ref={ref}
      type="button"
      disabled={isDisabled}
      aria-busy={loading || undefined}
      data-state={state}
      className={`relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-sans font-medium
        transition-[transform,border-color,box-shadow,background-color,opacity] duration-fast ease-standard
        hover:-translate-y-px hover:brightness-110
        active:translate-y-0 active:brightness-100
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70 focus-visible:ring-offset-2 focus-visible:ring-offset-ink
        disabled:pointer-events-none disabled:opacity-50 disabled:hover:translate-y-0
        ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...rest}
    >
      {loading ? (
        <span
          className="inline-block h-4 w-4 animate-spin rounded-chip border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      ) : icon ? (
        <Icon name={icon} size={size === 'sm' ? 15 : 18} />
      ) : null}
      {children}
    </button>
  )
})
