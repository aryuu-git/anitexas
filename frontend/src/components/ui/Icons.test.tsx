// @vitest-environment happy-dom
// 图标精灵：新增 close / chevronLeft / chevronRight 字形（命名契约被其他 slice 直接消费）。
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Icon } from './Icons'

describe('Icons 新增字形', () => {
  it('close / chevronLeft / chevronRight 渲染非空路径', () => {
    const { container } = render(
      <>
        <Icon name="close" />
        <Icon name="chevronLeft" />
        <Icon name="chevronRight" />
      </>,
    )
    const svgs = container.querySelectorAll('svg')
    expect(svgs.length).toBe(3)
    svgs.forEach((svg) => expect(svg.innerHTML.length).toBeGreaterThan(0))
  })
})
