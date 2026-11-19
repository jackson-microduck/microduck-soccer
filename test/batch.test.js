import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { start } from '../server/index.js'

process.env.ALLOW_TEST_HOOKS = '1'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

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
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const next = cookieFrom(res)
      if (next && !String(next).includes('md=;')) jar.cookie = next
      const text = await res.text()
      let data = {}
      try { data = text ? JSON.parse(text) : {} } catch { data = { error: text.slice(0, 200) } }
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
      async waitFor(pred, ms = 3000) {
        const started = Date.now()
        while (Date.now() - started < ms) {
          const found = inbox.find(pred)
          if (found) return found
          await new Promise((r) => setTimeout(r, 20))
        }
        throw new Error(`timed out waiting in ${JSON.stringify(inbox.slice(-4))}`)
      },
    }))
    ws.on('error', reject)
  })
}

test('several clubs, owner ready, challenges, and ranks that skip bots', async () => {
  const app = await start({ port: 0, dbPath: ':memory:' })
  try {
    const ada = client(app.port)
    const bea = client(app.port)
    assert.equal((await ada.call('POST', '/api/signup', { username: 'Ada', password: 'secret' })).status, 200)
    assert.equal((await bea.call('POST', '/api/signup', { username: 'Bea', password: 'secret' })).status, 200)

    const pond = await ada.call('POST', '/api/clubs', { name: 'Pond United' })
    assert.equal(pond.status, 200)
    const second = await ada.call('POST', '/api/clubs', { name: 'Pond Two' })
    assert.equal(second.status, 200, JSON.stringify(second.data))
    const mine = await ada.call('GET', '/api/clubs/mine')
    assert.equal(mine.data.owned.length, 2)
    assert.equal(mine.data.club.name, 'Pond Two')

    const lake = await bea.call('POST', '/api/clubs', { name: 'Lake Town' })
    assert.equal(lake.status, 200)
    const joined = await bea.call('POST', '/api/clubs/join', { code: pond.data.club.code })
    assert.equal(joined.status, 200, JSON.stringify(joined.data))
    const both = await bea.call('GET', '/api/clubs/mine')
    assert.equal(both.data.owned.length, 1)
    assert.equal(both.data.joined.length, 1)
    assert.equal(both.data.joined[0].name, 'Pond United')
    assert.equal(both.data.club.name, 'Lake Town')

    const switched = await bea.call('POST', '/api/clubs/active', { id: pond.data.club.id })
    assert.equal(switched.status, 200)
    assert.equal(switched.data.user.club.name, 'Pond United')
    const logoDenied = await bea.call('POST', '/api/clubs/logo', { logo: PNG })
    assert.equal(logoDenied.status, 403)

    await ada.call('POST', '/api/clubs/active', { id: second.data.club.id })
    const saved = await ada.call('POST', '/api/clubs/logo', { logo: PNG })
    assert.equal(saved.status, 200)
    assert.equal(typeof saved.data.club.logo, 'string')
    const other = await ada.call('GET', `/api/clubs/${pond.data.club.id}`)
    assert.equal(other.data.club.logo, null)
    const invited = await ada.call('POST', '/api/clubs/invites', { username: 'Bea' })
    assert.equal(invited.status, 200, JSON.stringify(invited.data))
    const again = await bea.call('POST', '/api/clubs/join', { code: second.data.club.code })
    assert.equal(again.status, 200)

    for (let i = 3; i <= 8; i++) {
      const made = await ada.call('POST', '/api/clubs', { name: `Pond ${i}` })
      assert.equal(made.status, 200, JSON.stringify(made.data))
    }
    const tooMany = await ada.call('POST', '/api/clubs', { name: 'Pond Nine' })
    assert.equal(tooMany.status, 400)
    assert.match(tooMany.data.error, /8 clubs/)

    const now = '2024-01-01T00:00:00.000Z'
    const insertUser = app.db.prepare(
      'INSERT INTO users (username, password_hash, color, rating, is_bot, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (let i = 0; i < 11; i++) insertUser.run(`Star${i}`, 'x', '#ff6a1a', 2000, 0, now)
    insertUser.run('QuackBot', 'x', '#ff6a1a', 9000, 1, now)
    const insertClub = app.db.prepare(
      'INSERT INTO clubs (name, code, owner_id, created_at, wins, goals_for, goals_against) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    for (let i = 0; i < 12; i++) insertClub.run(`Giants ${i}`, `G${i}ZZ`, 1, now, 5, 10, 1)
    const board = await ada.call('GET', '/api/leaderboards')
    assert.equal(board.status, 200)
    assert.equal(board.data.players.some((p) => p.username === 'QuackBot'), false)
    assert.equal(board.data.players.some((p) => p.username === 'Ada'), false)
    assert.equal(board.data.you.username, 'Ada')
    assert.equal(board.data.you.rank, 12)
    assert.ok(board.data.yourClubs.length >= 8)
    assert.ok(board.data.yourClubs.every((club) => club.rank > 10))
    assert.equal(board.data.clubs[0].name.startsWith('Giants'), true)

    await ada.call('POST', '/api/clubs/active', { id: second.data.club.id })
    const declined = await ada.call('POST', '/api/clubs/challenge', {
      name: 'Lake Town', mode: '1v1', minutes: 3, goalies: false,
    })
    assert.equal(declined.status, 200)
    const beaNotes = await bea.call('GET', '/api/notifications')
    const challenge = beaNotes.data.notifications.find((n) => n.kind === 'club_challenge')
    assert.ok(challenge)
    const no = await bea.call('POST', `/api/notifications/${challenge.id}/respond`, { action: 'decline' })
    assert.equal(no.status, 200)
    const adaNotes = await ada.call('GET', '/api/notifications')
    assert.ok(adaNotes.data.notifications.some((n) => /declined/.test(n.body)))

    const adaSock = await openSocket(app.port, ada.jar.cookie)
    const beaSock = await openSocket(app.port, bea.jar.cookie)
    await adaSock.waitFor((m) => m.t === 'ready')
    await beaSock.waitFor((m) => m.t === 'ready')

    await ada.call('POST', '/api/clubs/active', { id: pond.data.club.id })
    adaSock.send({ t: 'host', mode: '1v1', minutes: 3, clubOnly: true, goalies: false })
    const room = await adaSock.waitFor((m) => m.t === 'room')
    beaSock.send({ t: 'join', code: room.code })
    await beaSock.waitFor((m) => m.t === 'room' && m.players.length === 2)
    adaSock.send({ t: 'start' })
    const early = await adaSock.waitFor((m) => m.t === 'error')
    assert.match(early.message, /ready/i)
    beaSock.send({ t: 'options', mode: '3v3', minutes: 5, goalies: true })
    const blocked = await beaSock.waitFor((m) => m.t === 'error' && /owner/.test(m.message))
    assert.match(blocked.message, /owner/i)
    adaSock.send({ t: 'options', mode: '1v1', minutes: 5, goalies: false })
    const updated = await adaSock.waitFor((m) => m.t === 'room' && m.minutes === 5)
    assert.equal(updated.minutes, 5)
    beaSock.send({ t: 'ready' })
    await adaSock.waitFor((m) => m.t === 'room' && m.players.some((p) => p.id !== room.hostId && p.ready))
    adaSock.send({ t: 'start' })
    await adaSock.waitFor((m) => m.t === 'start')
    adaSock.send({ t: 'hook-end' })
    await adaSock.waitFor((m) => m.t === 'end')

    const sent = await ada.call('POST', '/api/clubs/challenge', {
      name: 'Lake Town', mode: '1v1', minutes: 5, goalies: false,
    })
    assert.equal(sent.status, 200)
    const againNotes = await bea.call('GET', '/api/notifications')
    const live = againNotes.data.notifications.find((n) => n.kind === 'club_challenge')
    const yes = await bea.call('POST', `/api/notifications/${live.id}/respond`, { action: 'accept' })
    assert.equal(yes.status, 200, JSON.stringify(yes.data))
    assert.equal(typeof yes.data.roomCode, 'string')
    const adaRoom = await adaSock.waitFor((m) => m.t === 'room' && m.versus)
    assert.equal(adaRoom.versus, true)
    beaSock.send({ t: 'join', code: yes.data.roomCode })
    await beaSock.waitFor((m) => m.t === 'room' && m.versus && m.players.length === 2)
    adaSock.inbox.length = 0
    adaSock.send({ t: 'start' })
    const waitReady = await adaSock.waitFor((m) => m.t === 'error' && /ready/i.test(m.message))
    assert.match(waitReady.message, /ready/i)
    beaSock.send({ t: 'ready' })
    await adaSock.waitFor((m) => m.t === 'room' && m.players.every((p) => p.ready))
    adaSock.send({ t: 'start' })
    const versus = await adaSock.waitFor((m) => m.t === 'start' && m.snap.homeName === 'Pond United')
    assert.equal(versus.snap.awayName, 'Lake Town')
    adaSock.send({ t: 'hook-end' })
    await adaSock.waitFor((m) => m.t === 'end')
    const after = app.db.prepare('SELECT draws FROM clubs WHERE name = ?').get('Pond United')
    assert.equal(after.draws, 1)

    const adaAt = adaSock.inbox.length
    const beaAt = beaSock.inbox.length
    adaSock.send({ t: 'queue', mode: '3v3', minutes: 3, goalies: false })
    beaSock.send({ t: 'queue', mode: '3v3', minutes: 3, goalies: true })
    await adaSock.waitFor((m) => m.t === 'queue' && m.count === 1 && m.goalies === false)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(adaSock.inbox.slice(adaAt).some((m) => m.t === 'start'), false)
    assert.equal(beaSock.inbox.slice(beaAt).some((m) => m.t === 'start'), false)
    adaSock.send({ t: 'leave-queue' })
    beaSock.send({ t: 'leave-queue' })
    adaSock.send({ t: 'bots', mode: '3v3', minutes: 3, difficulty: 'easy', goalies: false })
    const bots = await adaSock.waitFor((m) => m.t === 'start' && m.snap?.mode === '3v3' && m.snap.goalies === false)
    assert.equal(bots.you.goalie, false)
    assert.equal(bots.snap.players.some((p) => p.goalie), false)
    adaSock.ws.close()
    beaSock.ws.close()
  } finally {
    await app.close()
  }
})
