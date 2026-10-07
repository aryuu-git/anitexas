// 牌桌 v2 布局回归：座位椭圆投影、朝向、注堆方向、筹码面额分层、头像首字。
import { describe, it, expect } from 'vitest'
import {
  TABLE_RX,
  TABLE_RY,
  betOffset,
  chipLayers,
  initialOf,
  seatAngle,
  seatFacing,
  seatPosition,
} from './tableLayout'

describe('seatPosition 桌位定位', () => {
  it('4 座（mySeat=0）：下 / 左 / 上 / 右', () => {
    const p = (i: number) => seatPosition(i, 0, 4)
    expect(p(0).x).toBeCloseTo(50)
    expect(p(0).y).toBeCloseTo(50 + TABLE_RY)
    expect(p(1).x).toBeCloseTo(50 - TABLE_RX)
    expect(p(1).y).toBeCloseTo(50)
    expect(p(2).x).toBeCloseTo(50)
    expect(p(2).y).toBeCloseTo(50 - TABLE_RY)
    expect(p(3).x).toBeCloseTo(50 + TABLE_RX)
    expect(p(3).y).toBeCloseTo(50)
  })

  it('mySeat 恒在正下方，其余不越椭圆半径', () => {
    for (const total of [2, 4, 6, 9, 10]) {
      for (let my = 0; my < total; my++) {
        const self = seatPosition(my, my, total)
        expect(self.x).toBeCloseTo(50)
        expect(self.y).toBeCloseTo(50 + TABLE_RY)
        for (let i = 0; i < total; i++) {
          const { x, y } = seatPosition(i, my, total)
          expect(x).toBeGreaterThanOrEqual(50 - TABLE_RX - 1e-9)
          expect(x).toBeLessThanOrEqual(50 + TABLE_RX + 1e-9)
          expect(y).toBeGreaterThanOrEqual(50 - TABLE_RY - 1e-9)
          expect(y).toBeLessThanOrEqual(50 + TABLE_RY + 1e-9)
        }
      }
    }
  })

  it('total<=0：回落中心', () => {
    expect(seatPosition(0, 0, 0)).toEqual({ x: 50, y: 50 })
  })
})

describe('seatAngle / seatFacing', () => {
  it('自己恒在 90°（正下方），4 座为 下/左/上/右', () => {
    for (const total of [2, 4, 6, 10]) {
      for (let my = 0; my < total; my++) expect(seatAngle(my, my, total)).toBeCloseTo(90)
    }
    expect(seatAngle(1, 0, 4)).toBeCloseTo(180)
    expect(seatAngle(2, 0, 4)).toBeCloseTo(270)
    expect(seatAngle(3, 0, 4)).toBeCloseTo(0)
  })

  it('远侧（桌心上方）座位朝向 -1', () => {
    expect(seatFacing(0, 0, 4)).toBe(1)
    expect(seatFacing(1, 0, 4)).toBe(1)
    expect(seatFacing(2, 0, 4)).toBe(-1)
    expect(seatFacing(3, 0, 4)).toBe(1)
  })
})

describe('betOffset 注堆方向', () => {
  it('近侧座位注堆朝上（dy<0、dx≈0）', () => {
    const o = betOffset(0, 0, 4)
    expect(o.dy).toBeLessThan(0)
    expect(o.dx).toBeCloseTo(0)
  })
  it('远侧座位注堆朝下（dy>0）', () => {
    expect(betOffset(2, 0, 4).dy).toBeGreaterThan(0)
  })
  it('左侧座位注堆朝右（dx>0）', () => {
    expect(betOffset(1, 0, 4).dx).toBeGreaterThan(0)
  })
})

describe('chipLayers 面额分层', () => {
  it('拆成降序面额（137 = 100+25+5×2+1×2）', () => {
    expect(chipLayers(137)).toEqual([
      { denom: 100, count: 1 },
      { denom: 25, count: 1 },
      { denom: 5, count: 2 },
      { denom: 1, count: 2 },
    ])
  })
  it('0 / 负数 → 空数组', () => {
    expect(chipLayers(0)).toEqual([])
    expect(chipLayers(-5)).toEqual([])
  })
  it('层数上限生效', () => {
    expect(chipLayers(999999, 2).length).toBe(2)
  })
})

describe('initialOf 头像首字', () => {
  it('取首字大写、跳过 bot 前缀、空串兜底', () => {
    expect(initialOf('aryuu')).toBe('A')
    expect(initialOf('bot·樱')).toBe('樱')
    expect(initialOf('')).toBe('?')
  })
})
