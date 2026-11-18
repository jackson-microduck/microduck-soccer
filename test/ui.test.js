import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { start } from '../server/index.js'

process.env.ALLOW_TEST_HOOKS = '1'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function chromeBin() {
  for (const candidate of ['/usr/local/bin/google-chrome', '/usr/bin/google-chrome', 'google-chrome']) {
    if (candidate.includes('/') && fs.existsSync(candidate)) return candidate
  }
  return null
}

test('headless browser clicks signup, club logos, and a bot match', { timeout: 90000 }, async (t) => {
  const bin = chromeBin()
  if (!bin) {
    t.skip('chrome is not installed')
    return
  }
  const app = await start({ port: 0, dbPath: ':memory:' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-chrome-'))
  const pngFile = path.join(dir, 'logo.png')
  fs.writeFileSync(pngFile, Buffer.from(PNG.split(',')[1], 'base64'))
  const chrome = spawn(bin, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--user-data-dir=${dir}/profile`,
    '--remote-debugging-port=9333',
    '--window-size=1280,800',
    'about:blank',
  ], { stdio: 'ignore' })
  const errors = []
  let ws
  try {
    const page = await waitForPage()
    ws = new WebSocket(page.webSocketDebuggerUrl)
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      } else if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'exception')
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        const text = msg.params.args.map((a) => a.value || a.description || '').join(' ')
        if (!/WebGL|GPU stall/i.test(text)) errors.push(text)
      }
    })
    const send = (method, params = {}) => new Promise((resolve) => {
      const mine = ++id
      pending.set(mine, resolve)
      ws.send(JSON.stringify({ id: mine, method, params }))
    })
    await new Promise((r) => ws.addEventListener('open', r))
    await send('Runtime.enable')
    await send('Page.enable')
    await send('DOM.enable')
    const evalJs = async (expression) => {
      const msg = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (msg.result?.exceptionDetails) {
        throw new Error(msg.result.exceptionDetails.exception?.description || 'page error')
      }
      return msg.result?.result?.value
    }
    const click = async (text) => {
      const result = await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x => x.textContent.trim()===${JSON.stringify(text)}); if(!b) return 'missing'; b.click(); return 'ok' })()`)
      if (result !== 'ok') throw new Error(`button ${text}: ${result}`)
    }
    await send('Page.navigate', { url: `http://127.0.0.1:${app.port}/` })
    await sleep(1200)
    await click('New player')
    await sleep(200)
    await evalJs(`(() => { document.querySelector('input[autocomplete=username]').value='Remy'; document.querySelector('input[type=password]').value='secret'; return 1 })()`)
    await click('Create player')
    await sleep(800)
    assert.match(await evalJs('document.body.innerText'), /Hey Remy/)

    await click('Log out')
    await sleep(400)
    assert.match(await evalJs('document.body.innerText'), /Welcome back/)
    await evalJs(`(() => { document.querySelector('input[autocomplete=username]').value='Remy'; document.querySelector('input[type=password]').value='secret'; return 1 })()`)
    await click('Log in')
    await sleep(500)
    assert.match(await evalJs('document.body.innerText'), /Hey Remy/)

    await click('Find friends')
    await sleep(300)
    await evalJs(`(() => { const box=document.querySelector('input[type=search]'); box.value='Rem'; box.dispatchEvent(new Event('input',{bubbles:true})); return 1 })()`)
    await sleep(500)
    assert.match(await evalJs('document.body.innerText'), /Remy/)

    await evalJs(`document.querySelector('.brand').click()`)
    await sleep(300)
    await click('Club')
    await sleep(200)
    await evalJs(`(() => { document.querySelector('input').value='Pond United'; return 1 })()`)
    await click('Create club')
    await sleep(600)
    assert.match(await evalJs('document.body.innerText'), /Pond United/)
    assert.match(await evalJs('document.body.innerText'), /Leaderboard/)

    await click('Use this logo')
    await sleep(700)
    const afterDraw = await evalJs('document.body.innerText')
    assert.equal(afterDraw.includes('Something went wrong'), false, afterDraw.slice(0, 300))
    assert.match(afterDraw, /Logo saved|Pond United/)
    const drawnSrc = await evalJs(`document.querySelector('.member img')?.src || ''`)
    assert.match(drawnSrc, /^data:image\/png;base64,/)

    await click('Maker')
    await sleep(200)
    await click('Use this emblem')
    await sleep(700)
    const afterMaker = await evalJs('document.body.innerText')
    assert.equal(afterMaker.includes('Something went wrong'), false, afterMaker.slice(0, 400))

    await click('Upload')
    await sleep(200)
    const doc = await send('DOM.getDocument')
    const found = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' })
    await send('DOM.setFileInputFiles', { nodeId: found.result.nodeId, files: [pngFile] })
    await sleep(300)
    await click('Use this photo')
    await sleep(700)
    const afterUpload = await evalJs('document.body.innerText')
    assert.equal(afterUpload.includes('Something went wrong'), false, afterUpload.slice(0, 400))

    const boom = await evalJs(`fetch('/api/test-boom').then(r => r.json()).then(d => d.error)`)
    assert.equal(boom, 'Boom from the server')

    await evalJs(`document.querySelector('.brand').click()`)
    await sleep(300)
    await click('Play vs bots')
    await sleep(300)
    await click('Create room')
    await sleep(500)
    const roomCode = await evalJs(`document.querySelector('.code')?.textContent?.trim() || ''`)
    assert.match(roomCode, /^[A-Z0-9]{6}$/)
    await click('Leave room')
    await sleep(400)
    await click('Play vs bots')
    await sleep(300)
    await click('5 min')
    await click('Hard')
    await click('Play vs bots')
    await sleep(400)
    await click('Phone controls')
    await click('Play')
    await sleep(250)
    const hud = await evalJs(`JSON.stringify({line:document.getElementById('club-line')?.textContent||'',clock:document.getElementById('clock')?.textContent||'',banner:document.getElementById('banner')?.innerText||'',pad:[...document.querySelectorAll('#pad button')].map(b=>b.textContent).join(','),touch:document.body.className})`)
    assert.match(hud, /Bots · Hard/)
    assert.match(hud, /5:0|4:5/)
    assert.match(hud, /Sprint/)
    assert.match(hud, /Kick/)
    assert.match(hud, /Slide/)
    assert.match(hud, /Spin/)
    assert.match(hud, /touch/)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'ShiftLeft', key: 'Shift', windowsVirtualKeyCode: 16 })
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 })
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyK', key: 'k', windowsVirtualKeyCode: 75 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyK', key: 'k', windowsVirtualKeyCode: 75 })
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyC', key: 'c', windowsVirtualKeyCode: 67 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyC', key: 'c', windowsVirtualKeyCode: 67 })
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyQ', key: 'q', windowsVirtualKeyCode: 81 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyQ', key: 'q', windowsVirtualKeyCode: 81 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'ShiftLeft', key: 'Shift', windowsVirtualKeyCode: 16 })
    await sleep(400)

    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await evalJs('window.dispatchEvent(new Event("resize"))')
    await sleep(300)
    const layout = await evalJs(`(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right } }
      return { score: box(document.querySelector('.scorebug')), leave: box(document.getElementById('leave-btn')), help: box(document.getElementById('help-btn')), stick: box(document.getElementById('stick')), pad: box(document.getElementById('pad')), w: innerWidth }
    })()`)
    assert.ok(layout.leave.bottom <= layout.score.top + 4, JSON.stringify(layout))
    assert.ok(layout.help.bottom <= layout.score.top + 4, JSON.stringify(layout))
    assert.ok(layout.pad.left >= layout.stick.right - 8, JSON.stringify(layout))
    assert.ok(layout.pad.right <= layout.w + 1, JSON.stringify(layout))
    await evalJs(`document.getElementById('leave-btn').click()`)
    await sleep(300)
    assert.equal(errors.filter(Boolean).join('\n'), '')
  } finally {
    try { ws?.close() } catch { /* already closed */ }
    chrome.kill()
    await app.close()
  }
})

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch('http://127.0.0.1:9333/json').then((r) => r.json())
      const page = list.find((item) => item.type === 'page')
      if (page) return page
    } catch { /* chrome still booting */ }
    await sleep(150)
  }
  throw new Error('Chrome did not open a page')
}
