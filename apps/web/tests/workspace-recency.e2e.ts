/** Recency and saved manual order through the shipped Web composition. */
import { mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page, type WebSocketRoute } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/workspace-recency', import.meta.url))
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const TITLES = ['Newest conversation', 'Middle conversation', 'Oldest conversation']
const PINS_SNAPSHOT_DIR = fileURLToPath(new URL('./expected/workspace-global-pins', import.meta.url))

describe('web e2e: workspace recency', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let socket: WebSocketRoute
  let holdWorkspace = false
  let releaseWorkspace: (() => void) | undefined

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const fixture = await readFile(SEED, 'utf8')
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const now = Date.now()
    const ids = []
    for (const [index, title] of TITLES.entries()) {
      const id = await seedSession(scaffold, fixture, `workspace-recency-${index}`, undefined, {
        createdAt: now - (index + 1) * 60_000,
      })
      await workspace.attachSession(id)
      await scaffold.ctx.sessionController.rename({ sessionId: id, title })
      ids.push(id)
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.routeWebSocket('**/api/remote.mux', (route) => {
      socket = route
      const server = route.connectToServer()
      let heldStream: string | undefined
      const pending: (string | Buffer)[] = []
      server.onMessage((message) => {
        const frame = JSON.parse(String(message)) as {
          type: string
          streamId: string
          value?: { type: string; value?: { archivedSessionIds?: string[] } }
        }
        if (holdWorkspace && frame.type === 'item' && frame.value?.type === 'baseline'
          && frame.value.value?.archivedSessionIds !== undefined) {
          heldStream = frame.streamId
          releaseWorkspace = () => {
            heldStream = undefined
            for (const buffered of pending.splice(0)) route.send(buffered)
          }
        }
        if (frame.streamId === heldStream) pending.push(message)
        else route.send(message)
      })
    })
    await page.clock.setFixedTime(now)
    tripwire = watchConsole(page)
    await page.addInitScript(({ account, ids }) => {
      if (localStorage.getItem('dsh.workspace.view.v5') !== null) return
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: ids[0] }))
      localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({
        groupBy: 'workspace', orderBy: 'updated', groupExpansion: { [account]: true },
        sessionOrderByAccount: { [account]: [...ids].reverse(), __flat_session_order__: [...ids].reverse() },
      }))
    }, { account: workspace.id, ids })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('pauses current recency in Manual, preserves drags on reload, and resets on Last updated', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-recency'))
    const titles = () => page.locator('[role="treeitem"]:not([aria-expanded]) [class*="title"]').allTextContents()
    const pick = async (name: string): Promise<void> => {
      await page.getByRole('button', { name: 'View options' }).click()
      await page.getByRole('menuitem', { name, exact: true }).click()
    }
    const captureSidebar = async (): Promise<string> => {
      await page.getByRole('button', { name: 'View options' }).hover()
      await expect.poll(() => page.getByRole('button', { name: /^Session actions for / }).count()).toBe(0)
      return captureStableAria(page, '[role="tree"][aria-label="Sessions"]', scaffold.workspaceCwd)
    }
    await expect.poll(titles).toEqual(TITLES)
    await compareOrRefreshGolden(
      join(SNAPSHOT_DIR, 'sidebar.expected.md'),
      await captureSidebar(), MODE,
    )
    await pick('Manual')
    await expect.poll(titles).toEqual(TITLES)
    await pick('Last updated')
    await expect.poll(titles).toEqual(TITLES)
    const source = page.getByRole('treeitem').filter({ has: page.getByText(TITLES[2]!, { exact: true }) })
    const target = page.getByRole('treeitem').filter({ has: page.getByText(TITLES[0]!, { exact: true }) })
    await source.dragTo(target, { targetPosition: { x: 30, y: 3 } })
    const dragged = [TITLES[2], TITLES[0], TITLES[1]]
    await expect.poll(titles).toEqual(dragged)
    const manualWarningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await expect.poll(titles).toEqual(dragged)
    acknowledgeReloadConnectionLoss(tripwire, manualWarningStart)
    await pick('Last updated')
    await expect.poll(titles).toEqual(TITLES)
    await pick('In one list')
    await expect.poll(titles).toEqual(TITLES)
    const recencyWarningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await expect.poll(titles).toEqual(TITLES)
    acknowledgeReloadConnectionLoss(tripwire, recencyWarningStart)
    await pick('Manual')
    await expect.poll(titles).toEqual(TITLES)
    await pick('Last updated')
    await pick('WorkSpace')
    await pick('Manual')
    const reconnectWarningStart = tripwire.warnings.length
    holdWorkspace = true
    await socket.close()
    await expect.poll(() => releaseWorkspace !== undefined).toBe(true)
    const workspaceTitle = basename(scaffold.workspaceCwd)
    // Session titles can fall back to the workspace name while reconnect projections reload.
    await page.locator('[role="treeitem"][aria-expanded]')
      .filter({ has: page.getByText(workspaceTitle, { exact: true }) }).hover()
    await page.getByRole('button', { name: `New session in ${workspaceTitle}` }).click()
    await pick('In one list')
    await expect.poll(titles).toEqual(['New Session', ...TITLES])
    await expect.poll(() => page.evaluate(() => {
      const { sessionId } = JSON.parse(localStorage.getItem('dsh.sessions.current')!) as { sessionId: string }
      const { sessionOrderByAccount } = JSON.parse(localStorage.getItem('dsh.workspace.view.v5')!) as {
        sessionOrderByAccount: Record<string, string[]>
      }
      return sessionOrderByAccount.__flat_session_order__?.[0] === sessionId
    })).toBe(true)
    holdWorkspace = false
    releaseWorkspace!()
    await pick('WorkSpace')
    acknowledgeReloadConnectionLoss(tripwire, reconnectWarningStart)
    await expect.poll(titles).toEqual(['New Session', ...TITLES])
    await compareOrRefreshGolden(
      join(SNAPSHOT_DIR, 'manual-blank.expected.md'),
      await captureSidebar(), MODE,
    )
    const blank = page.getByRole('treeitem').filter({ has: page.getByText('New Session', { exact: true }) })
    await expect.poll(() => blank.getAttribute('draggable')).toBe('false')
    const blankWarningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await expect.poll(titles).toEqual(['New Session', ...TITLES])
    acknowledgeReloadConnectionLoss(tripwire, blankWarningStart)
    await pick('Last updated')
    await expect.poll(titles).toEqual(['New Session', ...TITLES])
    await pick('Manual')
    await expect.poll(titles).toEqual(['New Session', ...TITLES])
    await assertFixtureInventory(SNAPSHOT_DIR, ['sidebar.expected.md', 'manual-blank.expected.md'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})

describe('web e2e: workspace global pins', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const accounts: string[] = []
  const ids: string[][] = []
  const names = [['A first', 'A pinned', 'A last'], ['B pinned', 'B last']]

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const fixture = await readFile(SEED, 'utf8')
    const now = Date.now()
    for (const [index, titles] of names.entries()) {
      const cwd = join(scaffold.workspaceCwd, `workspace-${index}`)
      await mkdir(cwd, { recursive: true })
      const workspace = await scaffold.ctx.workspaceRegistry.create(cwd, `Workspace ${index === 0 ? 'A' : 'B'}`)
      await scaffold.ctx.workspaceRegistry.insertBefore(workspace.id)
      accounts.push(workspace.id)
      const members = []
      for (const [position, title] of titles.entries()) {
        const id = await seedSession({ ...scaffold, workspaceCwd: cwd }, fixture, `global-pins-${index}-${position}`, undefined, {
          createdAt: now - (position + 1) * 60_000,
        })
        await workspace.attachSession(id)
        await scaffold.ctx.sessionController.rename({ sessionId: id, title })
        members.push(id)
      }
      ids.push(members)
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.clock.setFixedTime(now)
    tripwire = watchConsole(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(({ accounts, ids }) => {
      if (localStorage.getItem('dsh.workspace.view.v5') !== null) return
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: ids[0]![0] }))
      localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({
        groupBy: 'workspace', orderBy: 'manual',
        groupExpansion: Object.fromEntries(accounts.map(id => [id, true])),
        sessionOrderByAccount: {
          ...Object.fromEntries(accounts.map((id, index) => [id, ids[index]])),
          __flat_session_order__: ids.flat(),
        },
      }))
    }, { accounts, ids })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  })

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await scaffold?.close()
    }
  })

  it('keeps cross-workspace pins above folded groups, persists global drag order, and restores the manual slot on unpin', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-global-pins'))
    const row = (id: string) => page.locator(`[data-row-key="session:${id}"]`)
    const workspace = (id: string) => page.locator(`[data-row-key="workspace:${id}"]`)
    const pinned = page.locator('[data-pinned-section]')
    const pinnedIds = () => pinned.locator('[data-row-key^="session:"]').evaluateAll(rows =>
      rows.map(row => row.getAttribute('data-row-key')!.slice('session:'.length)))
    const visibleIds = () => page.locator('[role="tree"][aria-label="Sessions"] [data-row-key^="session:"]')
      .evaluateAll(rows => rows.map(row => row.getAttribute('data-row-key')!.slice('session:'.length)))
    const aPin = ids[0]![1]!
    const bPin = ids[1]![0]!
    const togglePin = async (id: string, name: string): Promise<void> => {
      await expect.poll(async () => {
        await row(id).hover()
        return row(id).getByRole('button', { name, exact: true }).isVisible()
      }).toBe(true)
      await row(id).getByRole('button', { name, exact: true }).click()
    }
    await expect.poll(visibleIds).toEqual(ids.flat())
    await togglePin(aPin, 'Pin session')
    await togglePin(bPin, 'Pin session')
    await expect.poll(pinnedIds).toHaveLength(2)
    for (const id of [aPin, bPin]) await expect.poll(() => row(id).count()).toBe(1)
    await expect.poll(async () => (await visibleIds()).slice(0, 2).sort()).toEqual([aPin, bPin].sort())
    for (const account of accounts) await workspace(account).click()
    await expect.poll(visibleIds).toEqual(await pinnedIds())
    await expect.poll(() => workspace(accounts[0]!).getAttribute('aria-expanded')).toBe('false')
    await expect.poll(() => workspace(accounts[1]!).getAttribute('aria-expanded')).toBe('false')

    const initial = await pinnedIds()
    await row(initial[1]!).dragTo(row(initial[0]!), { targetPosition: { x: 30, y: 3 } })
    const reordered = [...initial].reverse()
    await expect.poll(pinnedIds).toEqual(reordered)
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await expect.poll(pinnedIds).toEqual(reordered)
    await expect.poll(visibleIds).toEqual(reordered)
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.getByRole('button', { name: 'View options' }).hover()
    await expect.poll(() => page.getByRole('button', { name: /^Session actions for / }).count()).toBe(0)
    await compareOrRefreshGolden(
      join(PINS_SNAPSHOT_DIR, 'folded.expected.md'),
      await captureStableAria(page, '[role="tree"][aria-label="Sessions"]', scaffold.workspaceCwd), MODE,
    )

    await togglePin(aPin, 'Unpin session')
    await expect.poll(pinnedIds).toEqual([bPin])
    await expect.poll(() => row(aPin).count()).toBe(0)
    await workspace(accounts[0]!).click()
    await expect.poll(visibleIds).toEqual([bPin, ...ids[0]!])
    await workspace(accounts[1]!).click()
    await expect.poll(visibleIds).toEqual([bPin, ...ids[0]!, ids[1]![1]!])
    await expect.poll(() => row(aPin).count()).toBe(1)
    await expect.poll(() => row(bPin).count()).toBe(1)

    await row(aPin).dragTo(page.locator('[data-pin-drop-header]'))
    await expect.poll(pinnedIds).toEqual([aPin, bPin])
    await expect.poll(visibleIds).toEqual([aPin, bPin, ids[0]![0]!, ids[0]![2]!, ids[1]![1]!])
    await row(aPin).dragTo(page.locator(`[data-pin-drop-group="${accounts[1]}"]`))
    await expect.poll(pinnedIds).toEqual([aPin, bPin])
    await row(aPin).dragTo(page.locator(`[data-pin-drop-group="${accounts[0]}"]`))
    await expect.poll(pinnedIds).toEqual([bPin])
    await expect.poll(visibleIds).toEqual([bPin, ...ids[0]!, ids[1]![1]!])

    const pick = async (name: string): Promise<void> => {
      await page.getByRole('button', { name: 'View options' }).click()
      await page.getByRole('menuitem', { name, exact: true }).click()
    }
    await pick('Last updated')
    await expect.poll(pinnedIds).toEqual([bPin])
    await expect.poll(visibleIds).toEqual([bPin, ...ids[0]!, ids[1]![1]!])
    await pick('In one list')
    await expect.poll(pinnedIds).toEqual([bPin])
    await expect.poll(async () => (await visibleIds()).sort()).toEqual(ids.flat().sort())
    await expect.poll(async () => (await visibleIds())[0]).toBe(bPin)
    await pick('Manual')
    await expect.poll(pinnedIds).toEqual([bPin])
    const dragToHeader = async (id: string, selector: string): Promise<void> => {
      await expect.poll(() => row(id).getAttribute('draggable')).toBe('true')
      await row(id).scrollIntoViewIfNeeded()
      const source = await row(id).boundingBox()
      if (source === null) throw new Error(`Drag source ${id} has no visible bounds`)
      const x = source.x + source.width / 2
      const y = source.y + source.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      try {
        await page.mouse.move(x + 16, y + 8)
        const target = page.locator(selector)
        await target.waitFor({ state: 'visible', timeout: 10_000 })
        const bounds = await target.boundingBox()
        if (bounds === null) throw new Error(`Drag target ${selector} has no visible bounds`)
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 8 })
      } finally {
        await page.mouse.up()
      }
    }
    await dragToHeader(bPin, '[data-pin-drop-group=""]')
    await expect.poll(pinnedIds).toEqual([])
    await expect.poll(async () => (await visibleIds()).sort()).toEqual(ids.flat().sort())
    await dragToHeader(aPin, '[data-pin-drop-header]')
    await expect.poll(pinnedIds).toEqual([aPin])
    await expect.poll(async () => (await visibleIds())[0]).toBe(aPin)
    await expect.poll(() => row(aPin).count()).toBe(1)
    for (const [index, account] of accounts.entries()) {
      const workspace = scaffold.ctx.workspaceRegistry.list().find(workspace => workspace.id === account)
      expect(workspace).toBeDefined()
      expect([...workspace!.sessionIds].sort()).toEqual([...ids[index]!].sort())
    }
    await assertFixtureInventory(PINS_SNAPSHOT_DIR, ['folded.expected.md'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
