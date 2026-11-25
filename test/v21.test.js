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
  return { jar, async call(method, path, body) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', cookie: jar.cookie },
      body: body ? JSON.stringify(body) : undefined,
    })
    const next = cookieFrom(res)
    if (next) jar.cookie = next
    return { status: res.status, data: await res.json().catch(() => ({})) }
  } }
}
function openSocket(port, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Cookie: cookie } })
    const inbox = []
    ws.on('message', (buf) => inbox.push(JSON.parse(String(buf))))
    ws.on('open', () => resolve({
      ws, inbox,
      send(msg) { ws.send(JSON.stringify(msg)) },
      async waitFor(pred, ms = 2500) {
        const startAt = Date.now()
        while (Date.now() - startAt < ms) {
          const found = inbox.find(pred)
          if (found) return found
          await new Promise((r) => setTimeout(r, 15))
        }
        throw new Error('timed out')
      },
    }))
    ws.on('error', reject)
  })
}

test('party with club invites online members and keeps saved goals', async () => {
  const app = await start({ port: 0, dbPath: ':memory:' })
  try {
    const ada = client(app.port)
    const bea = client(app.port)
    const made = await ada.call('POST', '/api/signup', { username: 'Ada', password: 'secret' })
    await bea.call('POST', '/api/signup', { username: 'Bea', password: 'secret' })
    const club = await ada.call('POST', '/api/clubs', { name: 'Pond United' })
    await ada.call('POST', '/api/clubs/invites', { username: 'Bea' })
    const notes = await bea.call('GET', '/api/notifications')
    await bea.call('POST', `/api/notifications/${notes.data.notifications[0].id}/respond`, { action: 'accept' })
    const sockA = await openSocket(app.port, ada.jar.cookie)
    const sockB = await openSocket(app.port, bea.jar.cookie)
    await sockA.waitFor((m) => m.t === 'ready')
    await sockB.waitFor((m) => m.t === 'ready')
    sockA.send({ t: 'party-club' })
    const opened = await sockA.waitFor((m) => m.t === 'party-open')
    const party = await sockA.waitFor((m) => m.t === 'party' && !m.clubId)
    assert.equal(opened.t, 'party-open')
    assert.equal(party.members.some((p) => p.name === 'Ada'), true)
    const invite = await sockB.waitFor((m) => m.t === 'note' && m.note.kind === 'party_invite')
    assert.equal(invite.note.payload.partyId, party.id)
    const me = await ada.call('GET', '/api/me')
    assert.equal(me.data.user.goals, made.data.user.goals)
    assert.equal(me.data.user.id, made.data.user.id)
    assert.equal((await ada.call('GET', '/api/clubs/mine')).data.club.id, club.data.club.id)
  } finally {
    await app.close()
  }
})
