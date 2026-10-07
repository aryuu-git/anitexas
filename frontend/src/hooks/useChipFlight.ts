import { useEffect, useRef, useState } from 'react'
import type { SeatState } from '../api/types'
import { TABLE_H, TABLE_W, betOffset, seatPosition } from '../components/tableLayout'

/**
 * 筹码飞行：底池增加时，为每个「有注」的座位生成一枚从注堆飞向桌心底池的筹码。
 * 坐标在牌桌坐标系内计算（%位置 + px 位移），避免舞台缩放导致错位。
 * 一次性：460ms 后清空。
 */
export interface ChipFlight {
  id: number
  /** 起点（相对牌桌的百分比） */
  x: number
  y: number
  /** 位移（px，牌桌坐标系） */
  fx: number
  fy: number
}

export function useChipFlight(pot: number, seats: SeatState[], mySeat: number): ChipFlight[] {
  const [flights, setFlights] = useState<ChipFlight[]>([])
  const prev = useRef(pot)
  const seatsRef = useRef(seats)
  const mySeatRef = useRef(mySeat)
  seatsRef.current = seats
  mySeatRef.current = mySeat

  useEffect(() => {
    const before = prev.current
    prev.current = pot
    if (pot <= before) return

    const list = seatsRef.current
    const total = list.length
    const stamp = Date.now()
    const next: ChipFlight[] = []
    list.forEach((s, i) => {
      if (s.bet <= 0) return
      const { x, y } = seatPosition(s.seat, mySeatRef.current, total)
      const { dx, dy } = betOffset(s.seat, mySeatRef.current, total)
      const sx = x + dx
      const sy = y + dy
      next.push({
        id: stamp + i,
        x: sx,
        y: sy,
        fx: ((50 - sx) / 100) * TABLE_W,
        fy: ((50 - sy) / 100) * TABLE_H,
      })
    })
    if (next.length === 0) return
    setFlights(next)
    const timer = window.setTimeout(() => setFlights([]), 460)
    return () => window.clearTimeout(timer)
  }, [pot])

  return flights
}
