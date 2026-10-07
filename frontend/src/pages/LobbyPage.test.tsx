// @vitest-environment happy-dom
// 大厅页（表单分层 + 房间列表三态）：快速建局预设一键套用、高级设置折叠展开/收起、
// 房间列表 loading / 空态 / 错误（独立通道，不借用建房表单 formError）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ApiClientError, listRooms, type RoomSummary } from '../api/client'
import { LobbyPage } from './LobbyPage'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }))
vi.mock('./RoomPage', () => ({ default: () => null }))
vi.mock('../api/client', () => {
  class ApiClientError extends Error {
    code: string

    constructor(body: { code: string; msg: string }) {
      super(body.msg)
      this.code = body.code
    }
  }
  return { ApiClientError, listRooms: vi.fn(), createRoom: vi.fn(), joinRoom: vi.fn() }
})

const ROOM: RoomSummary = {
  code: 'SAKURA',
  host: '墨镜',
  autoReveal: false,
  smallBlind: 1,
  bigBlind: 2,
  seats: 6,
  players: 3,
  revealRate: 0,
}

beforeEach(() => {
  navigate.mockClear()
  vi.mocked(listRooms).mockResolvedValue([])
})

afterEach(cleanup)

/** 数字输入（aria-label 命名） */
const numberInput = (name: string) => screen.getByRole('spinbutton', { name }) as HTMLInputElement
/** 开关卡片（role=switch，名称带标题文案） */
const switchCard = (title: RegExp) => screen.getByRole('switch', { name: title })

describe('LobbyPage 快速建局预设', () => {
  it('休闲预设一键套用 4 座 / 盲注 1-2 / 隐藏揭示 / 费率 0（覆盖已改动的值）', () => {
    render(<LobbyPage />)
    // 先把表单改乱：揭示方式打开、座位 9、费率 3
    fireEvent.click(switchCard(/开局自动展开要素/))
    fireEvent.click(screen.getByTestId('advanced-toggle'))
    fireEvent.change(numberInput('座位数'), { target: { value: '9' } })
    fireEvent.change(numberInput('揭示费率'), { target: { value: '3' } })

    fireEvent.click(screen.getByTestId('preset-casual'))
    expect(numberInput('小盲').value).toBe('1')
    expect(numberInput('大盲').value).toBe('2')
    expect(numberInput('座位数').value).toBe('4')
    expect(numberInput('揭示费率').value).toBe('0')
    expect(switchCard(/开局自动展开要素/).getAttribute('aria-checked')).toBe('false')
  })

  it('标准预设一键套用 6 座 / 盲注 5-10 / 隐藏揭示 / 费率 0', () => {
    render(<LobbyPage />)
    fireEvent.click(screen.getByTestId('preset-standard'))
    expect(numberInput('小盲').value).toBe('5')
    expect(numberInput('大盲').value).toBe('10')
    fireEvent.click(screen.getByTestId('advanced-toggle'))
    expect(numberInput('座位数').value).toBe('6')
    expect(numberInput('揭示费率').value).toBe('0')
  })
})

describe('LobbyPage 高级设置折叠', () => {
  it('默认收起：微调项不渲染；展开后出现、再点收起', () => {
    render(<LobbyPage />)
    const toggle = screen.getByTestId('advanced-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('spinbutton', { name: '座位数' })).toBeNull()
    expect(screen.queryByRole('spinbutton', { name: '最低标注数' })).toBeNull()
    expect(screen.queryByTestId('deck-strategy-field')).toBeNull()
    expect(screen.queryByRole('switch', { name: /开放牌桌聊天/ })).toBeNull()

    fireEvent.click(toggle)
    expect(screen.getByTestId('advanced-toggle').getAttribute('aria-expanded')).toBe('true')
    expect(numberInput('座位数')).toBeTruthy()
    expect(numberInput('最低标注数')).toBeTruthy()
    expect(screen.getByTestId('deck-strategy-field')).toBeTruthy()
    expect(switchCard(/开放牌桌聊天/)).toBeTruthy()

    fireEvent.click(screen.getByTestId('advanced-toggle'))
    expect(screen.getByTestId('advanced-toggle').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('spinbutton', { name: '座位数' })).toBeNull()
    expect(screen.queryByRole('switch', { name: /开放牌桌聊天/ })).toBeNull()
  })
})

describe('LobbyPage 房间列表三态', () => {
  it('loading：骨架 + 「加载中…」', () => {
    vi.mocked(listRooms).mockReturnValue(new Promise<RoomSummary[]>(() => {}))
    render(<LobbyPage />)
    expect(screen.getByTestId('rooms-loading').textContent).toContain('加载中…')
    expect(screen.queryByTestId('rooms-empty')).toBeNull()
    expect(screen.queryByTestId('room-list-error')).toBeNull()
  })

  it('空态：「暂无房间，建一个吧」', async () => {
    vi.mocked(listRooms).mockResolvedValue([])
    render(<LobbyPage />)
    const empty = await screen.findByTestId('rooms-empty')
    expect(empty.textContent).toBe('暂无房间，建一个吧')
    expect(screen.queryByTestId('rooms-loading')).toBeNull()
  })

  it('错误：独立通道报错，不借用建房表单 formError', async () => {
    vi.mocked(listRooms).mockRejectedValue(new ApiClientError({ code: 'internal', msg: '房间列表挂了' }))
    render(<LobbyPage />)
    const err = await screen.findByTestId('room-list-error')
    expect(err.textContent).toBe('房间列表挂了')
    expect(screen.queryByTestId('form-error')).toBeNull()
    expect(screen.queryByTestId('rooms-loading')).toBeNull()
  })

  it('就绪：渲染房间行，点击带房内配置入桌', async () => {
    vi.mocked(listRooms).mockResolvedValue([ROOM])
    render(<LobbyPage />)
    expect(await screen.findByText('SAKURA')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /SAKURA/ }))
    expect(navigate).toHaveBeenCalledWith(
      '/room/SAKURA',
      expect.objectContaining({
        state: expect.objectContaining({ smallBlind: 1, bigBlind: 2, seats: 6, autoReveal: false }),
      }),
    )
  })
})
