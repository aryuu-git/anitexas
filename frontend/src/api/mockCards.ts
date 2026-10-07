/**
 * mock 桌面夹具：真实作品 + 规则书同款要素（仅演示 UI 全流程，不参与规则判定）。
 *
 * 注：要素取值按规则书示例与公开常识填写，供 CardFace 芯片展示；
 * 牌型/成组由假服务端（mockDesk）硬编码下发——判定在 backend/internal/engine（D6）。
 */
import type { BoxCard, CardData, SettledPayload, ShowdownHand, ThemeFilter } from './types'

// ===== 公共牌（5 张，翻牌 3 + 转牌 1 + 河牌 1）=====
export const C103_CLANNAD: CardData = {
  id: 103,
  title: 'CLANNAD',
  score: 8.4,
  bucket: 8.5,
  year: 2007,
  monogram: 'C',
}
export const C104_KON: CardData = {
  id: 104,
  title: '轻音少女',
  score: 8.3,
  bucket: 8.5,
  year: 2009,
  monogram: '轻',
}
export const C105_STEINSGATE: CardData = {
  id: 105,
  title: '命运石之门',
  score: 9.0,
  bucket: 9.0,
  year: 2011,
  monogram: '命',
}
export const C112_PSYCHOPASS: CardData = {
  id: 112,
  title: '心理测量者',
  score: 8.1,
  bucket: 8.0,
  year: 2012,
  monogram: '心',
}
export const C121_SHIROBAKO: CardData = {
  id: 121,
  title: '白箱',
  score: 8.4,
  bucket: 8.5,
  year: 2015,
  monogram: '箱',
}

// ===== 底牌 =====
export const C101_KIMINONAWA: CardData = {
  id: 101,
  title: '你的名字。',
  score: 8.4,
  bucket: 8.5,
  year: 2016,
  monogram: '你',
}
export const C102_TENKINOKO: CardData = {
  id: 102,
  title: '天气之子',
  score: 7.3,
  bucket: 7.5,
  year: 2019,
  monogram: '天',
}
export const C115_BUNGO: CardData = {
  id: 115,
  title: '文豪野犬',
  score: 7.8,
  bucket: 8.0,
  year: 2016,
  monogram: '文',
}
export const C116_E7: CardData = {
  id: 116,
  title: '交响诗篇',
  score: 7.9,
  bucket: 8.0,
  year: 2005,
  monogram: '交',
}
export const C113_KAGUYA: CardData = {
  id: 113,
  title: '辉夜大小姐想让我告白',
  score: 8.4,
  bucket: 8.5,
  year: 2019,
  monogram: '辉',
}
export const C114_NAGI: CardData = {
  id: 114,
  title: '来自风平浪静的明天',
  score: 7.1,
  bucket: 7.0,
  year: 2013,
  monogram: '风',
}
export const C117_NATSUME: CardData = {
  id: 117,
  title: '夏目友人帐',
  score: 8.7,
  bucket: 8.5,
  year: 2008,
  monogram: '夏',
}
export const C118_SHINGEKI: CardData = {
  id: 118,
  title: '进击的巨人',
  score: 8.9,
  bucket: 9.0,
  year: 2013,
  monogram: '巨',
}

/** 要素表：cardId → 要素清单（揭示前不下发，由 revealed/showdown 事件带出） */
export const ELEMENTS: Record<number, CardData['elements']> = {
  101: [
    { class: 1, value: '新海诚' },
    { class: 2, value: 'CoMix Wave' },
    { class: 3, value: '恋爱' },
    { class: 4, value: '2016' },
    { class: 5, value: '原创' },
  ],
  102: [
    { class: 1, value: '新海诚' },
    { class: 2, value: 'CoMix Wave' },
    { class: 3, value: '灾难' },
    { class: 4, value: '2019' },
    { class: 5, value: '原创' },
  ],
  103: [
    { class: 1, value: '石原立也' },
    { class: 2, value: '京都动画' },
    { class: 3, value: '催泪' },
    { class: 4, value: '2007' },
    { class: 5, value: '轻改' },
  ],
  104: [
    { class: 2, value: '京都动画' },
    { class: 3, value: '音乐' },
    { class: 4, value: '2009' },
    { class: 5, value: '漫改' },
  ],
  105: [
    { class: 1, value: '佐藤卓哉' },
    { class: 2, value: 'WHITE FOX' },
    { class: 3, value: '科幻' },
    { class: 4, value: '2011' },
    { class: 5, value: '游戏改' },
  ],
  112: [
    { class: 1, value: '本广克行' },
    { class: 2, value: 'Production I.G' },
    { class: 3, value: '悬疑' },
    { class: 4, value: '2012' },
    { class: 5, value: '原创' },
  ],
  113: [
    { class: 2, value: 'A-1 Pictures' },
    { class: 3, value: '恋爱' },
    { class: 4, value: '2019' },
    { class: 5, value: '漫改' },
  ],
  114: [
    { class: 2, value: 'P.A.WORKS' },
    { class: 3, value: '群像' },
    { class: 4, value: '2013' },
    { class: 5, value: '原创' },
  ],
  115: [
    { class: 2, value: 'BONES' },
    { class: 3, value: '战斗' },
    { class: 4, value: '2016' },
    { class: 5, value: '漫改' },
  ],
  116: [
    { class: 2, value: 'BONES' },
    { class: 3, value: '机战' },
    { class: 4, value: '2005' },
    { class: 5, value: '原创' },
  ],
  117: [
    { class: 1, value: '大森贵弘' },
    { class: 2, value: 'Brains Base' },
    { class: 3, value: '治愈' },
    { class: 4, value: '2008' },
    { class: 5, value: '漫改' },
  ],
  118: [
    { class: 1, value: '荒木哲郎' },
    { class: 2, value: 'WIT STUDIO' },
    { class: 3, value: '战斗' },
    { class: 4, value: '2013' },
    { class: 5, value: '漫改' },
  ],
  121: [
    { class: 1, value: '水岛努' },
    { class: 2, value: 'P.A.WORKS' },
    { class: 3, value: '职场' },
    { class: 4, value: '2015' },
    { class: 5, value: '其他' },
  ],
}

/** 为牌对象附上要素（揭示/摊牌时用；未揭示牌对象保持无 elements 字段） */
export function withElements(card: CardData): CardData {
  return { ...card, elements: ELEMENTS[card.id] ?? [] }
}

/**
 * 主题过滤命中判定（mock 用）：company=公司要素（class 2）相等 /
 * year=年份要素（class 4）相等 / tag=标签要素（class 3）包含。
 */
export function matchTheme(card: Pick<CardData, 'id'>, filter: ThemeFilter): boolean {
  const els = ELEMENTS[card.id] ?? []
  const want = filter.value.trim()
  if (!want) return true
  const cls = filter.kind === 'company' ? 2 : filter.kind === 'year' ? 4 : 3
  return els.some((e) => e.class === cls && (filter.kind === 'tag' ? e.value.includes(want) : e.value === want))
}

/** 公共牌序列（flop 3 + turn 1 + river 1） */
export const FLOP: CardData[] = [C103_CLANNAD, C104_KON, C105_STEINSGATE]
export const TURN: CardData[] = [C112_PSYCHOPASS]
export const RIVER: CardData[] = [C121_SHIROBAKO]

/** 各座位底牌（seat 0 = 自己） */
export const HOLE_CARDS: Record<number, CardData[]> = {
  0: [C101_KIMINONAWA, C102_TENKINOKO],
  1: [C115_BUNGO, C116_E7],
  2: [C113_KAGUYA, C114_NAGI],
  3: [C117_NATSUME, C118_SHINGEKI],
}

/** 座位昵称 */
export const NICKS: Record<number, string> = {
  0: '你',
  1: '墨镜',
  2: '樱',
  3: '老K',
}

/** 盒名单（D17）：本手发牌盒的公开名单——仅 L1 字段，不带 elements */
export const BOX: BoxCard[] = [
  C101_KIMINONAWA,
  C102_TENKINOKO,
  C103_CLANNAD,
  C104_KON,
  C105_STEINSGATE,
  C112_PSYCHOPASS,
  C113_KAGUYA,
  C114_NAGI,
  C115_BUNGO,
  C116_E7,
  C117_NATSUME,
  C118_SHINGEKI,
  C121_SHIROBAKO,
].map(({ id, title, score, bucket, year }) => ({ id, title, score, bucket, year }))

/** 主题池过窄回退阈值：过滤后不足此张数即回退全库（demo：WHITE FOX 1 张回退、京都动画 2 张不回退） */
export const MIN_THEME_POOL = 2

/**
 * 摊牌夹具：best5 + 成组划分（groups = cards 下标集合）+ 牌型级数。
 * 按规则书比较链排序：我（合奏 7 · 原创×3 + 京都×2）> 老K（三连星 4）>
 * 墨镜/樱（两对 3，按组类优先级与分数逐张分先后）。
 */
export const SHOWDOWN: ShowdownHand[] = [
  {
    seat: 0,
    cards: [C101_KIMINONAWA, C102_TENKINOKO, C112_PSYCHOPASS, C103_CLANNAD, C104_KON].map(withElements),
    groups: [
      [0, 1, 2],
      [3, 4],
    ],
    tier: 7,
    tiebreak: [7, 5, 5, 8.4, 7.3, 8.1, 2, 8.4, 8.3, 105],
  },
  {
    seat: 3,
    cards: [C117_NATSUME, C118_SHINGEKI, C104_KON, C105_STEINSGATE, C121_SHIROBAKO].map(withElements),
    groups: [[0, 1, 2]],
    tier: 4,
    tiebreak: [4, 5, 8.7, 8.9, 8.3, 105],
  },
  {
    seat: 1,
    cards: [C115_BUNGO, C116_E7, C103_CLANNAD, C104_KON, C105_STEINSGATE].map(withElements),
    groups: [
      [0, 1],
      [2, 3],
    ],
    tier: 3,
    tiebreak: [3, 2, 2, 7.8, 7.9, 8.4, 8.3, 105],
  },
  {
    seat: 2,
    cards: [C103_CLANNAD, C104_KON, C114_NAGI, C121_SHIROBAKO, C105_STEINSGATE].map(withElements),
    groups: [
      [0, 1],
      [2, 3],
    ],
    tier: 3,
    tiebreak: [3, 2, 2, 8.4, 8.3, 7.1, 8.4, 105],
  },
]

/** 结算夹具：筹码盈亏 + 积分明细（A5.4 明细含「揭示成本」行，v1 费率 0 只记账 D4） */
export const SETTLED: SettledPayload = {
  potWins: { 0: 180 },
  rows: [
    { seat: 0, chipsDelta: 180, points: { handScore: 42, bondBonus: 12, revealCost: 0 } },
    { seat: 3, chipsDelta: -60, points: { handScore: 18, bondBonus: 6, revealCost: 0 } },
    { seat: 1, chipsDelta: -60, points: { handScore: 12, bondBonus: 4, revealCost: 0 } },
    // 揭示成本 v1 恒 0（ZeroPolicy，D4）：账照记，钱不扣
    { seat: 2, chipsDelta: -60, points: { handScore: 12, bondBonus: 4, revealCost: 0 } },
  ],
}
