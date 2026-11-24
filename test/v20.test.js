import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { start } from '../server/index.js'
import { rankFor } from '../public/shared/game.js'

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

test('friends accept incoming requests, parties survive reconnect, and ranks use goals', async () => {
  assert.equal(rankFor(0), 'Hatchling')
  assert.equal(rankFor(100), 'Drake')
  const app = await start({ port: 0, dbPath: ':memory:' })
  try {
    const ada = client(app.port)
    const bea = client(app.port)
    const made = await ada.call('POST', '/api/signup', { username: 'Ada', password: 'secret' })
    const beaUser = await bea.call('POST', '/api/signup', { username: 'Bea', password: 'secret' })
    assert.equal(made.data.user.rank, 'Hatchling')
    assert.equal(made.data.user.goals, 0)
    assert.equal((await ada.call('POST', '/api/friends', { username: 'Bea' })).status, 200)
    const accepted = await bea.call('POST', '/api/friends', { username: 'Ada' })
    assert.equal(accepted.data.accepted, true)
    assert.equal((await ada.call('GET', '/api/friends')).data.friends.length, 1)

    const sockA = await openSocket(app.port, ada.jar.cookie)
    const sockB = await openSocket(app.port, bea.jar.cookie)
    await sockA.waitFor((m) => m.t === 'ready')
    sockA.send({ t: 'party-create' })
    await sockA.waitFor((m) => m.t === 'party' && !m.clubId)
    sockA.send({ t: 'party-say', text: 'stay with me' })
    await sockA.waitFor((m) => m.t === 'party' && m.chat.some((line) => line.text === 'stay with me'))
    sockA.send({ t: 'party-invite', id: beaUser.data.user.id })
    const invite = await sockB.waitFor((m) => m.t === 'note' && m.note.kind === 'party_invite')
    sockB.send({ t: 'party-join', id: invite.note.payload.partyId })
    await sockB.waitFor((m) => m.t === 'party' && m.members.some((p) => p.name === 'Ada'))
    sockB.ws.close()
    const again = await openSocket(app.port, bea.jar.cookie)
    const restored = await again.waitFor((m) => m.t === 'party' && !m.clubId && m.chat.some((line) => line.text === 'stay with me'))
    assert.equal(restored.members.some((p) => p.name === 'Ada'), true)

    const club = await ada.call('POST', '/api/clubs', { name: 'Pond United' })
    await ada.call('POST', '/api/clubs/invites', { username: 'Bea' })
    const notes = await bea.call('GET', '/api/notifications')
    const clubNote = notes.data.notifications.find((n) => n.kind === 'club_invite')
    again.inbox.length = 0
    await bea.call('POST', `/api/notifications/${clubNote.id}/respond`, { action: 'accept' })
    const attached = await again.waitFor((m) => m.t === 'party' && m.clubId === club.data.club.id)
    assert.equal(attached.members.some((p) => p.name === 'Bea'), true)
    const goals = (await ada.call('GET', '/api/me')).data.user.goals
    assert.equal(goals, 0)
  } finally {
    await app.close()
  }
})
