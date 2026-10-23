/** H15 补充：6 座 / 9 座练习房在 1366 与 390 视口的布局截图。 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const { chromium } = require('playwright')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'http://localhost:5373/anitexas/'
const OUT = path.join(ROOT, 'acceptance/screenshots')

const browser = await chromium.launch({ channel: 'msedge', headless: true })

async function createPractice(seats, viewport, name) {
  const ctx = await browser.newContext({ viewport })
  const p = await ctx.newPage()
  await p.goto(BASE)
  await p.getByLabel('你的昵称').fill(`座位${seats}`)
  await p.getByTestId('start-practice').click()
  const input = p.getByRole('spinbutton', { name: '座位数' })
  await input.fill(String(seats))
  await p.getByRole('button', { name: '创建房间' }).click()
  await p.waitForURL(/\/room\/[A-Z0-9]+$/)
  await p.getByTestId('waiting-seats').waitFor()
  await p.getByRole('button', { name: '我准备好了' }).click()
  await p.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('开始游戏'))
    return b && !b.disabled
  })
  await p.getByRole('button', { name: '开始游戏' }).click()
  await p.locator('[data-testid="action-bar"]').waitFor()
  await p.waitForTimeout(700)
  await p.screenshot({ path: path.join(OUT, `${name}.png`) })
  const seatCount = await p.getByTestId('player-seat').count()
  const mobileSeatCount = await p.getByTestId('mobile-seats').locator('li').count()
  console.log(name, { seatCount, mobileSeatCount })
  await ctx.close()
}

await createPractice(6, { width: 1366, height: 768 }, '09-seats6-1366')
await createPractice(9, { width: 1366, height: 768 }, '10-seats9-1366')
await createPractice(9, { width: 390, height: 844 }, '11-seats9-390')
await browser.close()
