import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { start } from '../server/index.js'

function cookieFrom(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || '']
  const match = /md=([^;]+)/.exec(list.join(';'))
  return match ? `md=${match[1]}` : ''
}

function client(port) {
  const jar = { cookie: '' }
  return {
    jar,
    async call(method, path, body) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', cookie: jar.cookie },
        body: body ? JSON.stringify(body) : undefined,
      })
      const next = cookieFrom(res)
      if (next) jar.cookie = next
      const data = await res.json().catch(() => ({}))
      return { status: res.status, data }
    },
  }
}

function openSocket(port, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Cookie: cookie } })
    const inbox = []
    ws.on('message', (buf) => inbox.push(JSON.parse(String(buf))))
    ws.on('open', () => resolve({
      ws,
      send(msg) { ws.send(JSON.stringify(msg)) },
      async waitFor(pred, ms = 4000) {
        const startAt = Date.now()
        while (Date.now() - startAt < ms) {
          const found = inbox.find(pred)
          if (found) return found
          await new Promise((r) => setTimeout(r, 20))
        }
        throw new Error('timed out waiting for a message')
      },
    }))
    ws.on('error', reject)
  })
}

test('two players can start, and bot buttons put friends together or apart', async () => {
  const app = await start({ port: 0, dbPath: ':memory:' })
  try {
    const ada = client(app.port)
    const bea = client(app.port)
    const made = await ada.call('POST', '/api/signup', { username: 'Ada', password: 'secret' })
    const beaUser = await bea.call('POST', '/api/signup', { username: 'Bea', password: 'secret' })
    assert.equal(made.status, 200)
    assert.equal((await ada.call('POST', '/api/friends', { username: 'Bea' })).status, 200)
    const notes = await bea.call('GET', '/api/notifications')
    assert.equal((await bea.call('POST', `/api/notifications/${notes.data.notifications[0].id}/respond`, { action: 'accept' })).status, 200)

    const sockA = await openSocket(app.port, ada.jar.cookie)
    const sockB = await openSocket(app.port, bea.jar.cookie)
    await sockA.waitFor((m) => m.t === 'ready')
    sockA.send({ t: 'friend-match', ids: [beaUser.data.user.id] })
    const note = await sockB.waitFor((m) => m.t === 'note' && m.note.kind === 'match_invite')
    sockB.send({ t: 'join', code: note.note.payload.roomCode })
    await sockA.waitFor((m) => m.t === 'room' && m.players.length === 2)
    sockA.send({ t: 'start' })
    const started = await sockA.waitFor((m) => m.t === 'start')
    assert.equal(started.snap.mode, '1v1')
    assert.equal(started.snap.players.length, 2)
    assert.equal(started.snap.players.some((p) => p.bot), false)

    sockA.send({ t: 'leave' })
    sockB.send({ t: 'leave' })
    await sockA.waitFor((m) => m.t === 'left')
    sockA.send({ t: 'host', mode: '3v3', minutes: 3, clubOnly: false, practice: false })
    const room = await sockA.waitFor((m) => m.t === 'room' && m.mode === '3v3')
    sockB.send({ t: 'join', code: room.code })
    await sockA.waitFor((m) => m.t === 'room' && m.players.length === 2 && m.mode === '3v3')
    sockA.send({ t: 'start', bots: 'same', difficulty: 'easy' })
    const versus = await sockA.waitFor((m) => m.t === 'start' && m.snap.mode === '2v2')
    const adaId = String(made.data.user.id)
    const beaId = String(beaUser.data.user.id)
    const humans = versus.snap.players.filter((p) => p.id === adaId || p.id === beaId)
    assert.equal(humans.length, 2)
    assert.equal(humans.every((p) => p.team === humans[0].team), true)
    assert.equal(versus.snap.players.filter((p) => p.bot && p.team !== humans[0].team).length, 2)

    sockA.send({ t: 'leave' })
    sockB.send({ t: 'leave' })
    await sockA.waitFor((m) => m.t === 'left')
    sockA.send({ t: 'host', mode: '3v3', minutes: 3, clubOnly: false, practice: false })
    const again = await sockA.waitFor((m) => m.t === 'room' && m.mode === '3v3' && m.code !== room.code)
    sockB.send({ t: 'join', code: again.code })
    await sockA.waitFor((m) => m.t === 'room' && m.players.length === 2 && m.code === again.code)
    sockA.send({ t: 'start', bots: 'mix', difficulty: 'easy' })
    const mixed = await sockB.waitFor((m) => m.t === 'start' && m.snap.mode === '2v2' && m.snap.id !== versus.snap.id)
    const adaP = mixed.snap.players.find((p) => p.id === adaId)
    const beaP = mixed.snap.players.find((p) => p.id === beaId)
    assert.notEqual(adaP.team, beaP.team)
    assert.equal(mixed.snap.players.filter((p) => p.bot).length, 2)
  } finally {
    await app.close()
  }
})
