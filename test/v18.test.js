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
      inbox,
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

test('party chat is saved, bot matches can be joined, and nicknames stay private', async () => {
  const app = await start({ port: 0, dbPath: ':memory:' })
  try {
    const ada = client(app.port)
    const bea = client(app.port)
    const cy = client(app.port)
    assert.equal((await ada.call('POST', '/api/signup', { username: 'Ada', password: 'secret' })).status, 200)
    const beaUser = await bea.call('POST', '/api/signup', { username: 'Bea', password: 'secret' })
    assert.equal(beaUser.status, 200)
    assert.equal((await cy.call('POST', '/api/signup', { username: 'Cyd', password: 'secret' })).status, 200)
    assert.equal((await ada.call('POST', '/api/clubs', { name: 'Pond United' })).status, 200)
    assert.equal((await ada.call('POST', '/api/clubs/invites', { username: 'Bea' })).status, 200)
    const notes = await bea.call('GET', '/api/notifications')
    assert.equal((await bea.call('POST', `/api/notifications/${notes.data.notifications[0].id}/respond`, { action: 'accept' })).status, 200)

    const sockA = await openSocket(app.port, ada.jar.cookie)
    const sockB = await openSocket(app.port, bea.jar.cookie)
    await sockA.waitFor((m) => m.t === 'party')
    await sockB.waitFor((m) => m.t === 'party')
    sockA.send({ t: 'party-say', text: 'hello pond' })
    const live = await sockB.waitFor((m) => m.t === 'party' && m.chat.some((line) => line.text === 'hello pond'))
    assert.equal(live.chat.some((line) => line.name === 'Ada' && line.text === 'hello pond'), true)
    sockB.ws.close()
    const again = await openSocket(app.port, bea.jar.cookie)
    const loaded = await again.waitFor((m) => m.t === 'party' && m.chat.some((line) => line.text === 'hello pond'))
    assert.equal(loaded.chat[0].text, 'hello pond')

    const nick = await ada.call('POST', '/api/nicknames', { username: 'Bea', nick: 'Bee' })
    assert.equal(nick.status, 200)
    assert.equal(nick.data.nicks[0].nick, 'Bee')
    const saved = await ada.call('GET', '/api/nicknames')
    assert.equal(saved.data.nicks[0].username, 'Bea')
    const hidden = await bea.call('GET', '/api/nicknames')
    assert.equal(hidden.data.nicks.length, 0)

    sockA.send({ t: 'host', mode: '1v1', minutes: 3, clubOnly: false, practice: false })
    await sockA.waitFor((m) => m.t === 'room')
    sockA.send({ t: 'invite-name', username: 'Bea' })
    const invite = await again.waitFor((m) => m.t === 'note' && m.note.kind === 'match_invite')
    assert.equal(invite.note.payload.roomCode.length > 0, true)

    sockA.send({ t: 'bots', mode: '1v1', minutes: 3, difficulty: 'easy', goalies: false })
    const botStart = await sockA.waitFor((m) => m.t === 'start')
    assert.equal(botStart.snap.players.some((p) => p.bot), true)
    again.send({ t: 'join-player', id: (await ada.call('GET', '/api/me')).data.user.id })
    const joined = await again.waitFor((m) => m.t === 'start' && m.snap.players.some((p) => p.name === 'Bea'))
    assert.equal(joined.snap.players.some((p) => p.bot), false)

    sockA.send({ t: 'leave' })
    again.send({ t: 'leave' })
    const sockC = await openSocket(app.port, cy.jar.cookie)
    sockC.send({ t: 'host', mode: '1v1', minutes: 3, clubOnly: false, practice: false })
    const room = await sockC.waitFor((m) => m.t === 'room')
    sockA.send({ t: 'join', code: room.code })
    await sockA.waitFor((m) => m.t === 'room' && m.players.length === 2)
    sockC.send({ t: 'start' })
    await sockC.waitFor((m) => m.t === 'start')
    again.send({ t: 'join-player', id: (await cy.call('GET', '/api/me')).data.user.id })
    const blocked = await again.waitFor((m) => m.t === 'error')
    assert.match(blocked.message, /humans only/)
  } finally {
    await app.close()
  }
})
