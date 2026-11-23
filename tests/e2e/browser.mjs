#!/usr/bin/env bun
/**
 * Browser-driven checks for Rack's interactive behaviour.
 *
 * Runs a real headless Chrome through the DevTools Protocol, dispatches real
 * mouse/keyboard input and asserts against the live React app + Worker API.
 * No test doubles: every request goes to the dev server, every edit is made
 * through the same handlers a person would use.
 *
 *   bun run test:e2e              # needs `bun run dev` on 127.0.0.1:5173
 *   BASE_URL=http://127.0.0.1:5173 bun tests/e2e/browser.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '')
const PORT = 9400 + Math.floor(Math.random() * 300)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return null
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail ? ` — ${detail}` : ''}`)
}

/* ------------------------------------------------------------------ CDP --- */

let socket
let nextId = 0
const pending = new Map()
const listeners = new Map()
let sessionId

function on(method, handler) {
  listeners.set(method, [...(listeners.get(method) ?? []), handler])
}

function send(method, params = {}, useSession = sessionId) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const payload = { id, method, params }
    if (useSession) payload.sessionId = useSession
    socket.send(JSON.stringify(payload))
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`))
    }, 25_000)
  })
}

async function connect(url) {
  await new Promise((resolve, reject) => {
    socket = new WebSocket(url)
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP socket error')), {
      once: true,
    })
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
      return
    }
    for (const handler of listeners.get(message.method) ?? []) {
      try {
        handler(message.params, message.sessionId)
      } catch (error) {
        console.error('handler failed', error)
      }
    }
  })
}

async function evalJs(expression) {
  const response = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  })
  if (response.exceptionDetails) {
    const description =
      response.exceptionDetails.exception?.description ?? response.exceptionDetails.text
    throw new Error(`page evaluation failed: ${description}`)
  }
  return response.result.value
}

const textOf = (selector) =>
  evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    return el ? el.textContent : null
  })()`)

const countOf = (selector) =>
  evalJs(`document.querySelectorAll(${JSON.stringify(selector)}).length`)

async function waitFor(label, probe, timeout = 12_000) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeout) {
    try {
      last = await probe()
      if (last) return last
    } catch {
      /* the page may be navigating; retry */
    }
    await sleep(80)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function rectOf(selector, index = 0, scroll = false) {
  const rect = await evalJs(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const el = nodes[${index}]
    if (!el) return null
    ${scroll ? "el.scrollIntoView({ block: 'nearest', inline: 'center' })" : ''}
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
  })()`)
  if (!rect || rect.w === 0 || rect.h === 0)
    throw new Error(`element not visible: ${selector}[${index}]`)
  return rect
}

const toastTexts = () =>
  evalJs(`[...document.querySelectorAll('.toast')].map((node) => node.textContent)`)

async function mouse(type, x, y, buttons) {
  await send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons,
    clickCount: type === 'mouseMoved' ? 0 : 1,
    pointerType: 'mouse',
  })
}

async function click(selector, index = 0, scroll = false) {
  const rect = await rectOf(selector, index, scroll)
  await mouse('mouseMoved', rect.cx, rect.cy, 0)
  await mouse('mousePressed', rect.cx, rect.cy, 1)
  await sleep(30)
  await mouse('mouseReleased', rect.cx, rect.cy, 0)
  await sleep(120)
}

async function dragTo(from, to, steps = 14) {
  await mouse('mouseMoved', from.x, from.y, 0)
  await mouse('mousePressed', from.x, from.y, 1)
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps
    await mouse('mouseMoved', from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, 1)
    await sleep(12)
  }
  await mouse('mouseReleased', to.x, to.y, 0)
  await sleep(160)
}

async function dragElement(fromSelector, toPoint, index = 0) {
  const from = await rectOf(fromSelector, index)
  await dragTo({ x: from.cx, y: from.cy }, toPoint)
}

async function key(modifiers, keyName, code, virtualKeyCode) {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    modifiers,
    key: keyName,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    modifiers,
    key: keyName,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
  })
}

async function fillInput(selector, value) {
  await click(selector, 0, true)
  await key(2, 'a', 'KeyA', 65) // ctrl+a selects the current value
  await send('Input.insertText', { text: String(value) })
  await sleep(200)
}

const inputValue = (selector) =>
  evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    return el ? el.value : null
  })()`)

function parseParams(text) {
  const match = String(text).match(/([\d.]+)\s*([BTMK]?)\s*params/)
  if (!match) return NaN
  const unit = { '': 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2]]
  return Number(match[1]) * unit
}

function parseMemory(text) {
  const match = String(text).match(/([\d.]+)\s*(TB|GB|MB)\/GPU/)
  if (!match) return NaN
  const unit = { MB: 1e6, GB: 1e9, TB: 1e12 }[match[2]]
  return Number(match[1]) * unit
}

const paramsNow = async () => parseParams(await textOf('.canvas-totals'))
const memoryNow = async () => parseMemory(await textOf('.canvas-totals'))

/* ------------------------------------------------------------------ run --- */

const graphRequests = []
const pageErrors = []

async function main() {
  const version = await (await fetch(`${BASE}/api/health`)).json().catch(() => null)
  if (!version?.ok) throw new Error(`dev server is not answering at ${BASE}`)

  const chromePath = findChrome()
  if (!chromePath) throw new Error('No Chrome/Edge binary found; set CHROME_PATH')
  console.log(`Rack browser checks → ${BASE}`)
  console.log(`Chrome: ${chromePath}\n`)

  const profile = mkdtempSync(join(tmpdir(), 'rack-e2e-'))
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-background-networking',
      '--window-size=1440,1000',
      '--force-device-scale-factor=1',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let stderr = ''
  chrome.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  try {
    let browserWs
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const info = await (
          await fetch(`http://127.0.0.1:${PORT}/json/version`)
        ).json()
        browserWs = info.webSocketDebuggerUrl
        break
      } catch {
        await sleep(150)
      }
    }
    if (!browserWs) throw new Error(`Chrome did not expose CDP:\n${stderr.slice(-800)}`)

    await connect(browserWs)
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, undefined)
    const attached = await send('Target.attachToTarget', { targetId, flatten: true }, undefined)
    sessionId = attached.sessionId

    await send('Page.enable')
    await send('Runtime.enable')
    await send('Network.enable')
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    })

    on('Runtime.exceptionThrown', (params) => {
      pageErrors.push(params.exceptionDetails?.exception?.description ?? 'page exception')
    })
    // The app guards against closing with an unsaved draft; accept the prompt.
    on('Page.javascriptDialogOpening', () => {
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
    })
    on('Network.requestWillBeSent', (params) => {
      if (params.request.method !== 'PUT' || !/\/graph$/.test(params.request.url)) return
      const entry = { at: Date.now(), requestId: params.requestId, postData: params.request.postData }
      graphRequests.push(entry)
      if (!entry.postData) {
        send('Network.getRequestPostData', { requestId: params.requestId })
          .then((result) => {
            entry.postData = result.postData
          })
          .catch(() => {})
      }
    })

    const settleSave = async () => {
      try {
        await waitFor(
          'pending save to settle',
          async () => {
            const state = await evalJs(
              `document.querySelector('.save-indicator')?.dataset.state ?? 'saved'`,
            )
            return state !== 'saving'
          },
          10_000,
        )
      } catch {
        /* navigation is allowed either way */
      }
    }

    const goto = async (path, readySelector) => {
      await settleSave()
      await send('Page.navigate', { url: `${BASE}${path}` })
      await waitFor(`load ${path}`, async () => {
        const ready = await evalJs(`document.readyState === 'complete'`)
        if (!ready) return false
        return Boolean(await evalJs(`Boolean(document.querySelector(${JSON.stringify(readySelector)}))`))
      })
      await sleep(250)
    }

    await goto('/', '.dashboard')

    // Remove plans left behind by an interrupted earlier run of this suite.
    await evalJs(`(async () => {
      const list = await (await fetch('/api/projects')).json()
      const stale = list.projects.filter((project) => project.name === 'Browser checks')
      await Promise.all(stale.map((project) => fetch('/api/projects/' + project.id, { method: 'DELETE' })))
      return stale.length
    })()`)
    await send('Page.reload')
    await waitFor('dashboard after cleanup', async () => {
      const ready = await evalJs(`document.readyState === 'complete'`)
      return ready && Boolean(await evalJs(`Boolean(document.querySelector('.dashboard'))`))
    })
    await sleep(300)

    const emptyDashboard = (await countOf('.project-card')) === 0
    if (emptyDashboard) {
      const seedCards = await evalJs(`[...document.querySelectorAll('.template-card')].map((card) => ({
        tag: card.querySelector('.template-tag')?.textContent ?? '',
        name: card.querySelector('strong')?.textContent ?? '',
      }))`)
      check(
        'empty dashboard offers exactly the three template seeds',
        seedCards.length === 3 &&
          /Dense 7B/.test(seedCards[0].name) &&
          /MoE 8×7B/.test(seedCards[1].name) &&
          /Small 1B/.test(seedCards[2].name),
        seedCards.map((seed) => seed.name).join(' / '),
      )
    } else {
      console.log('  ..  empty-state seed cards skipped: this account already has plans')
    }

    const seedProjects = [
      { index: 0, name: 'Dense 7B', blocks: 6, stages: 6 },
      { index: 1, name: 'Atlas MoE 8×7B', blocks: 6, stages: 7 },
      { index: 2, name: 'Lumen 1B', blocks: 6, stages: 5 },
    ]
    for (const seed of seedProjects) {
      if (emptyDashboard) {
        await click('.template-card', seed.index)
      } else {
        await click('.rail-btn[aria-label="New plan"]')
        await waitFor('new plan modal', async () =>
          Boolean(await evalJs(`Boolean(document.querySelector('.template-choice'))`)),
        )
        await click('.template-choice', seed.index)
      }
      await waitFor('new plan dialog', async () =>
        Boolean(await evalJs(`Boolean(document.querySelector('.modal .modal-foot .primary'))`)),
      )
      await click('.modal .modal-foot .primary')
      await waitFor(
        `seed ${seed.name} opens`,
        async () => (await countOf('.canvas-view .node')) === seed.blocks,
        15_000,
      )
      const info = await evalJs(`(async () => {
        const id = location.pathname.split('/')[2]
        const project = (await (await fetch('/api/projects/' + id)).json()).project
        return { id: project.id, name: project.name, blocks: project.blocks.length, stages: project.stages.length }
      })()`)
      check(
        `seed "${seed.name}" creates a real project`,
        info.name === seed.name && info.blocks === seed.blocks && info.stages === seed.stages,
        `${info.name}: ${info.blocks} blocks, ${info.stages} stages`,
      )
      await evalJs(`fetch('/api/projects/${info.id}', { method: 'DELETE' })`)
      await goto('/', '.dashboard')
    }

    const createPlan = async (template, name) =>
      evalJs(`(async () => {
        const response = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ template: '${template}', name: '${name}' }),
        })
        if (!response.ok) throw new Error('create failed ' + response.status)
        return (await response.json()).project
      })()`)

    // A project with real stages/roles/blocks so every view has content.
    const created = await createPlan('dense', 'Browser checks')
    const projectId = created.id

    /* ---------------------------------------------------------- canvas --- */

    await goto(`/p/${projectId}/model`, '.canvas-view .node')
    await waitFor('seeded nodes', async () => (await countOf('.canvas-view .node')) === 6)

    /* ------------------------------------------------- design + shell --- */

    const tokens = await evalJs(`(() => {
      const styles = getComputedStyle(document.documentElement)
      const pick = (name) => styles.getPropertyValue(name).trim().toLowerCase()
      return {
        surface: pick('--surface'), panel: pick('--panel'), raised: pick('--raised'),
        hair: pick('--hair'), text: pick('--text'), text2: pick('--text-2'), text3: pick('--text-3'),
        model: pick('--model'), data: pick('--data'), train: pick('--train'),
        eval: pick('--eval'), risk: pick('--risk'),
      }
    })()`)
    check(
      'design tokens match the lab-console ramp and five accents',
      tokens.surface === '#0b0c0e' &&
        tokens.panel === '#121417' &&
        tokens.raised === '#1a1d22' &&
        tokens.hair === '#262b33' &&
        tokens.text === '#e8eaed' &&
        tokens.text2 === '#8b939f' &&
        tokens.text3 === '#565d68' &&
        tokens.model === '#7c5cff' &&
        tokens.data === '#33c2a0' &&
        tokens.train === '#f0a13c' &&
        tokens.eval === '#3f9dff' &&
        tokens.risk === '#ff5c6c',
      `${tokens.surface}/${tokens.panel}/${tokens.raised}/${tokens.hair} · ${tokens.model} ${tokens.data} ${tokens.train} ${tokens.eval} ${tokens.risk}`,
    )

    const shell = await evalJs(`(() => {
      const bar = document.querySelector('.topbar')
      const rail = document.querySelector('.rail')
      const main = document.querySelector('.main')
      return {
        barHeight: bar.getBoundingClientRect().height,
        barPosition: getComputedStyle(bar).position,
        railWidth: rail.getBoundingClientRect().width,
        tabs: [...document.querySelectorAll('.view-tabs button')].map((button) => button.textContent.trim()),
        avatar: Boolean(document.querySelector('[aria-label="Account"]')),
        mainOverflow: getComputedStyle(main).overflowY,
        mainHeight: main.getBoundingClientRect().height,
        windowHeight: window.innerHeight,
      }
    })()`)
    const kbdButton = await evalJs(
      `Boolean([...document.querySelectorAll('.topbar button')].find((button) => /⌘K/i.test(button.textContent)))`,
    )
    check(
      'shell: 56px fixed topbar, 40px rail, four view tabs, ⌘K and avatar',
      shell.barHeight === 56 &&
        shell.railWidth === 40 &&
        shell.tabs.join(',') === 'Model,Pipeline,Team,Evals' &&
        kbdButton &&
        shell.avatar,
      `topbar ${shell.barHeight}px (${shell.barPosition}), rail ${shell.railWidth}px, tabs ${shell.tabs.join('/')}, kbd ${kbdButton}, avatar ${shell.avatar}`,
    )
    check(
      'main content scrolls independently under the fixed topbar',
      shell.mainOverflow === 'auto' && shell.mainHeight < shell.windowHeight,
      `overflow ${shell.mainOverflow}, main ${shell.mainHeight}px of ${shell.windowHeight}px`,
    )

    const paint = await evalJs(`(() => {
      const accents = ['rgb(124, 92, 255)', 'rgb(51, 194, 160)', 'rgb(240, 161, 60)', 'rgb(63, 157, 255)', 'rgb(255, 92, 108)']
      const fills = []
      const gradients = []
      const blurs = []
      for (const el of document.querySelectorAll('*')) {
        const styles = getComputedStyle(el)
        if (accents.includes(styles.backgroundColor)) fills.push(el.className || el.tagName)
        if (styles.backgroundImage.includes('linear-gradient')) gradients.push(el.className || el.tagName)
        if ((styles.filter || '').includes('blur') || (styles.backdropFilter || '').includes('blur')) blurs.push(el.className || el.tagName)
      }
      return { fills: fills.slice(0, 4), gradients: gradients.slice(0, 4), blurs: blurs.slice(0, 4) }
    })()`)
    check(
      'accents are never fill blocks; no linear gradients and no blur',
      paint.fills.length === 0 && paint.gradients.length === 0 && paint.blurs.length === 0,
      `fills ${paint.fills.length}, gradients ${paint.gradients.length}, blurs ${paint.blurs.length}`,
    )

    const canvasPaint = await evalJs(`(() => {
      const viewport = getComputedStyle(document.querySelector('.canvas-viewport'))
      const matrix = getComputedStyle(document.querySelector('.world')).transform
      const values = matrix.slice(matrix.indexOf('(') + 1).split(',').map(Number)
      const scale = values[0] || 1
      const mono = getComputedStyle(document.querySelector('.canvas-totals.mono'))
      return {
        backgroundImage: viewport.backgroundImage,
        backgroundSize: viewport.backgroundSize,
        scale,
        fontVariantNumeric: mono.fontVariantNumeric,
      }
    })()`)
    const gridSize = parseFloat(canvasPaint.backgroundSize)
    check(
      '24px dot grid scales with canvas zoom and numbers are tabular mono',
      canvasPaint.backgroundImage.includes('radial-gradient') &&
        Math.abs(gridSize - 24 * canvasPaint.scale) < 0.2 &&
        String(canvasPaint.fontVariantNumeric).includes('tabular-nums'),
      `grid ${gridSize}px at ${canvasPaint.scale}× (24px base), font-variant ${canvasPaint.fontVariantNumeric}`,
    )

    const motion = await evalJs(`(() => {
      const node = getComputedStyle(document.querySelector('.node'))
      const main = getComputedStyle(document.querySelector('.main'))
      const panel = getComputedStyle(document.querySelector('.inspector'))
      return {
        hover: node.transitionDuration,
        view: main.animationDuration,
        viewIterations: main.animationIterationCount,
        drawer: panel.animationDuration,
        drawerIterations: panel.animationIterationCount,
      }
    })()`)
    check(
      'motion is 120ms hover, 200ms panel and 320ms view, each run once',
      motion.hover.split(',')[0].trim() === '0.12s' &&
        motion.view === '0.32s' &&
        motion.drawer === '0.2s' &&
        motion.viewIterations === '1' &&
        motion.drawerIterations === '1',
      `hover ${motion.hover}, view ${motion.view}, panel ${motion.drawer}`,
    )

    await evalJs(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`)
    await key(0, 'Tab', 'Tab', 9)
    const focusRing = await evalJs(`(() => {
      const el = document.activeElement
      const styles = getComputedStyle(el)
      return { tag: el.tagName, outlineWidth: styles.outlineWidth, outlineStyle: styles.outlineStyle, color: styles.outlineColor }
    })()`)
    check(
      'keyboard focus shows a 2px solid ring',
      focusRing.outlineWidth === '2px' && focusRing.outlineStyle === 'solid',
      `${focusRing.tag} outline ${focusRing.outlineWidth} ${focusRing.outlineStyle} ${focusRing.color}`,
    )

    await click('[aria-label="Fit to view"]')
    await sleep(350)

    const baseTotals = await textOf('.canvas-totals')
    const baseParams = parseParams(baseTotals)
    check('canvas renders the seeded graph with live totals', baseParams > 5e9, baseTotals.slice(0, 46))

    await click('.palette-item.kind-norm')
    await waitFor('norm added', async () => (await countOf('.canvas-view .node')) === 7)
    const normA = await evalJs(`document.querySelector('.node.selected')?.dataset.nodeId`)
    check('palette click adds a block and selects it', Boolean(normA), normA ? `id ${normA.slice(0, 8)}` : 'no selection')

    const viewport = await evalJs(`(() => {
      const r = document.querySelector('.canvas-viewport').getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    })()`)

    const nodeRectA = await rectOf(`.node[data-node-id="${normA}"]`)
    await dragTo(
      { x: nodeRectA.cx, y: nodeRectA.cy },
      { x: viewport.x + 220, y: viewport.y + viewport.h - 170 },
    )

    await click('.palette-item.kind-norm')
    await waitFor('second norm added', async () => (await countOf('.canvas-view .node')) === 8)
    const normB = await evalJs(`document.querySelector('.node.selected')?.dataset.nodeId`)
    const nodeRectB = await rectOf(`.node[data-node-id="${normB}"]`)
    await dragTo(
      { x: nodeRectB.cx, y: nodeRectB.cy },
      { x: viewport.x + viewport.w - 330, y: viewport.y + viewport.h - 170 },
    )

    await click('[aria-label="Fit to view"]')
    await sleep(350)

    const edgesBefore = await countOf('.edge-layer path.edge:not(.draft):not(.rejected)')
    const portOut = await rectOf(`.node[data-node-id="${normA}"] .port.out`)
    const targetB = await rectOf(`.node[data-node-id="${normB}"]`)
    await dragTo({ x: portOut.cx, y: portOut.cy }, { x: targetB.cx, y: targetB.cy })

    const edgesAfter = await countOf('.edge-layer path.edge:not(.draft):not(.rejected)')
    check(
      'dragging port → block connects two typed hidden ports',
      edgesAfter === edgesBefore + 1,
      `edges ${edgesBefore} → ${edgesAfter}`,
    )

    // Prove the feedback path under reduced motion: the edge must still appear
    // and clear, and must not rely on a looping animation.
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })
    const reducedMotion = await evalJs(
      `matchMedia('(prefers-reduced-motion: reduce)').matches`,
    )
    const reducedMotionPaint = await evalJs(`(() => {
      const node = getComputedStyle(document.querySelector('.node'))
      const main = getComputedStyle(document.querySelector('.main'))
      const panel = getComputedStyle(document.querySelector('.inspector'))
      const first = (value) => Number(String(value).split(',')[0].replace('s', ''))
      return {
        transition: first(node.transitionDuration),
        view: first(main.animationDuration),
        drawer: first(panel.animationDuration),
        iterations: main.animationIterationCount,
      }
    })()`)
    check(
      'reduced motion collapses every transition and animation to one instant frame',
      reducedMotion === true &&
        reducedMotionPaint.transition <= 0.001 &&
        reducedMotionPaint.view <= 0.001 &&
        reducedMotionPaint.drawer <= 0.001 &&
        reducedMotionPaint.iterations === '1',
      `transition ${reducedMotionPaint.transition}s, view ${reducedMotionPaint.view}s, panel ${reducedMotionPaint.drawer}s, iterations ${reducedMotionPaint.iterations}`,
    )

    const portOutB = await rectOf(`.node[data-node-id="${normB}"] .port.out`)
    const targetA = await rectOf(`.node[data-node-id="${normA}"]`)
    await dragTo({ x: portOutB.cx, y: portOutB.cy }, { x: targetA.cx, y: targetA.cy })

    const edgesAfterCycle = await countOf('.edge-layer path.edge:not(.draft):not(.rejected)')
    const cycleToasts = await toastTexts()
    const cycleToast = cycleToasts.find((text) => /cycle/i.test(text)) ?? ''
    check(
      'cycle-forming connect is rejected with a visible toast',
      edgesAfterCycle === edgesAfter && Boolean(cycleToast),
      `edges ${edgesAfterCycle}, toasts ${JSON.stringify(cycleToasts)}`,
    )

    const redEdge = await evalJs(`(() => {
      const el = document.querySelector('.edge-layer .edge.rejected')
      if (!el) return null
      const style = getComputedStyle(el)
      const numbers = (el.getAttribute('d') || '').match(/-?[0-9.]+/g) || []
      const nodes = [...document.querySelectorAll('.node')]
      const from = nodes.find((node) => node.dataset.nodeId === '${normB}')
      const to = nodes.find((node) => node.dataset.nodeId === '${normA}')
      return {
        stroke: style.stroke,
        animation: style.animationName,
        marks: document.querySelectorAll('.reject-edge circle').length,
        marker: el.getAttribute('marker-end'),
        start: { x: Number(numbers[0]), y: Number(numbers[1]) },
        end: { x: Number(numbers[numbers.length - 2]), y: Number(numbers[numbers.length - 1]) },
        expectedStart: { x: parseFloat(from.style.left) + 208, y: parseFloat(from.style.top) + 50 },
        expectedEnd: { x: parseFloat(to.style.left), y: parseFloat(to.style.top) + 50 },
      }
    })()`)
    const near = (a, b) => Math.abs(a - b) < 0.05
    check(
      'rejected connect draws the offending edge in the risk accent',
      reducedMotion === true &&
        Boolean(redEdge) &&
        redEdge.stroke === 'rgb(255, 92, 108)' &&
        redEdge.animation === 'none' &&
        redEdge.marks === 2 &&
        redEdge.marker === 'url(#arrow-risk)' &&
        near(redEdge.start.x, redEdge.expectedStart.x) &&
        near(redEdge.start.y, redEdge.expectedStart.y) &&
        near(redEdge.end.x, redEdge.expectedEnd.x) &&
        near(redEdge.end.y, redEdge.expectedEnd.y),
      redEdge
        ? `stroke ${redEdge.stroke}, animation ${redEdge.animation}, ${redEdge.marks} endpoint rings, reduced-motion ${reducedMotion}, path ${redEdge.start.x.toFixed(0)},${redEdge.start.y.toFixed(0)} → ${redEdge.end.x.toFixed(0)},${redEdge.end.y.toFixed(0)}`
        : 'no red edge rendered',
    )

    await sleep(1700)
    const redCleared = await countOf('.edge-layer .edge.rejected')
    check(
      'red edge clears after the feedback window without touching the graph',
      redCleared === 0 && (await countOf('.edge-layer path.edge:not(.draft):not(.rejected)')) === edgesAfter,
      `${redCleared} red edges, ${await countOf('.edge-layer path.edge:not(.draft):not(.rejected)')} real edges`,
    )

    await send('Emulation.setEmulatedMedia', { features: [] })

    await click('[aria-label="Undo"]')
    await sleep(250)
    const edgesUndone = await countOf('.edge-layer path.edge:not(.draft):not(.rejected)')
    check(
      'undo removes the last connection',
      edgesUndone === edgesAfter - 1,
      `edges ${edgesAfter} → ${edgesUndone}`,
    )

    await click('[aria-label="Redo"]')
    await sleep(250)
    const edgesRedone = await countOf('.edge-layer path.edge:not(.draft):not(.rejected)')
    check(
      'redo restores it',
      edgesRedone === edgesAfter,
      `edges ${edgesUndone} → ${edgesRedone}`,
    )

    // A third block gives us an untouched target, so a rejection can be
    // followed straight away by a legitimate connection.
    const nodesBeforeC = await countOf('.canvas-view .node')
    await click('.palette-item.kind-norm')
    await waitFor(
      'third norm added',
      async () => (await countOf('.canvas-view .node')) === nodesBeforeC + 1,
    )
    const normC = await evalJs(`document.querySelector('.node.selected')?.dataset.nodeId`)
    const rectC = await rectOf(`.node[data-node-id="${normC}"]`)
    await dragTo(
      { x: rectC.cx, y: rectC.cy },
      { x: viewport.x + viewport.w / 2, y: viewport.y + viewport.h - 300 },
    )
    await click('[aria-label="Fit to view"]')
    await sleep(350)

    const cyclePort = await rectOf(`.node[data-node-id="${normB}"] .port.out`)
    const cycleTarget = await rectOf(`.node[data-node-id="${normA}"]`)
    await dragTo({ x: cyclePort.cx, y: cyclePort.cy }, { x: cycleTarget.cx, y: cycleTarget.cy })
    const redBeforeSuccess = await countOf('.edge-layer .edge.rejected')

    const edgesBeforeLegit = await countOf('.edge-layer path.edge:not(.draft):not(.rejected)')
    const legitPort = await rectOf(`.node[data-node-id="${normC}"] .port.out`)
    const legitTarget = await rectOf(`.node[data-node-id="${normB}"]`)
    await dragTo({ x: legitPort.cx, y: legitPort.cy }, { x: legitTarget.cx, y: legitTarget.cy })
    const redAfterSuccess = await countOf('.edge-layer .edge.rejected')
    const edgesAfterLegit = await countOf('.edge-layer path.edge:not(.draft):not(.rejected)')
    check(
      'a later legitimate connect clears the red edge and is added',
      redBeforeSuccess === 1 &&
        redAfterSuccess === 0 &&
        edgesAfterLegit === edgesBeforeLegit + 1,
      `${redBeforeSuccess} red before, ${redAfterSuccess} after, edges ${edgesBeforeLegit} → ${edgesAfterLegit}`,
    )

    // The attention stack dominates the parameter count, so editing its
    // d_model is visible in the header totals rather than lost in rounding.
    const attentionId = await evalJs(
      `[...document.querySelectorAll('.node')].find((node) => /attention/i.test(node.getAttribute('aria-label') || ''))?.dataset.nodeId`,
    )
    const beforeInspectorParams = await paramsNow()
    const beforeInspectorMemory = await memoryNow()
    const nodeA = await rectOf(`.node[data-node-id="${attentionId}"]`)
    await mouse('mouseMoved', nodeA.cx, nodeA.cy, 0)
    await mouse('mousePressed', nodeA.cx, nodeA.cy, 1)
    await mouse('mouseReleased', nodeA.cx, nodeA.cy, 0)
    await waitFor('inspector opens for the block', async () =>
      Boolean(await evalJs(`Boolean(document.querySelector('.inspector .inspector-grid input'))`)),
    )

    const dModelValue = await inputValue('.inspector .inspector-grid input')
    await fillInput('.inspector .inspector-grid input', 8192)
    await sleep(350)
    const afterInspectorParams = await paramsNow()
    const afterInspectorMemory = await memoryNow()
    check(
      'inspector d_model edit recalculates header params and memory live',
      afterInspectorParams > beforeInspectorParams &&
        afterInspectorMemory > beforeInspectorMemory &&
        (await textOf('.canvas-totals')) !== baseTotals,
      `d_model ${dModelValue} → 8192, params ${(beforeInspectorParams / 1e9).toFixed(2)}B → ${(afterInspectorParams / 1e9).toFixed(2)}B, memory ${(beforeInspectorMemory / 1e9).toFixed(1)} → ${(afterInspectorMemory / 1e9).toFixed(1)} GB`,
    )

    await waitFor('previous edits settle to saved', async () => {
      const state = await evalJs(`document.querySelector('.save-indicator')?.dataset.state`)
      return state === 'saved'
    }, 10_000)

    /* ------------------------------------------------------- persistence --- */

    const requestsBefore = graphRequests.length
    const savedParamsBefore = await textOf('.canvas-totals')
    const nodesBeforeCustom = await countOf('.canvas-view .node')
    const clickAt = Date.now()
    await click('.palette-item.kind-custom')
    await waitFor(
      'custom block added',
      async () => (await countOf('.canvas-view .node')) === nodesBeforeCustom + 1,
    )
    const savingState = await evalJs(`document.querySelector('.save-indicator')?.dataset.state`)

    await waitFor('graph autosave request', async () => graphRequests.length > requestsBefore, 6000)
    const saveDelay = graphRequests[graphRequests.length - 1].at - clickAt
    check(
      'graph edit autosaves ~800 ms after the change',
      saveDelay >= 600 && saveDelay <= 2400,
      `${saveDelay} ms (indicator said “${savingState}”)`,
    )

    await waitFor('save completes', async () => {
      const state = await evalJs(`document.querySelector('.save-indicator')?.dataset.state`)
      return state === 'saved'
    }, 6000)

    const request = graphRequests[graphRequests.length - 1]
    await waitFor('request body captured', async () => Boolean(request.postData), 4000)
    const sentGraph = JSON.parse(request.postData)
    const stored = await evalJs(`(async () => {
      const response = await fetch('/api/projects/${projectId}')
      if (!response.ok) throw new Error('reload failed ' + response.status)
      return (await response.json()).project
    })()`)

    const canon = (value) =>
      JSON.stringify(value, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
          : item,
      )
    const blocksMatch = canon(sentGraph.blocks) === canon(stored.blocks)
    const edgesMatch = canon(sentGraph.edges) === canon(stored.edges)
    check(
      'D1 graph endpoint returns the exact payload that was saved',
      blocksMatch && edgesMatch,
      `${sentGraph.blocks.length} blocks / ${sentGraph.edges.length} edges round-trip`,
    )

    await send('Page.reload')
    await waitFor('reload restores the saved graph', async () => {
      const ready = await evalJs(`document.readyState === 'complete'`)
      return ready && (await countOf('.canvas-view .node')) === stored.blocks.length
    }, 12_000)
    await sleep(300)
    const paramsAfterReload = await paramsNow()
    check(
      'reload restores the same blocks and totals',
      Math.abs(paramsAfterReload - parseParams(savedParamsBefore)) <= parseParams(savedParamsBefore) * 0.002,
      `${await countOf('.canvas-view .node')} nodes, ${paramsAfterReload.toExponential(3)} params`,
    )

    /* ----------------------------------------------------------- offline --- */

    const nodesBeforeOffline = await countOf('.canvas-view .node')
    await send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    await click('.palette-item.kind-norm')
    await waitFor(
      'offline draft queued',
      async () => (await countOf('.canvas-view .node')) === nodesBeforeOffline + 1,
    )
    const offlineState = await waitFor(
      'offline indicator',
      async () => {
        const state = await evalJs(`document.querySelector('.save-indicator')?.dataset.state`)
        return state === 'offline' ? state : false
      },
      8000,
    )
    const offlineLabel = await textOf('.save-indicator')
    check(
      'a failed save while offline is kept and reported as offline',
      offlineState === 'offline' && /offline/i.test(offlineLabel ?? ''),
      `state ${offlineState}, label “${(offlineLabel ?? '').trim()}”`,
    )

    await send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    await evalJs(`window.dispatchEvent(new Event('online'))`)
    await waitFor(
      'reconnect flushes the kept draft',
      async () =>
        (await evalJs(`document.querySelector('.save-indicator')?.dataset.state`)) === 'saved',
      8000,
    )
    const afterReconnect = await evalJs(`(async () => {
      const response = await fetch('/api/projects/${projectId}')
      if (!response.ok) throw new Error('reload failed ' + response.status)
      return (await response.json()).project
    })()`)
    check(
      'reconnecting saves the draft held while offline',
      afterReconnect.blocks.length === nodesBeforeOffline + 1,
      `${afterReconnect.blocks.length} blocks on the server (expected ${nodesBeforeOffline + 1})`,
    )

    /* --------------------------------------------------- draft recovery --- */

    // Rename a block and reload inside the 800 ms autosave window. The server
    // never receives this PUT, so anything that survives came from the draft.
    await click('.canvas-view .node', 0)
    await waitFor('inspector opens for the label edit', async () =>
      Boolean(await evalJs(`Boolean(document.querySelector('.inspector-title'))`)),
    )
    const labelBefore = await inputValue('.inspector-title')
    await fillInput('.inspector-title', 'Recovered block')
    const draftMirrored = await evalJs(
      `Boolean(localStorage.getItem('rack:draft:${projectId}'))`,
    )
    // The server must still have the old label at this point, otherwise a
    // restored label would prove nothing about the local draft.
    const serverBeforeReload = await evalJs(`(async () => {
      const response = await fetch('/api/projects/${projectId}')
      return (await response.json()).project
    })()`)
    const serverHadLabel = serverBeforeReload.blocks.some(
      (block) => block.label === 'Recovered block',
    )
    await send('Page.reload')
    await waitFor('reload inside the autosave window', async () => {
      const ready = await evalJs(`document.readyState === 'complete'`)
      return ready && (await countOf('.canvas-view .node')) > 0
    }, 12_000)
    const labelRestored = await waitFor(
      'edited label restored from the local draft',
      async () =>
        Boolean(
          await evalJs(`[...document.querySelectorAll('.canvas-view .node')].some((node) =>
            node.textContent.includes('Recovered block'))`),
        ),
      12_000,
    )
    check(
      'a refresh inside the autosave window keeps the edited block label',
      draftMirrored && labelRestored && labelBefore !== 'Recovered block' && !serverHadLabel,
      `draft mirrored ${draftMirrored}, server already had it ${serverHadLabel}, label “${labelBefore}” → “Recovered block” after reload`,
    )

    await waitFor(
      'recovered draft saves on its own',
      async () => (await evalJs(`document.querySelector('.save-indicator')?.dataset.state`)) === 'saved',
      10_000,
    )
    const recoveredStored = await evalJs(`(async () => {
      const response = await fetch('/api/projects/${projectId}')
      if (!response.ok) throw new Error('reload failed ' + response.status)
      return (await response.json()).project
    })()`)
    const draftCleared = await evalJs(
      `localStorage.getItem('rack:draft:${projectId}') === null`,
    )
    check(
      'the recovered draft is written back to D1 and cleared from local storage',
      recoveredStored.blocks.some((block) => block.label === 'Recovered block') && draftCleared,
      `${recoveredStored.blocks.length} blocks on the server, draft cleared ${draftCleared}`,
    )

    // A draft older than the stored project must lose to the server copy.
    await evalJs(`(() => {
      const blocks = ${JSON.stringify(recoveredStored.blocks)}.map((block, index) =>
        index === 0 ? { ...block, label: 'Stale draft' } : block,
      )
      localStorage.setItem('rack:draft:${projectId}', JSON.stringify({
        id: '${projectId}',
        at: Date.now() - 60_000,
        graph: { blocks, edges: ${JSON.stringify(recoveredStored.edges)} },
      }))
    })()`)
    await send('Page.reload')
    await waitFor('load with an older draft present', async () => {
      const ready = await evalJs(`document.readyState === 'complete'`)
      return ready && (await countOf('.canvas-view .node')) > 0
    }, 12_000)
    const staleLabelShown = await evalJs(
      `[...document.querySelectorAll('.node-title')].some((node) => node.textContent === 'Stale draft')`,
    )
    const staleKeyCleared = await waitFor(
      'older draft discarded',
      async () =>
        Boolean(await evalJs(`localStorage.getItem('rack:draft:${projectId}') === null`)),
      6000,
    ).catch(() => false)
    check(
      'a draft older than the stored project loses to D1 and is discarded',
      !staleLabelShown && staleKeyCleared,
      `stale label rendered ${staleLabelShown}, stale key discarded ${staleKeyCleared}`,
    )

    // Nothing pending: a refresh restores the stored plan and recovers nothing.
    await send('Page.reload')
    await waitFor('clean reload', async () => {
      const ready = await evalJs(`document.readyState === 'complete'`)
      return ready && (await countOf('.canvas-view .node')) > 0
    }, 12_000)
    await sleep(300)
    const cleanToasts = await textOf('.toasts')
    const cleanLabelKept = await evalJs(
      `[...document.querySelectorAll('.node-title')].some((node) => node.textContent === 'Recovered block')`,
    )
    const cleanKeyAbsent = await evalJs(
      `localStorage.getItem('rack:draft:${projectId}') === null`,
    )
    check(
      'a refresh with no pending edit restores the stored plan and recovers nothing',
      cleanLabelKept && cleanKeyAbsent && !/Recovered unsaved/i.test(cleanToasts ?? ''),
      `stored label kept ${cleanLabelKept}, draft key absent ${cleanKeyAbsent}, toast “${(cleanToasts ?? '').trim()}”`,
    )

    /* ---------------------------------------------------------- pipeline --- */

    await goto(`/p/${projectId}/pipeline`, '.timeline-rows .stage-bar')
    await waitFor('pipeline bars', async () => (await countOf('.timeline-rows .stage-bar')) === 6)
    await click('[aria-label="Timeline zoom"] button', 1) // month scale: 26 px per week
    await sleep(250)
    const PX = 26

    const barTitleBefore = await evalJs(
      `document.querySelectorAll('.timeline-rows .stage-bar')[1].getAttribute('title')`,
    )
    const beforeWeeks = barTitleBefore.match(/weeks (\d+)–(\d+)/)
    const barBefore = await rectOf('.timeline-rows .stage-bar', 1)
    const noteBefore = await evalJs(
      `document.querySelectorAll('.timeline-rows .stage-bar')[1].querySelector('.bar-note')?.textContent ?? ''`,
    )

    await dragTo(
      { x: barBefore.cx, y: barBefore.cy },
      { x: barBefore.cx + 3 * PX, y: barBefore.cy },
      10,
    )
    await sleep(250)
    const barTitleMoved = await evalJs(
      `document.querySelectorAll('.timeline-rows .stage-bar')[1].getAttribute('title')`,
    )
    const movedWeeks = barTitleMoved.match(/weeks (\d+)–(\d+)/)
    const barMoved = await rectOf('.timeline-rows .stage-bar', 1)
    check(
      'pipeline drag moves a bar in whole-week steps',
      Number(movedWeeks[1]) === Number(beforeWeeks[1]) + 3 &&
        Number(movedWeeks[2]) === Number(beforeWeeks[2]) + 3 &&
        Math.abs(barMoved.x - barBefore.x - 3 * PX) < 2,
      `${barTitleBefore.split('·')[1]} → ${barTitleMoved.split('·')[1]}, left +${(barMoved.x - barBefore.x).toFixed(1)} px`,
    )

    const handle = await rectOf('.timeline-rows .stage-bar .bar-resize.right', 1)
    await dragTo({ x: handle.cx, y: handle.cy }, { x: handle.cx + 4 * PX, y: handle.cy }, 10)
    await sleep(300)
    const barTitleResized = await evalJs(
      `document.querySelectorAll('.timeline-rows .stage-bar')[1].getAttribute('title')`,
    )
    const resizedWeeks = barTitleResized.match(/weeks (\d+)–(\d+)/)
    const barResized = await rectOf('.timeline-rows .stage-bar', 1)
    const noteAfter = await evalJs(
      `document.querySelectorAll('.timeline-rows .stage-bar')[1].querySelector('.bar-note')?.textContent ?? ''`,
    )
    check(
      'pipeline resize snaps to weeks',
      Number(resizedWeeks[2]) === Number(movedWeeks[2]) + 4 &&
        Math.abs(barResized.w - barMoved.w - 4 * PX) < 2,
      `${movedWeeks[1]}–${movedWeeks[2]}w (${(barMoved.w / PX).toFixed(0)}w) → ${resizedWeeks[1]}–${resizedWeeks[2]}w (${(barResized.w / PX).toFixed(0)}w)`,
    )

    // Seeded stages carry a hand-written compute note, so the estimate only
    // shows for a stage with an empty note. Add one through the real modal.
    await click('.head-actions button.secondary')
    await waitFor('add-stage modal', async () =>
      Boolean(await evalJs(`Boolean(document.querySelector('.modal input.input'))`)),
    )
    await fillInput('.modal input.input', 'Estimate check')
    await click('.modal .modal-foot .primary')
    await waitFor('new stage bar', async () => (await countOf('.timeline-rows .stage-bar')) === 7)
    await sleep(250)

    const resizeNew = async (weeks) => {
      const handle = await rectOf('.timeline-rows .stage-bar .bar-resize.right', 6, true)
      await dragTo({ x: handle.cx, y: handle.cy }, { x: handle.cx + weeks * PX, y: handle.cy }, 10)
      await sleep(300)
      return evalJs(
        `document.querySelectorAll('.timeline-rows .stage-bar')[6].querySelector('.bar-note')?.textContent ?? ''`,
      )
    }

    const firstNote = await resizeNew(3)
    const newTitle = await evalJs(
      `document.querySelectorAll('.timeline-rows .stage-bar')[6].getAttribute('title')`,
    )
    const secondNote = await resizeNew(4)
    const bigTitle = await evalJs(
      `document.querySelectorAll('.timeline-rows .stage-bar')[6].getAttribute('title')`,
    )
    const weeksOf = (title) => {
      const match = String(title).match(/weeks (\d+)–(\d+)/)
      return Number(match[2]) - Number(match[1])
    }
    check(
      'compute estimate inside a resized bar follows the new duration',
      weeksOf(newTitle) === 7 &&
        weeksOf(bigTitle) === 11 &&
        /\$/.test(firstNote) &&
        /\$/.test(secondNote) &&
        firstNote !== secondNote,
      `${weeksOf(newTitle)}w “${firstNote}” → ${weeksOf(bigTitle)}w “${secondNote}”; seeded Pretrain note kept “${noteBefore}” → “${noteAfter}”`,
    )

    const dependencyArrows = await countOf('.dep-layer path.dep')
    const todayLines = await countOf('.today-line')
    const todayLabels = await countOf('.today-label')
    check(
      'pipeline draws dependency arrows plus the today line and label',
      dependencyArrows >= 5 && todayLines === 1 && todayLabels === 1,
      `${dependencyArrows} arrows, ${todayLines} today line, ${todayLabels} label`,
    )

    const barWidthAt = async (index) => {
      await click('[aria-label="Timeline zoom"] button', index)
      await sleep(250)
      return evalJs(
        `document.querySelectorAll('.timeline-rows .stage-bar')[1].getBoundingClientRect().width`,
      )
    }
    const widthWeek = await barWidthAt(0)
    const widthMonth = await barWidthAt(1)
    const widthQuarter = await barWidthAt(2)
    check(
      'week / month / quarter zoom rescale the timeline',
      widthWeek > widthMonth &&
        widthMonth > widthQuarter &&
        Math.abs(widthWeek / widthMonth - 64 / 26) < 0.15 &&
        Math.abs(widthMonth / widthQuarter - 26 / 10) < 0.2,
      `${widthWeek.toFixed(0)} / ${widthMonth.toFixed(0)} / ${widthQuarter.toFixed(0)} px`,
    )

    /* -------------------------------------------------------------- team --- */

    await goto(`/p/${projectId}/team`, '.allocation-grid input')
    const researchPretrain = 'input[aria-label="Research on Pretrain"]'
    const productDeploy = 'input[aria-label="Product on Deploy"]'
    const productPretrain = 'input[aria-label="Product on Pretrain"]'

    const rowTotal = (label) =>
      evalJs(`(() => {
        const input = document.querySelector('input[aria-label="${label}"]')
        const row = input.closest('tr')
        return [...row.querySelectorAll('input')].reduce((sum, el) => sum + Number(el.value || 0), 0)
      })()`)
    const researchTotalBefore = await rowTotal('Research on Pretrain')
    const pretrainBefore = await inputValue(researchPretrain)
    await fillInput(researchPretrain, 80)
    await sleep(300)
    const pretrainAfter = await inputValue(researchPretrain)
    const researchTotalAfter = await rowTotal('Research on Pretrain')
    const overToasts = await toastTexts()
    const overToast = overToasts.find((text) => /can only give/i.test(text)) ?? ''
    check(
      'team refuses an allocation push over 100% and preserves the valid state',
      pretrainAfter === pretrainBefore &&
        researchTotalAfter === researchTotalBefore &&
        researchTotalAfter === 100 &&
        Boolean(overToast),
      `${pretrainBefore}% → typed 80% → ${pretrainAfter}%, total ${researchTotalBefore}% → ${researchTotalAfter}%, toast “${overToast.trim()}”`,
    )

    await fillInput(productDeploy, 20)
    await sleep(250)
    await fillInput(productPretrain, 15)
    await sleep(300)
    const freedValue = await inputValue(productDeploy)
    const reusedValue = await inputValue(productPretrain)
    const productTotal = await rowTotal('Product on Pretrain')
    check(
      'team accepts a valid reallocation inside the 100% budget',
      freedValue === '20' && reusedValue === '15' && productTotal === 95,
      `Deploy ${freedValue}%, Pretrain ${reusedValue}%, total ${productTotal}%`,
    )

    const teamStructure = await evalJs(`(() => {
      const rows = document.querySelectorAll('.roles-table tbody tr').length
      const columns = document.querySelectorAll('.allocation-grid thead th').length - 2
      const cells = document.querySelectorAll('.team-view .capacity-cell').length
      const headcounts = document.querySelectorAll('.roles-table input[aria-label$="headcount"]').length
      const rates = document.querySelectorAll('.roles-table input[aria-label$="monthly rate"]').length
      const divider = getComputedStyle(document.querySelector('.roles-table tbody td')).borderBottomWidth
      const total = document.querySelector('.team-view .cost-rows .total strong')?.textContent?.trim() ?? ''
      return { rows, columns, cells, headcounts, rates, divider, total }
    })()`)
    check(
      'team has roles × headcount × rate, a capacity matrix and cost rollups',
      teamStructure.rows === 5 &&
        teamStructure.headcounts === 5 &&
        teamStructure.rates === 5 &&
        teamStructure.columns >= 6 &&
        teamStructure.cells === teamStructure.rows * teamStructure.columns &&
        /\$/.test(teamStructure.total) &&
        teamStructure.divider === '1px',
      `${teamStructure.rows} roles × ${teamStructure.columns} stages = ${teamStructure.cells} cells, ${teamStructure.total}, ${teamStructure.divider} rule`,
    )

    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(300)
    const pinned = await evalJs(`(() => {
      const main = document.querySelector('.main')
      const bar = document.querySelector('.topbar')
      const before = bar.getBoundingClientRect().top
      main.scrollTop = main.scrollHeight
      const after = bar.getBoundingClientRect().top
      const moved = main.scrollTop
      main.scrollTop = 0
      return { before, after, moved, height: bar.getBoundingClientRect().height }
    })()`)
    check(
      'only the main region scrolls; the 56px topbar stays pinned',
      pinned.before === 0 && pinned.after === 0 && pinned.height === 56 && pinned.moved > 0,
      `scrolled ${pinned.moved}px, topbar top ${pinned.before} → ${pinned.after}`,
    )
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(200)

    /* ------------------------------------------------------------- evals --- */

    await goto(`/p/${projectId}/evals`, '.evals-view')
    const evalsView = await evalJs(`(() => ({
      coverage: document.querySelectorAll('.evals-view .coverage-cell').length,
      score: document.querySelector('.readiness-score')?.textContent?.trim() ?? '',
      gates: document.querySelectorAll('.eval-table tbody tr').length,
      checks: document.querySelectorAll('.checklist li').length,
      meter: document.querySelector('.readiness-meter span')?.style?.width ?? '',
    }))()`)
    check(
      'evals show a stage coverage matrix, readiness score and gate table',
      evalsView.coverage >= 6 &&
        /^\d+%$/.test(evalsView.score) &&
        evalsView.gates === 7 &&
        evalsView.checks === 6 &&
        /%$/.test(evalsView.meter),
      `${evalsView.coverage} coverage cells, readiness ${evalsView.score}, ${evalsView.gates} gate rows, ${evalsView.checks} checks`,
    )

    /* --------------------------------------------------- canvas coverage --- */

    const interactions = await createPlan('blank', 'Canvas checks')
    await goto(`/p/${interactions.id}/model`, '.canvas-view')

    const kinds = [
      'embedding',
      'attention',
      'ffn',
      'moe',
      'norm',
      'residual',
      'projection',
      'loss',
      'custom',
    ]
    for (let index = 0; index < kinds.length; index += 1) {
      await click(`.palette-item.kind-${kinds[index]}`, 0, true)
      await waitFor(`block ${kinds[index]}`, async () => (await countOf('.node')) === index + 1)
    }
    const worstOverlap = await evalJs(`(() => {
      const rects = [...document.querySelectorAll('.node')].map((node) => node.getBoundingClientRect())
      let worst = 0
      for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
          const w = Math.min(rects[i].right, rects[j].right) - Math.max(rects[i].left, rects[j].left)
          const h = Math.min(rects[i].bottom, rects[j].bottom) - Math.max(rects[i].top, rects[j].top)
          if (w > 0 && h > 0) worst = Math.max(worst, Math.round(w * h))
        }
      }
      return worst
    })()`)
    check(
      'blocks never stack: each placement finds its own space',
      worstOverlap === 0,
      `${worstOverlap}px² worst overlap across 9 blocks`,
    )

    const cards = await evalJs(`[...document.querySelectorAll('.node')].map((node) => ({
      code: node.querySelector('.node-code')?.textContent?.trim() ?? '',
      title: node.querySelector('.node-title')?.textContent?.trim() ?? '',
      lines: node.querySelectorAll('.node-line').length,
      params: node.querySelector('.node-params')?.textContent?.trim() ?? '',
    }))`)
    check(
      'all nine block kinds draw a 4-line card with params and memory',
      cards.length === 9 &&
        cards.every(
          (card) =>
            card.code &&
            card.title &&
            card.lines === 2 &&
            /·/.test(card.params) &&
            /(GB|MB|TB)/.test(card.params),
        ),
      `${cards.length} cards, e.g. “${cards[0]?.params ?? ''}”`,
    )

    const nodePositions = () =>
      evalJs(
        `Object.fromEntries([...document.querySelectorAll('.node')].map((node) => [node.dataset.nodeId, node.style.left + ',' + node.style.top]))`,
      )
    const beforeLayout = await nodePositions()
    await click('[aria-label="Auto-layout"]')
    await sleep(450)
    const afterLayout = await nodePositions()
    check(
      'auto-layout repositions the graph',
      JSON.stringify(beforeLayout) !== JSON.stringify(afterLayout),
      'positions changed',
    )

    // Blocks were stacked on the viewport centre until the layout spread them.
    const typedPort = await rectOf('.node.kind-embedding .port.out')
    const lossTarget = await rectOf('.node.kind-loss')
    await dragTo({ x: typedPort.cx, y: typedPort.cy }, { x: lossTarget.cx, y: lossTarget.cy })
    const typedToast = (await toastTexts()).find((text) => /needs|outputs/i.test(text)) ?? ''
    check(
      'a typed-port mismatch is rejected with an explanation and no edge',
      (await countOf('.edge-layer path.edge')) === 0 && Boolean(typedToast),
      typedToast.trim() || 'no toast',
    )

    const worldTransform = () => evalJs(`document.querySelector('.world').style.transform`)

    const viewportRect = await rectOf('.canvas-viewport')
    const beforeZoom = await worldTransform()
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: viewportRect.cx,
      y: viewportRect.cy,
      deltaX: 0,
      deltaY: -240,
      pointerType: 'mouse',
    })
    await sleep(300)
    const afterZoom = await worldTransform()
    check(
      'wheel zooms the canvas',
      beforeZoom !== afterZoom && /scale\(/.test(afterZoom),
      `${beforeZoom} → ${afterZoom}`,
    )

    const emptyPoint = await evalJs(`(() => {
      const viewport = document.querySelector('.canvas-viewport').getBoundingClientRect()
      const blockers = [...document.querySelectorAll('.node, .minimap, .canvas-hints')].map((el) => el.getBoundingClientRect())
      for (let y = viewport.top + 24; y < viewport.bottom - 60; y += 16) {
        for (let x = viewport.left + 24; x < viewport.right - 24; x += 16) {
          if (!blockers.some((r) => x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 8 && y <= r.bottom + 8)) return { x, y }
        }
      }
      return null
    })()`)
    if (!emptyPoint) throw new Error('no empty canvas point found for the pan test')
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32,
    })
    const beforePan = await worldTransform()
    await dragTo(
      { x: emptyPoint.x, y: emptyPoint.y },
      { x: emptyPoint.x + 90, y: emptyPoint.y + 70 },
    )
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32,
    })
    const afterPan = await worldTransform()
    check('space-drag pans the canvas', beforePan !== afterPan, `${beforePan} → ${afterPan}`)

    const beforeFit = await worldTransform()
    await key(0, 'f', 'KeyF', 70)
    await sleep(350)
    const afterFit = await worldTransform()
    check(
      'F fits the graph back into the viewport after zoom and pan',
      beforeFit !== afterFit && /scale\(/.test(afterFit),
      `${beforeFit} → ${afterFit}`,
    )

    const graphBox = await evalJs(`(() => {
      const rects = [...document.querySelectorAll('.node')].map((node) => node.getBoundingClientRect())
      return {
        x1: Math.min(...rects.map((r) => r.left)) - 16,
        y1: Math.min(...rects.map((r) => r.top)) - 16,
        x2: Math.max(...rects.map((r) => r.right)) + 16,
        y2: Math.max(...rects.map((r) => r.bottom)) + 16,
      }
    })()`)
    await dragTo({ x: graphBox.x1, y: graphBox.y1 }, { x: graphBox.x2, y: graphBox.y2 }, 12)
    const marqueeSelected = await countOf('.node.selected')
    check('marquee selects multiple blocks', marqueeSelected === 9, `${marqueeSelected} selected`)

    const nudged = await evalJs(`(() => {
      const node = document.querySelector('.node.selected')
      return { id: node.dataset.nodeId, left: parseFloat(node.style.left) }
    })()`)
    await key(0, 'ArrowRight', 'ArrowRight', 39)
    await sleep(180)
    const nudgedLeft = await evalJs(
      `parseFloat(document.querySelector('.node[data-node-id="${nudged.id}"]').style.left)`,
    )
    check(
      'arrow keys nudge the selection by 1px',
      Math.abs(nudgedLeft - nudged.left - 1) < 0.01,
      `${nudged.left} → ${nudgedLeft}`,
    )

    const nodesBeforeCopy = await countOf('.node')
    await key(2, 'd', 'KeyD', 68)
    await sleep(300)
    const nodesAfterCopy = await countOf('.node')
    const copyTitles = await evalJs(
      `[...document.querySelectorAll('.node-title')].filter((el) => / copy$/.test(el.textContent)).length`,
    )
    check(
      '⌘D duplicates the selection',
      nodesAfterCopy === nodesBeforeCopy * 2 && copyTitles === nodesBeforeCopy,
      `${nodesBeforeCopy} → ${nodesAfterCopy} blocks`,
    )

    await key(0, 'Delete', 'Delete', 46)
    await sleep(300)
    const afterDelete = await countOf('.node')
    await key(2, 'z', 'KeyZ', 90)
    await sleep(350)
    const afterUndoDelete = await countOf('.node')
    check(
      'Delete removes the selection and undo restores it',
      afterDelete === nodesBeforeCopy && afterUndoDelete === nodesAfterCopy,
      `${nodesAfterCopy} → ${afterDelete} → ${afterUndoDelete}`,
    )

    await evalJs(`fetch('/api/projects/${interactions.id}', { method: 'DELETE' })`)

    /* ------------------------------------------------------ undo depth --- */

    const depthProject = await createPlan('blank', 'Undo depth checks')
    await goto(`/p/${depthProject.id}/model`, '.canvas-view')
    for (let index = 0; index < 55; index += 1) {
      await click('.palette-item.kind-custom', 0, true)
    }
    const afterAdds = await countOf('.node')
    for (let index = 0; index < 60; index += 1) {
      await key(2, 'z', 'KeyZ', 90)
    }
    await sleep(500)
    const afterUndos = await countOf('.node')
    check(
      'undo history holds the most recent 50 snapshots',
      afterAdds === 55 && afterUndos === 6,
      `${afterAdds} blocks after 55 adds, ${afterUndos} after 60 undos (expected 6)`,
    )
    await evalJs(`fetch('/api/projects/${depthProject.id}', { method: 'DELETE' })`)

    /* -------------------------------------------------------- dashboard --- */

    await goto('/', '.dashboard')
    const card = await evalJs(`(() => {
      const element = document.querySelector('.project-card')
      if (!element) return null
      return {
        name: element.querySelector('h2')?.textContent?.trim() ?? '',
        pill: element.querySelector('.stage-pill')?.textContent?.trim() ?? '',
        brief: element.querySelector('.card-brief')?.textContent?.trim() ?? '',
        metrics: [...element.querySelectorAll('.card-metrics dd')].map((dd) => dd.textContent.trim()),
        spark: element.querySelectorAll('.sparkbars i').length,
      }
    })()`)
    check(
      'dashboard card shows name, brief, stage, params, team, milestone and sparkline',
      Boolean(card) &&
        card.name.length > 0 &&
        card.brief.length > 0 &&
        card.pill.length > 0 &&
        card.metrics.length === 3 &&
        card.metrics.every((value) => value.length > 0) &&
        card.spark >= 1,
      card ? `${card.name} · ${card.pill} · ${card.metrics.join(' / ')} · ${card.spark} bars` : 'no card',
    )

    /* ------------------------------------------------------------ layout --- */

    await send('Emulation.setDeviceMetricsOverride', {
      width: 760,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })

    const layoutPaths = [
      ['/', '.dashboard'],
      [`/p/${projectId}/model`, '.canvas-compact'],
      [`/p/${projectId}/pipeline`, '.pipeline-view'],
      [`/p/${projectId}/team`, '.team-view'],
      [`/p/${projectId}/evals`, '.evals-view, .page'],
    ]
    const overflow = []
    for (const [path, selector] of layoutPaths) {
      await goto(path, selector)
      await sleep(350)
      const metrics = await evalJs(`(() => {
        const doc = document.documentElement
        const bar = document.querySelector('.topbar')?.getBoundingClientRect()
        const rail = document.querySelector('.rail')?.getBoundingClientRect()
        return {
          width: window.innerWidth,
          scrollWidth: doc.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          barRight: bar ? bar.right : null,
          barHeight: bar ? bar.height : null,
          railLeft: rail ? rail.left : null,
        }
      })()`)
      const ok =
        metrics.scrollWidth <= metrics.width + 1 &&
        metrics.bodyScrollWidth <= metrics.width + 1 &&
        (metrics.barRight === null || metrics.barRight <= metrics.width + 1) &&
        (metrics.railLeft === null || metrics.railLeft >= -1)
      if (!ok) overflow.push(`${path} (doc ${metrics.scrollWidth}px vs ${metrics.width}px)`)
      check(
        `no horizontal overflow or clipped chrome at 760px — ${path}`,
        ok,
        `doc ${metrics.scrollWidth}/${metrics.width}px, topbar right ${metrics.barRight}px`,
      )
    }

    await send('Emulation.clearDeviceMetricsOverride')

    // Leave the dev database as we found it.
    await evalJs(`fetch('/api/projects/${projectId}', { method: 'DELETE' }).then((r) => r.ok)`)
      .catch(() => {})

    check('no uncaught page exceptions during the run', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
  } finally {
    try {
      await send('Browser.close', {}, undefined)
    } catch {
      /* ignore */
    }
    chrome.kill()
    await sleep(300)
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

try {
  await main()
} catch (error) {
  console.error('\nFATAL:', error instanceof Error ? error.stack ?? error.message : error)
  results.push({ name: 'suite completed', ok: false, detail: String(error) })
}

const failed = results.filter((result) => !result.ok)
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} failed` : ''}`,
)
if (failed.length) {
  for (const failure of failed) console.log(`  FAILED ${failure.name} — ${failure.detail}`)
  process.exit(1)
}
