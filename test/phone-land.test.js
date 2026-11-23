import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { start } from '../server/index.js'

function chromeBin() {
  for (const candidate of ['/usr/local/bin/google-chrome', '/usr/bin/google-chrome']) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

test('landscape phone thumbstick, hud, and safe area', { timeout: 60000 }, async (t) => {
  const bin = chromeBin()
  if (!bin) { t.skip('chrome is not installed'); return }
  const app = await start({ port: 0, dbPath: ':memory:' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-land-'))
  const chrome = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    `--user-data-dir=${dir}/profile`,
    '--remote-debugging-port=9344',
    '--window-size=844,390',
    'about:blank',
  ], { stdio: 'ignore' })
  let ws
  try {
    let page
    for (let i = 0; i < 40 && !page; i++) {
      await sleep(150)
      try {
        const list = await fetch('http://127.0.0.1:9344/json').then((r) => r.json())
        page = list.find((item) => item.type === 'page')
      } catch { /* chrome is still booting */ }
    }
    if (!page) throw new Error('chrome did not open')
    ws = new WebSocket(page.webSocketDebuggerUrl)
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    })
    const send = (method, params = {}) => new Promise((resolve) => {
      const mine = ++id
      pending.set(mine, resolve)
      ws.send(JSON.stringify({ id: mine, method, params }))
    })
    await new Promise((r) => ws.addEventListener('open', r))
    await send('Runtime.enable')
    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', {
      width: 844, height: 390, deviceScaleFactor: 2, mobile: true,
    })
    await send('Emulation.setTouchEmulationEnabled', { enabled: true })
    const evalJs = async (expression) => {
      const msg = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.text || 'page error')
      return msg.result?.result?.value
    }
    const click = async (text) => {
      const result = await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x => x.textContent.trim()===${JSON.stringify(text)}); if(!b) return 'missing'; b.click(); return 'ok' })()`)
      if (result !== 'ok') throw new Error(`${text}: ${result}`)
    }
    await send('Page.navigate', { url: `http://127.0.0.1:${app.port}/` })
    await sleep(1000)
    await click('New player')
    await evalJs(`(() => { document.querySelector('input[autocomplete=username]').value='Lane'; document.querySelector('input[type=password]').value='secret'; return 1 })()`)
    await click('Create player')
    await sleep(600)
    await click('Play vs bots')
    await sleep(250)
    await click('Play vs bots')
    await sleep(700)
    await click('Phone controls')
    await sleep(500)
    const report = await evalJs(`(() => {
      const stick = document.getElementById('stick')
      const before = getComputedStyle(stick).display
      const match = document.getElementById('match')
      const down = (x, y, id) => match.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: id, pointerType: 'touch' }))
      const move = (x, y, id) => window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: id, pointerType: 'touch' }))
      const up = (x, y, id) => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: id, pointerType: 'touch' }))
      down(90, 300, 3)
      const shown = getComputedStyle(stick).display
      const box = stick.getBoundingClientRect()
      move(92, 296, 3)
      const deadKnob = parseFloat(document.getElementById('knob').style.top)
      const deadSprint = stick.dataset.sprint
      move(90, 220, 3)
      const knob = parseFloat(document.getElementById('knob').style.top)
      const sprint = stick.dataset.sprint
      up(90, 220, 3)
      const after = getComputedStyle(stick).display
      down(700, 200, 4)
      const rightIgnored = getComputedStyle(stick).display
      up(700, 200, 4)
      const pad = [...document.querySelectorAll('#pad button')].map(b => b.textContent).join(',')
      const leave = document.getElementById('leave-btn').getBoundingClientRect()
      const score = document.getElementById('scorebug').getBoundingClientRect()
      const matchBox = match.getBoundingClientRect()
      return {
        before, shown, after, rightIgnored, pad, knob, deadKnob, deadSprint, sprint,
        stickLeft: box.left, stickTop: box.top,
        leaveLeft: leave.left, scoreH: score.height, scoreW: score.width,
        matchH: matchBox.height, matchW: matchBox.width,
        phone: document.body.classList.contains('phone'),
        portrait: document.body.classList.contains('portrait'),
      }
    })()`)
    assert.equal(report.phone, true, JSON.stringify(report))
    assert.equal(report.portrait, false, JSON.stringify(report))
    assert.equal(report.before, 'none', JSON.stringify(report))
    assert.equal(report.shown, 'block', JSON.stringify(report))
    assert.ok(Math.abs(report.stickLeft + 48 - 90) < 8, JSON.stringify(report))
    assert.ok(Math.abs(report.stickTop + 48 - 300) < 8, JSON.stringify(report))
    assert.equal(report.deadSprint, '0', JSON.stringify(report))
    assert.ok(Math.abs(report.deadKnob - 28) < 6, JSON.stringify(report))
    assert.ok(report.knob < 12, JSON.stringify(report))
    assert.equal(report.sprint, '1', JSON.stringify(report))
    assert.equal(report.after, 'none', JSON.stringify(report))
    assert.equal(report.rightIgnored, 'none', JSON.stringify(report))
    assert.doesNotMatch(report.pad, /Sprint/)
    assert.match(report.pad, /Tackle|Shoot/)
    assert.ok(report.leaveLeft >= 20, JSON.stringify(report))
    assert.ok(report.scoreH < 52, JSON.stringify(report))
    assert.ok(report.matchH >= 370 && report.matchW >= 800, JSON.stringify(report))
  } finally {
    if (ws) ws.close()
    chrome.kill('SIGKILL')
    await app.close()
  }
})
