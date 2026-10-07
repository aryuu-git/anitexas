import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 轻音效（D15）：Web Audio 合成，六种，无二进制音源。
 *   deal 发牌 / bet 下注 / reveal 揭示 / showdown 亮牌 / yourTurn 轮到你 / win 赢局
 * 音量克制：master gain ≤ 0.22；默认有声（A5 裁决），静音开关 localStorage 记忆。
 * AudioContext 首次用户手势后惰性创建（浏览器自动播放策略）。
 */

export type SoundName = 'deal' | 'bet' | 'reveal' | 'showdown' | 'yourTurn' | 'win'

/** 静音开关的 localStorage 键 */
const MUTE_KEY = 'anitexas.muted'

/** 合成一个短音符（三角波 + 快速衰减包络） */
function tone(
  ctx: AudioContext,
  dest: GainNode,
  freqFrom: number,
  freqTo: number,
  startAt: number,
  dur: number,
  gain: number,
) {
  const osc = ctx.createOscillator()
  const env = ctx.createGain()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(freqFrom, ctx.currentTime + startAt)
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, freqTo), ctx.currentTime + startAt + dur)
  env.gain.setValueAtTime(gain, ctx.currentTime + startAt)
  env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startAt + dur)
  osc.connect(env).connect(dest)
  osc.start(ctx.currentTime + startAt)
  osc.stop(ctx.currentTime + startAt + dur + 0.02)
}

/** 合成一段短噪声（发牌的纸感） */
function noise(ctx: AudioContext, dest: GainNode, startAt: number, dur: number, gain: number) {
  const frames = Math.floor(ctx.sampleRate * dur)
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames)
  const src = ctx.createBufferSource()
  const env = ctx.createGain()
  src.buffer = buf
  env.gain.setValueAtTime(gain, ctx.currentTime + startAt)
  env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startAt + dur)
  src.connect(env).connect(dest)
  src.start(ctx.currentTime + startAt)
}

/** 六种音效的合成配方（克制：低增益、短促） */
function playInto(ctx: AudioContext, master: GainNode, name: SoundName) {
  switch (name) {
    case 'deal':
      noise(ctx, master, 0, 0.12, 0.35)
      tone(ctx, master, 620, 320, 0, 0.1, 0.18)
      return
    case 'bet':
      tone(ctx, master, 220, 130, 0, 0.09, 0.35)
      return
    case 'reveal':
      tone(ctx, master, 420, 840, 0, 0.18, 0.22)
      return
    case 'showdown':
      tone(ctx, master, 523, 523, 0, 0.3, 0.2)
      tone(ctx, master, 659, 659, 0.02, 0.32, 0.16)
      tone(ctx, master, 784, 784, 0.04, 0.36, 0.13)
      return
    case 'yourTurn':
      tone(ctx, master, 660, 660, 0, 0.1, 0.2)
      tone(ctx, master, 880, 880, 0.12, 0.14, 0.18)
      return
    case 'win':
      tone(ctx, master, 523, 523, 0, 0.16, 0.2)
      tone(ctx, master, 659, 659, 0.12, 0.16, 0.18)
      tone(ctx, master, 784, 784, 0.24, 0.16, 0.18)
      tone(ctx, master, 1046, 1046, 0.36, 0.4, 0.2)
      return
    default:
      return
  }
}

/** 解析 AudioContext 构造器（含旧版 Safari vendor 前缀；无实现返回 undefined） */
function resolveAudioContext(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined
  if ('AudioContext' in window) return window.AudioContext
  if ('webkitAudioContext' in window) {
    // 旧版 Safari 的 vendor 前缀实现：类型库未声明该属性，按同构 API 断言
    const legacy = window as unknown as { webkitAudioContext?: typeof AudioContext }
    return legacy.webkitAudioContext
  }
  return undefined
}

export interface SoundControls {
  /** 静音状态（默认 false = 有声，A5 验收裁决） */
  muted: boolean
  toggleMuted: () => void
  /** 播放轻音效（静音中为 no-op） */
  play: (name: SoundName) => void
}

/** 对局桌音效控制：静音开关 + 六种合成音效。
 *  默认有声（A5 验收裁决）：未显式设过偏好时静音关闭；localStorage 记忆开关。 */
export function useSound(): SoundControls {
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem(MUTE_KEY) === '1'
    } catch {
      return false
    }
  })
  const ctxRef = useRef<AudioContext | null>(null)
  const masterRef = useRef<GainNode | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0')
    } catch {
      // 隐私模式等场景无 localStorage：忽略持久化
    }
  }, [muted])

  const play = useCallback(
    (name: SoundName) => {
      if (muted) return
      // 惰性创建 AudioContext（需在用户手势后；失败则静默降级）
      if (!ctxRef.current) {
        const Ctor = resolveAudioContext()
        if (!Ctor) return
        ctxRef.current = new Ctor()
        const master = ctxRef.current.createGain()
        // 音量克制（D15）：master ≤ 0.22
        master.gain.value = 0.22
        master.connect(ctxRef.current.destination)
        masterRef.current = master
      }
      const ctx = ctxRef.current
      const master = masterRef.current
      if (!ctx || !master) return
      if (ctx.state === 'suspended') void ctx.resume()
      playInto(ctx, master, name)
    },
    [muted],
  )

  const toggleMuted = useCallback(() => setMuted((v) => !v), [])

  return { muted, toggleMuted, play }
}
