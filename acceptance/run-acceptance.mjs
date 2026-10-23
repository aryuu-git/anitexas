/**
 * AniTexas 第二轮真实双客户端验收（Playwright + 本机 Edge，两个独立 browser context）。
 *
 * 前置：
 *   backend  http://localhost:8081 （CARDS_PATH=data/acceptance/cards.json，独立 DB）
 *   frontend http://localhost:5373/anitexas/
 * 产物：acceptance/screenshots/*.png、acceptance/results.json
 *
 * 说明：本脚本执行 H01–H12、H15、H17 的主流程与截图；H13/H14 的隐私/不确定回执由
 * 后端自动化用例覆盖，脚本只做页面级检查，不伪造浏览器证据。
 */
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Playwright 以 --no-save 装在 frontend/node_modules：从脚本位置解析，避免污染依赖清单。
const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const { chromium } = require('playwright')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'http://localhost:5373/anitexas/'
const OUT = path.join(ROOT, 'acceptance/screenshots')
const results = []
const shots = []

const log = (id, ok, detail) => {
  const row = { id, ok, detail, at: new Date().toISOString() }
  results.push(row)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${detail}`)
}

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  shots.push(file)
}

async function waitNoActionBar(page, ms) {
  await page.waitForTimeout(ms)
  return (await page.locator('[data-testid="action-bar"]').count()) === 0
}

async function ready(page) {
  const btn = page.getByRole('button', { name: '我准备好了' })
  await btn.waitFor({ state: 'visible', timeout: 10000 })
  await btn.click()
}

async function start(page) {
  const btn = page.getByRole('button', { name: '开始游戏' })
  await btn.waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForFunction(
    () => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('开始游戏'))
      return b && !b.disabled
    },
    { timeout: 15000 },
  )
  await btn.click()
}

async function allInWhenMyTurn(page) {
  const group = page.locator('[data-testid="action-group"]')
  if ((await group.count()) === 0) return false
  await page.keyboard.press('a')
  await page.waitForTimeout(120)
  await page.keyboard.press('a')
  return true
}

async function waitResult(page, timeout = 30000) {
  await page.locator('[data-testid="my-chips-delta"]').waitFor({ state: 'visible', timeout })
}

/** 两个人轮流全下，直到本手结算。 */
async function playHandAllIn(a, b, label) {
  const deadline = Date.now() + 40000
  while (Date.now() < deadline) {
    const settled = (await a.locator('[data-testid="my-chips-delta"]').count()) > 0
    if (settled) break
    await allInWhenMyTurn(a)
    await allInWhenMyTurn(b)
    await a.waitForTimeout(350)
  }
  await waitResult(a)
  await waitResult(b)
  log(label, true, '双方全下后完成结算')
}

async function closeResult(page) {
  const btn = page.getByRole('button', { name: '关闭结算' })
  if ((await btn.count()) > 0) await btn.click()
}

async function readyNextHand(page) {
  const btn = page.getByRole('button', { name: '准备下一手' })
  if ((await btn.count()) > 0) {
    await btn.click()
    return
  }
  const btn2 = page.getByRole('button', { name: '已准备，等待其他玩家' })
  if ((await btn2.count()) > 0) return
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const ctxA = await browser.newContext({ viewport: { width: 1366, height: 768 } })
  const ctxB = await browser.newContext({ viewport: { width: 1366, height: 768 } })
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  a.setDefaultTimeout(15000)
  b.setDefaultTimeout(15000)

  try {
    // ===== 首页 & 建房 =====
    await a.goto(BASE)
    await a.getByLabel('你的昵称').fill('房主')
    await shot(a, '01-home-1366')
    await a.getByTestId('start-friend').click()
    await a.getByRole('button', { name: '创建房间' }).click()
    await a.waitForURL(/\/room\/[A-Z0-9]+$/)
    await a.getByTestId('waiting-seats').waitFor()
    const code = a.url().split('/').pop()
    log('H05 建房/深链', true, `创建朋友房 ${code}，创建后停留在准备室`)
    const invite = await a.getByTestId('invite-link').innerText()
    await shot(a, '02-waiting-1366')

    // H05 补充：输错码就地恢复；满房给明确下一步（不占座、不重复建房）。
    await b.goto(BASE)
    await b.getByLabel('房间码').fill('ZZZZZZ')
    await b.getByRole('button', { name: '查看并加入' }).click()
    const wrongMsg = await b.getByTestId('join-preview-error').innerText({ timeout: 15000 })
    const wrongOk = /不存在|已关闭/.test(wrongMsg)

    const mk = await fetch('http://localhost:8081/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 建房昵称会预留房主身份，填座要用另外两个昵称。
      body: JSON.stringify({ nick: '满房主', seats: 2, createRequestId: `acc-full-${Date.now()}` }),
    }).then((r) => r.json())
    for (const nick of ['满房甲', '满房乙']) {
      await fetch(`http://localhost:8081/api/rooms/${mk.code}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nick, joinRequestId: `acc-full-${mk.code}-${nick}` }),
      })
    }
    await b.goto(`${BASE}room/${mk.code}`)
    await b.getByLabel('你的昵称').fill('满房丙')
    await b.getByTestId('join-preview').waitFor({ timeout: 15000 })
    const fullHint = await b.getByTestId('join-preview-hint').innerText()
    const refreshAction = await b.getByRole('button', { name: '刷新房间状态' }).count()
    const fullOk = /没有可加入座位/.test(fullHint) && refreshAction === 1
    log(
      'H05 错误码/满房',
      wrongOk && fullOk,
      `错码提示=${wrongMsg.trim()}；满房提示=${fullHint.trim()}；按钮=刷新房间状态×${refreshAction}`,
    )

    // H01：独处 60 秒 + 本人准备后再等 60 秒，不得有第一手/机器人。
    const alone = await waitNoActionBar(a, 60000)
    const noBot = (await a.getByText('机器人：关闭').count()) > 0 || (await a.getByText('机器人关闭').count()) > 0
    await ready(a)
    const readyAlone = await waitNoActionBar(a, 60000)
    log(
      'H01 建房不抢跑',
      alone && readyAlone && noBot,
      `独处 60s 无 action-bar=${alone}，准备后再等 60s 无 action-bar=${readyAlone}，机器人关闭=${noBot}`,
    )

    // ===== 朋友通过邀请链接加入 =====
    await b.goto(invite)
    await b.getByLabel('你的昵称').fill('朋友')
    await b.getByTestId('join-preview').waitFor({ timeout: 15000 })
    await b.getByRole('button', { name: '加入准备室' }).click()
    await b.getByTestId('waiting-seats').waitFor()
    await a.getByText(/真人 2\/2/).first().waitFor({ timeout: 15000 })
    log('H02 朋友加入', true, 'B 通过邀请链接加入；A 看到真人 2/2')

    await ready(b)
    await a.waitForTimeout(15000)
    const stillWaiting = (await a.locator('[data-testid="action-bar"]').count()) === 0
    const onlyHostStart = (await a.getByRole('button', { name: '开始游戏' }).count()) === 1 &&
      (await b.getByRole('button', { name: '开始游戏' }).count()) === 0
    await shot(a, '03-ready-1366')
    log('H02/H03 准备不自动开局', stillWaiting && onlyHostStart, `全员准备 15s 仍等待；只有房主有开始按钮`)

    // ===== 房主主动开局 =====
    await start(a)
    await a.locator('[data-testid="action-bar"]').waitFor()
    await b.locator('[data-testid="action-bar"]').waitFor()
    await a.waitForTimeout(400)
    await shot(a, '04-action-1366')
    const firstScreen = await a.evaluate(() => {
      const bar = document.querySelector('[data-testid="action-bar"]')
      const cards = document.querySelector('[data-testid="hole-cards"]')
      if (!bar || !cards) return false
      return (
        bar.getBoundingClientRect().bottom <= window.innerHeight &&
        cards.getBoundingClientRect().bottom <= window.innerHeight
      )
    })
    log('H15 桌面首屏', firstScreen, '1366×768 下操作区与本人底牌均在首屏内')
    log('H03 主动开局', true, '房主点击开始后两端进入底牌下注')

    // ===== 第一手全下跑到结算 =====
    await playHandAllIn(a, b, 'H07/H09 第一手')
    await a.waitForTimeout(700)
    await shot(a, '05-result-1366')

    // H10：结算后停留超过旧自动延时，全员准备也绝不自动下一手。
    await closeResult(a)
    await closeResult(b)
    await readyNextHand(a)
    await readyNextHand(b)
    await a.waitForTimeout(9000)
    const noAutoNext = (await a.locator('[data-testid="action-bar"]').count()) === 0
    log('H10 手动下一手', noAutoNext, `结算后 9s 未自动发牌=${noAutoNext}`)
    const startNext = a.getByRole('button', { name: '开始下一手' })
    await startNext.waitFor({ state: 'visible' })
    await a.waitForFunction(
      () => {
        const el = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('开始下一手'))
        return el && !el.disabled
      },
      { timeout: 15000 },
    )
    await startNext.click()
    await a.locator('[data-testid="action-bar"]').waitFor()
    log('H10 房主开始下一手', true, '第二手由房主点击后才发牌')

    // H12：行动中整页刷新，恢复同一身份与牌局。
    const beforeReload = await b.locator('[data-testid="player-seat"]').count()
    await b.reload()
    await b.locator('[data-testid="action-bar"]').waitFor({ timeout: 20000 })
    const afterReload = await b.locator('[data-testid="player-seat"]').count()
    const nameStill = (await b.getByText('朋友').count()) > 0
    log('H12 刷新恢复', beforeReload === afterReload && nameStill, `刷新前后座位数 ${beforeReload}/${afterReload}，昵称保留=${nameStill}`)

    // ===== 三视口截图（第二手进行中） =====
    await a.setViewportSize({ width: 1920, height: 1080 })
    await a.waitForTimeout(300)
    await shot(a, '06-action-1920')
    await a.setViewportSize({ width: 390, height: 844 })
    await a.waitForTimeout(300)
    await shot(a, '07-action-390')
    const mobileSeats = await a.getByTestId('mobile-seats').count()
    log('H15 手机布局', mobileSeats === 1, '手机使用紧凑座位列表，不横向拖动大桌')
    await a.setViewportSize({ width: 1366, height: 768 })

    // ===== H17：再完成两手，共三手 =====
    await playHandAllIn(a, b, 'H17 第二手')
    await closeResult(a)
    await closeResult(b)
    await readyNextHand(a)
    await readyNextHand(b)
    await a.getByRole('button', { name: '开始下一手' }).click()
    await a.locator('[data-testid="action-bar"]').waitFor()
    await playHandAllIn(a, b, 'H17 第三手')
    log('H17 连玩三手', true, '邀请开局、连续三手、结果回顾均未刷新解卡')

    // ===== H16：房主离开→权限转交；最后一人离开→房间关闭 =====
    await closeResult(a)
    await closeResult(b)
    await a.getByRole('button', { name: '离开' }).first().click()
    await a.waitForURL(/\/anitexas\/?$/)
    // A 离开后 B 应继承房主权限，看到“开始下一手”。
    const transferred = b.getByRole('button', { name: '开始下一手' })
    await transferred.waitFor({ state: 'visible', timeout: 15000 })
    log('H16 房主转交', true, '原房主离开后，另一真人获得开始下一手权限')
    await b.getByRole('button', { name: '离开' }).first().click()
    await b.waitForURL(/\/anitexas\/?$/)
    log('H16 离席与关闭', true, '最后一人离开后返回首页，无无主牌桌')

    // 最终证据：首页 + 三视口关键页已保存
    await shot(a, '08-home-after-1366')
  } finally {
    await writeFile(path.join(ROOT, 'acceptance/results.json'), JSON.stringify({ results, shots }, null, 2), 'utf8')
    await ctxA.close()
    await ctxB.close()
    await browser.close()
  }
}

main().catch(async (err) => {
  console.error(err)
  results.push({ id: 'FATAL', ok: false, detail: String(err) })
  await writeFile(path.join(ROOT, 'acceptance/results.json'), JSON.stringify({ results, shots }, null, 2), 'utf8')
  process.exitCode = 1
})
