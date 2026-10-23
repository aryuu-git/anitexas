/** H04/H06/H11 浏览器补充走查：目标人数、取消准备、练习房自动续局暂停。 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const { chromium } = require('playwright')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'http://localhost:5373/anitexas/'
const OUT = path.join(ROOT, 'acceptance/screenshots')
const results = []
const log = (id, ok, detail) => {
  results.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${detail}`)
}

async function startReady(page) {
  await page.getByRole('button', { name: '我准备好了' }).click()
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('开始游戏'))
    return b && !b.disabled
  })
  await page.getByRole('button', { name: '开始游戏' }).click()
  await page.locator('[data-testid="action-bar"]').waitFor()
}

/** 过牌/跟注推进：避免把机器人全部打破产导致自动续局无人可开。 */
async function playPassive(page) {
  const end = Date.now() + 120000
  while (Date.now() < end) {
    if ((await page.locator('[data-testid="my-chips-delta"]').count()) > 0) return
    if ((await page.locator('[data-testid="action-group"]').count()) > 0) {
      // 键盘优先；若焦点落在输入控件导致快捷键被忽略，直接点按钮兜底
      await page.keyboard.press('c')
      await page.waitForTimeout(120)
      if ((await page.locator('[data-testid="action-group"]').count()) > 0) {
        const call = page.locator('[data-action="call"]')
        const check = page.locator('[data-action="check"]')
        if (await call.count()) await call.first().click().catch(() => {})
        else if (await check.count()) await check.first().click().catch(() => {})
      }
    }
    await page.waitForTimeout(300)
  }
  const status = await page
    .locator('[data-testid="action-status"], [data-testid="action-bar"]')
    .first()
    .innerText()
    .catch(() => '(无操作区)')
  throw new Error(`跟注/过牌后未结算；最后状态：${status.replace(/\s+/g, ' ').slice(0, 120)}`)
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctxA = await browser.newContext({ viewport: { width: 1366, height: 768 } })
const ctxB = await browser.newContext({ viewport: { width: 1366, height: 768 } })
const a = await ctxA.newPage()
const b = await ctxB.newPage()

try {
  // ===== H04/H06 朋友房：目标 4 人、取消准备、显式添加机器人 =====
  await a.goto(BASE)
  await a.getByLabel('你的昵称').fill('房主')
  await a.getByTestId('start-friend').click()
  await a.getByRole('spinbutton', { name: '期望参局人数' }).fill('4')
  await a.getByRole('button', { name: '创建房间' }).click()
  await a.waitForURL(/\/room\/[A-Z0-9]+$/)
  await a.getByTestId('waiting-seats').waitFor()
  const invite = await a.getByTestId('invite-link').innerText()
  await b.goto(invite)
  await b.getByLabel('你的昵称').fill('朋友')
  await b.getByTestId('join-preview').waitFor()
  await b.getByRole('button', { name: '加入准备室' }).click()
  await b.getByTestId('waiting-seats').waitFor()
  await a.getByRole('button', { name: '我准备好了' }).click()
  await b.getByRole('button', { name: '我准备好了' }).click()
  await a.waitForTimeout(500)
  const startBtn = a.getByRole('button', { name: '开始游戏' })
  const blocked = await startBtn.isDisabled()
  const reason = await a.getByTestId('ready-hint').innerText()
  log('H04 目标人数阻塞', blocked && /还差 2/.test(reason), `开始按钮禁用=${blocked}；原因：${reason}`)

  await b.getByRole('button', { name: '取消准备' }).click()
  await a.waitForTimeout(400)
  const cancelBlocked = await startBtn.isDisabled()
  const cancelReason = await a.getByTestId('ready-hint').innerText()
  log('H06 取消准备', cancelBlocked && /朋友/.test(cancelReason), `取消后开始禁用=${cancelBlocked}；原因：${cancelReason}`)
  await b.getByRole('button', { name: '我准备好了' }).click()
  await a.waitForTimeout(300)

  await a.getByRole('button', { name: '添加机器人' }).click()
  await a.getByRole('button', { name: '添加机器人' }).click()
  await a.waitForTimeout(500)
  const enabledAfterBots = !(await startBtn.isDisabled())
  log('H04 添加机器人后开局', enabledAfterBots, `补齐机器人后开始按钮可用=${enabledAfterBots}`)
  await startBtn.click()
  await a.locator('[data-testid="action-bar"]').waitFor()
  await b.locator('[data-testid="action-bar"]').waitFor()
  await a.screenshot({ path: path.join(OUT, '12-h04-bots-1366.png') })

  // ===== H11 练习房自动续局 + 服务端暂停 =====
  await a.goto(BASE)
  await a.getByLabel('你的昵称').fill('练习者')
  await a.getByTestId('start-practice').click()
  await a.getByRole('spinbutton', { name: '座位数' }).fill('9')
  await a.getByRole('button', { name: '自动续局' }).click()
  await a.getByRole('button', { name: '创建房间' }).click()
  await a.waitForURL(/\/room\/[A-Z0-9]+$/)
  await a.getByTestId('waiting-seats').waitFor()
  await startReady(a)
  await playPassive(a)
  // 自动续局：结算后 8 秒左右自动开下一手。
  await a.locator('[data-testid="action-bar"]').waitFor({ timeout: 15000 })
  log('H11 自动续局', true, '结算后服务端排程自动开下一手')
  await playPassive(a)
  await a.getByRole('button', { name: '关闭结算' }).click()
  await a.getByRole('button', { name: '暂停自动续局' }).click()
  await a.waitForTimeout(1000)
  const paused = (await a.getByRole('button', { name: '开启自动续局' }).count()) === 1
  await a.waitForTimeout(9000)
  const noAuto = (await a.locator('[data-testid="action-bar"]').count()) === 0
  log('H11 暂停自动续局', paused && noAuto, `服务端确认暂停=${paused}；9s 未自动发牌=${noAuto}`)
  await a.getByRole('button', { name: '开启自动续局' }).click()
  await a.locator('[data-testid="action-bar"]').waitFor({ timeout: 15000 })
  log('H11 恢复自动续局', true, '恢复策略后按服务端排程再次发牌')
  await a.screenshot({ path: path.join(OUT, '13-h11-auto-1366.png') })
} finally {
  await ctxA.close()
  await ctxB.close()
  await browser.close()
  const fs = await import('node:fs/promises')
  await fs.writeFile(path.join(ROOT, 'acceptance/policy-results.json'), JSON.stringify(results, null, 2))
}
