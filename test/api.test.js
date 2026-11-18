import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { start } from '../server/index.js'

process.env.ALLOW_TEST_HOOKS = '1'

function cookieFrom(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || '']
  const raw = list.join(';')
  const match = /md=([^;]+)/.exec(raw)
  return match ? `md=${match[1]}` : ''
}

function client(port, jar = { cookie: '' }) {
  return {
    jar,
    async call(method, path, body) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          cookie: jar.cookie,
        },
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
    ws.on('message', (buf) => {
      inbox.push(JSON.parse(String(buf)))
    })
    ws.on('open', () => resolve({
      ws,
      inbox,
      send(msg) { ws.send(JSON.stringify(msg)) },
      async waitFor(pred, ms = 4000) {
        const start = Date.now()
        while (Date.now() - start < ms) {
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

test('accounts, directory, clubs, invites, and a ranked 1v1', async () => {
  const app = await start({ port: 0, dbPath: ':memory:' })
  try {
    const ada = client(app.port)
    const bea = client(app.port)
    const cy = client(app.port)
    const bad = await ada.call('POST', '/api/signup', { username: 'a', password: 'secret' })
    assert.equal(bad.status, 400)
    const made = await ada.call('POST', '/api/signup', { username: 'Ada', password: 'secret', color: '#ff6a1a' })
    assert.equal(made.status, 200)
    assert.equal(made.data.user.username, 'Ada')
    assert.equal(made.data.user.password_hash, undefined)
    const dup = await client(app.port).call('POST', '/api/signup', { username: 'ada', password: 'other' })
    assert.equal(dup.status, 409)
    const wrong = await client(app.port).call('POST', '/api/login', { username: 'Ada', password: 'nope' })
    assert.equal(wrong.status, 401)
    assert.equal((await bea.call('POST', '/api/signup', { username: 'Bea', password: 'secret' })).status, 200)
    assert.equal((await cy.call('POST', '/api/signup', { username: 'Cyd', password: 'secret' })).status, 200)

    const found = await ada.call('GET', '/api/players?q=be')
    assert.equal(found.status, 200)
    assert.equal(found.data.players.length, 1)
    assert.equal(found.data.players[0].username, 'Bea')
    const dumped = JSON.stringify(found.data)
    assert.equal(dumped.includes('password'), false)
    assert.equal(dumped.includes('secret'), false)
    const me = await ada.call('GET', '/api/me')
    assert.equal(JSON.stringify(me.data).includes('password_hash'), false)

    const club = await ada.call('POST', '/api/clubs', { name: 'Pond United' })
    assert.equal(club.status, 200)
    const logo = await ada.call('POST', '/api/clubs/logo', { logo: 'data:image/png;base64,AAAA' })
    assert.equal(logo.status, 400)
    const invite = await ada.call('POST', '/api/clubs/invites', { username: 'Bea' })
    assert.equal(invite.status, 200)
    const notes = await bea.call('GET', '/api/notifications')
    assert.equal(notes.data.notifications.length, 1)
    assert.match(notes.data.notifications[0].body, /Ada invited you to join Pond United/)
    const accepted = await bea.call('POST', `/api/notifications/${notes.data.notifications[0].id}/respond`, { action: 'accept' })
    assert.equal(accepted.data.user.club.name, 'Pond United')

    const sockA = await openSocket(app.port, ada.jar.cookie)
    const sockB = await openSocket(app.port, bea.jar.cookie)
    await sockA.waitFor((m) => m.t === 'ready')
    sockA.send({ t: 'host', mode: '1v1', minutes: 3, clubOnly: true, practice: false })
    const room = await sockA.waitFor((m) => m.t === 'room')
    sockA.send({ t: 'invite', ids: [accepted.data.user.id] })
    const matchNote = await sockB.waitFor((m) => m.t === 'note')
    assert.match(matchNote.note.body, /Ada invited you to a match for Pond United/)
    assert.deepEqual(matchNote.note.payload.others, [])
    sockB.send({ t: 'join', code: room.code })
    await sockB.waitFor((m) => m.t === 'room' && m.players.length === 2)
    sockA.send({ t: 'start' })
    const started = await sockA.waitFor((m) => m.t === 'start')
    assert.equal(started.snap.mode, '1v1')
    assert.equal(started.snap.players.some((p) => p.goalie), false)

    const meId = String(made.data.user.id)
    let scored = false
    for (let i = 0; i < 160 && !scored; i++) {
      const snap = sockA.inbox.filter((m) => m.t === 'snap').at(-1)
      const meP = snap?.players?.find((p) => p.id === meId)
      const ball = snap?.ball
      let mx = 0
      let mz = 1
      let kick = 0
      if (meP && ball && ball.owner === meId && snap.phase === 'play') {
        const hl = snap.field.length / 2
        mx = -meP.x
        mz = (hl - 0.2) - meP.z
        const mag = Math.hypot(mx, mz) || 1
        mx /= mag
        mz /= mag
        if (Math.abs(meP.x) < 0.45) kick = i + 1
      } else if (meP && ball) {
        mx = ball.x - meP.x
        mz = ball.z - meP.z
        const mag = Math.hypot(mx, mz) || 1
        mx /= mag
        mz /= mag
      }
      sockA.send({ t: 'in', seq: i + 1, mx, mz, sprint: true, kick, pass: 0, slide: 0, spin: 0, dive: 0 })
      sockB.send({ t: 'in', seq: i + 1, mx: 1, mz: 0, sprint: false, kick: 0, pass: 0, slide: 0, spin: 0, dive: 0 })
      await new Promise((r) => setTimeout(r, 40))
      scored = sockA.inbox.some((m) => m.t === 'events' && m.events.some((e) => e.type === 'goal'))
    }
    assert.equal(scored, true)
    const goalSnap = [...sockA.inbox].reverse().find((m) => m.t === 'snap' && m.phase === 'celebrate')
    assert.ok(goalSnap)
    assert.ok(goalSnap.phaseT > 7)
    sockA.send({ t: 'hook-end' })
    const end = await sockA.waitFor((m) => m.t === 'end')
    assert.equal(end.ranked, true)
    assert.equal(end.score.A, 1)
    const after = await ada.call('GET', '/api/me')
    assert.equal(after.data.user.goals, 1)
    assert.equal(after.data.user.wins, 1)
    assert.equal(after.data.user.matches, 1)
    assert.ok(after.data.user.rating > 1000)
    sockA.ws.close()
    sockB.ws.close()
  } finally {
    await app.close()
  }
})

test('2v2 and 3v3 rooms assign goalies only for 3v3', async () => {
  const app = await start({ port: 0, dbPath: ':memory:' })
  try {
    const names = ['Ash', 'Bay', 'Cam', 'Dee', 'Eli', 'Fay']
    const people = []
    for (const name of names) {
      const c = client(app.port)
      const made = await c.call('POST', '/api/signup', { username: name, password: 'secret' })
      assert.equal(made.status, 200)
      people.push({ client: c, id: made.data.user.id, name })
    }
    async function play(mode, count) {
      const sockets = []
      for (let i = 0; i < count; i++) {
        sockets.push(await openSocket(app.port, people[i].client.jar.cookie))
        await sockets[i].waitFor((m) => m.t === 'ready')
      }
      sockets[0].send({ t: 'host', mode, minutes: 5, clubOnly: false, practice: false })
      const room = await sockets[0].waitFor((m) => m.t === 'room')
      for (let i = 1; i < count; i++) {
        sockets[i].send({ t: 'join', code: room.code })
        await sockets[i].waitFor((m) => m.t === 'room' && m.players.length === i + 1)
      }
      if (mode === '3v3') sockets[0].send({ t: 'goalie', on: true })
      sockets[0].send({ t: 'start' })
      const started = await sockets[0].waitFor((m) => m.t === 'start')
      const keepers = started.snap.players.filter((p) => p.goalie)
      assert.equal(started.snap.minutes, 5)
      assert.equal(keepers.length, mode === '3v3' ? 2 : 0)
      assert.equal(started.you.goalie, mode === '3v3')
      sockets[0].send({ t: 'hook-end' })
      await sockets[0].waitFor((m) => m.t === 'end')
      for (const sock of sockets) sock.ws.close()
    }
    await play('2v2', 4)
    await play('3v3', 6)
  } finally {
    await app.close()
  }
})
