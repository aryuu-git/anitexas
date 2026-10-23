// @vitest-environment happy-dom
// 大厅页（体验重构 T5）：昵称共用与校验、预设/自定义、内联建房、统一加入预览、
// 房间列表三态与刷新失败保留旧结果。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ApiClientError, listRooms, previewRoom, createRoom, joinRoom, type RoomSummary } from '../api/client'
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
  return {
    ApiClientError,
    listRooms: vi.fn(),
    previewRoom: vi.fn(),
    createRoom: vi.fn(),
    joinRoom: vi.fn(),
  }
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
  status: 'waiting',
  phase: 'waiting',
  handSeq: 0,
  humanCount: 2,
  botCount: 1,
  joinable: true,
}

const NICK_INPUT = '你的昵称'

beforeEach(() => {
  navigate.mockClear()
  window.localStorage.clear()
  window.sessionStorage.clear()
  vi.mocked(listRooms).mockResolvedValue([])
  vi.mocked(previewRoom).mockResolvedValue(ROOM)
  vi.mocked(createRoom).mockReset()
  vi.mocked(joinRoom).mockReset()
})

afterEach(cleanup)

/** 数字输入（aria-label 命名） */
const numberInput = (name: string) => screen.getByRole('spinbutton', { name }) as HTMLInputElement
/** 打开建房配置（朋友房 / 练习房） */
const openCreate = (kind: 'friend' | 'practice' = 'friend') =>
  fireEvent.click(screen.getByTestId(kind === 'practice' ? 'start-practice' : 'start-friend'))
/** 输入昵称 */
const typeNick = (value: string) => fireEvent.change(screen.getByLabelText(NICK_INPUT), { target: { value } })

describe('LobbyPage 昵称', () => {
  it('建房/加入共用昵称；昵称为空时聚焦字段并提示', () => {
    render(<LobbyPage />)
    openCreate()
    fireEvent.click(screen.getByRole('button', { name: '创建房间' }))
    expect(screen.getByTestId('nick-error').textContent).toBe('请先填写昵称')
    expect(document.activeElement).toBe(screen.getByLabelText(NICK_INPUT))
  })

  it('昵称超过 12 个 Unicode 字符时拒绝提交', () => {
    render(<LobbyPage />)
    typeNick('一二三四五六七八九十一二三')
    openCreate()
    fireEvent.click(screen.getByRole('button', { name: '创建房间' }))
    expect(screen.getByTestId('nick-error').textContent).toContain('最长 12 个字')
  })

  it('提交成功后昵称写入 localStorage，createRoom 携带 trim 后的昵称', async () => {
    vi.mocked(createRoom).mockResolvedValue({ ...ROOM, code: 'NEW001' })
    vi.mocked(joinRoom).mockResolvedValue({
      ticket: 't1',
      seat: 0,
      room: { ...ROOM, code: 'NEW001' },
    })
    render(<LobbyPage />)
    typeNick('  小樱  ')
    openCreate()
    fireEvent.click(screen.getByRole('button', { name: '创建房间' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/room/NEW001', expect.anything()))
    expect(window.localStorage.getItem('anitexas:nick')).toBe('小樱')
    expect(vi.mocked(createRoom).mock.calls[0][0]).toEqual(
      expect.objectContaining({ nick: '小樱', roomKind: 'friend', botPolicy: 'off', nextHandPolicy: 'manual' }),
    )
  })
})

describe('LobbyPage 房间类型与摘要', () => {
  it('朋友房默认机器人关闭、手动开始，摘要与提交配置一致', () => {
    render(<LobbyPage />)
    openCreate('friend')
    expect(numberInput('座位数').value).toBe('4')
    expect(numberInput('期望参局人数').value).toBe('2')
    expect(screen.getByTestId('create-summary').textContent).toContain('朋友房 · 4 座')
    expect(screen.getByTestId('create-summary').textContent).toContain('机器人关闭')
    expect(screen.getByTestId('create-summary').textContent).toContain('房主手动开始')
  })

  it('练习房显示机器人数量，并可明示选择自动续局', () => {
    render(<LobbyPage />)
    openCreate('practice')
    expect(screen.getByTestId('create-summary').textContent).toContain('机器人 3 位')
    fireEvent.click(screen.getByRole('button', { name: '自动续局' }))
    expect(screen.getByTestId('create-summary').textContent).toContain('自动续局')
  })

  it('返回入口不清空昵称', () => {
    render(<LobbyPage />)
    typeNick('小樱')
    openCreate()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect((screen.getByLabelText(NICK_INPUT) as HTMLInputElement).value).toBe('小樱')
  })
})

describe('LobbyPage 高级设置折叠', () => {
  it('默认收起：展开后出现微调项与牌池策略', () => {
    render(<LobbyPage />)
    openCreate()
    const toggle = screen.getByTestId('advanced-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('spinbutton', { name: '最低标注数' })).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(numberInput('最低标注数')).toBeTruthy()
    expect(screen.getByTestId('deck-strategy-field')).toBeTruthy()
    expect(screen.getByRole('switch', { name: /开放牌桌聊天/ })).toBeTruthy()
  })
})

describe('LobbyPage 统一加入流程', () => {
  it('输入房间码先预览摘要，确认后才 join 并跳转', async () => {
    vi.mocked(joinRoom).mockResolvedValue({
      ticket: 't2',
      seat: 2,
      room: { ...ROOM, code: 'SAKURA' },
    })
    render(<LobbyPage />)
    typeNick('阿光')
    fireEvent.change(screen.getByLabelText('房间码'), { target: { value: 'sakura' } })
    fireEvent.click(screen.getByRole('button', { name: '查看并加入' }))
    expect(await screen.findByTestId('join-preview')).toBeTruthy()
    expect(vi.mocked(previewRoom).mock.calls[0][0]).toBe('SAKURA')
    expect(vi.mocked(joinRoom)).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '加入准备室' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/room/SAKURA', expect.anything()))
    expect(vi.mocked(joinRoom).mock.calls[0][1]).toEqual(
      expect.objectContaining({ nick: '阿光' }),
    )
  })

  it('房间不存在时显示可重试的错误，不进入预览', async () => {
    vi.mocked(previewRoom).mockRejectedValue(new ApiClientError({ code: 'room_not_found', msg: '房间不存在或已解散' }))
    render(<LobbyPage />)
    typeNick('阿光')
    fireEvent.change(screen.getByLabelText('房间码'), { target: { value: 'NOPE00' } })
    fireEvent.click(screen.getByRole('button', { name: '查看并加入' }))
    expect(await screen.findByTestId('join-preview-error')).toBeTruthy()
    expect(screen.queryByTestId('join-preview')).toBeNull()
  })

  it('列表「查看」与输入房间码共用预览流程', async () => {
    vi.mocked(listRooms).mockResolvedValue([ROOM])
    render(<LobbyPage />)
    expect(await screen.findByText('SAKURA')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看 SAKURA' }))
    expect(await screen.findByTestId('join-preview')).toBeTruthy()
    expect(vi.mocked(previewRoom)).toHaveBeenCalledWith('SAKURA')
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

  it('空态：「还没有开放房间，创建一桌吧」', async () => {
    render(<LobbyPage />)
    const empty = await screen.findByTestId('rooms-empty')
    expect(empty.textContent).toBe('还没有开放房间，创建一桌吧')
    expect(screen.queryByTestId('rooms-loading')).toBeNull()
  })

  it('首载失败：独立错误通道 + 重新加载', async () => {
    vi.mocked(listRooms).mockRejectedValue(new ApiClientError({ code: 'internal', msg: '房间列表挂了' }))
    render(<LobbyPage />)
    const err = await screen.findByTestId('room-list-error')
    expect(err.textContent).toBe('房间列表挂了')
    expect(screen.queryByTestId('form-error')).toBeNull()
    expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy()
  })

  it('刷新失败保留上次成功列表并显示「更新失败」', async () => {
    vi.mocked(listRooms).mockResolvedValueOnce([ROOM])
    render(<LobbyPage />)
    expect(await screen.findByText('SAKURA')).toBeTruthy()

    vi.mocked(listRooms).mockRejectedValueOnce(new ApiClientError({ code: 'internal', msg: '刷新失败' }))
    fireEvent.click(screen.getByTestId('rooms-refresh'))
    expect(await screen.findByTestId('room-list-stale')).toBeTruthy()
    expect(screen.getByText('SAKURA')).toBeTruthy()
  })
})
