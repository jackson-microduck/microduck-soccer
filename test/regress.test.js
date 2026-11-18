import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { DatabaseSync } from 'node:sqlite'
import { validLogo } from '../server/auth.js'
import { openDatabase } from '../server/db.js'
import { start } from '../server/index.js'

process.env.ALLOW_TEST_HOOKS = '1'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAgICAgJCAkKCgkNDgwODRMREBARExUTFRMWGxsbGB8bHx8bHRsbHiAkIyQnJykwLykpLDEwOj1BREFCQUJCQ0RD/8QAtQABAAEFAQABAAAAAAAAAAAAAAABAgMEBQYHCAkK/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSPz/9oADAMBAAIRAxEAPwD/2Q=='
const MAKER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

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

test('a real drawn logo is stored as text, and bad values are not booleans in SQLite', () => {
  assert.equal(typeof validLogo(PNG), 'string')
  assert.equal(typeof validLogo(JPEG), 'string')
  assert.equal(validLogo(true), false)
  assert.equal(validLogo(PNG).startsWith('data:image/png;base64,'), true)
  const db = openDatabase(':memory:')
  let threw = false
  try { db.prepare('CREATE TABLE t (v)').run() } catch { threw = true }
  assert.equal(threw, false)
  assert.throws(() => db.prepare('INSERT INTO users (username, password_hash, color, created_at) VALUES (?, ?, ?, ?)').run('A', 'b', true, 'now'), /boolean/)
})

test('an existing league.sqlite from before this fix still opens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-old-'))
  const file = path.join(dir, 'league.sqlite')
  const old = new DatabaseSync(file)
  old.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#ff6a1a',
      rating INTEGER NOT NULL DEFAULT 1000,
      goals INTEGER NOT NULL DEFAULT 0,
      assists INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      draws INTEGER NOT NULL DEFAULT 0,
      matches_played INTEGER NOT NULL DEFAULT 0,
      club_id INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE clubs (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      owner_id INTEGER NOT NULL,
      logo TEXT,
      created_at TEXT NOT NULL
    );
  `)
  old.prepare('INSERT INTO users (username, password_hash, color, created_at) VALUES (?, ?, ?, ?)').run('OldPlayer', 'hash', '#ff6a1a', '2024-01-01T00:00:00.000Z')
  old.close()
  const again = openDatabase(file)
  const user = again.prepare('SELECT username, rating FROM users WHERE username = ?').get('OldPlayer')
  assert.equal(user.username, 'OldPlayer')
  assert.equal(user.rating, 1000)
  assert.equal(again.prepare('PRAGMA user_version').get().user_version, 1)
  again.close()
})

test('club create, open, logos, invites, leaderboard, join code, leave', async () => {
  const app = await start({ port: 0, dbPath: ':memory:' })
  try {
    const boom = await fetch(`http://127.0.0.1:${app.port}/api/test-boom`)
    const boomBody = await boom.json()
    assert.equal(boom.status, 500)
    assert.equal(boomBody.error, 'Boom from the server')

    const ada = client(app.port)
    const bea = client(app.port)
    const cy = client(app.port)
    assert.equal((await ada.call('POST', '/api/signup', { username: 'Ada', password: 'secret', color: '#ff6a1a' })).status, 200)
    assert.equal((await bea.call('POST', '/api/signup', { username: 'Bea', password: 'secret' })).status, 200)
    assert.equal((await cy.call('POST', '/api/signup', { username: 'Cyra', password: 'secret' })).status, 200)

    assert.equal((await ada.call('POST', '/api/logout', {})).status, 200)
    assert.equal((await ada.call('GET', '/api/me')).data.user, null)
    const relog = await ada.call('POST', '/api/login', { username: 'ada', password: 'secret' })
    assert.equal(relog.status, 200)
    assert.equal(relog.data.user.username, 'Ada')

    const found = await ada.call('GET', '/api/players?q=be')
    assert.equal(found.data.players.length, 1)
    assert.equal(found.data.players[0].username, 'Bea')
    const profile = await ada.call('GET', '/api/players/Bea')
    assert.equal(profile.data.player.rank.length > 0, true)
    assert.equal(JSON.stringify(profile.data).includes('password'), false)

    const created = await ada.call('POST', '/api/clubs', { name: 'Pond United' })
    assert.equal(created.status, 200)
    const clubId = created.data.club.id
    const code = created.data.club.code
    const opened = await ada.call('GET', '/api/clubs/mine')
    assert.equal(opened.status, 200)
    assert.equal(opened.data.club.name, 'Pond United')
    assert.equal(opened.data.club.members.length, 1)
    const byId = await ada.call('GET', `/api/clubs/${clubId}`)
    assert.equal(byId.data.club.code, code)
    const hidden = await bea.call('GET', `/api/clubs/${clubId}`)
    assert.equal(hidden.data.club.code, null)
    assert.equal((await ada.call('GET', '/api/clubs/nope')).status, 404)

    const badLogo = await ada.call('POST', '/api/clubs/logo', { logo: true })
    assert.equal(badLogo.status, 400)
    assert.match(badLogo.data.error, /PNG or JPEG/)
    assert.equal(badLogo.status !== 500, true)

    const drawn = await ada.call('POST', '/api/clubs/logo', { logo: PNG })
    assert.equal(drawn.status, 200, JSON.stringify(drawn.data))
    assert.equal(typeof drawn.data.club.logo, 'string')
    assert.equal(drawn.data.club.logo.startsWith('data:image/png;base64,'), true)

    const uploaded = await ada.call('POST', '/api/clubs/logo', { logo: JPEG })
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data))
    assert.equal(uploaded.data.club.logo.startsWith('data:image/jpeg;base64,'), true)

    const made = await ada.call('POST', '/api/clubs/logo', { logo: MAKER })
    assert.equal(made.status, 200, JSON.stringify(made.data))
    assert.equal(made.data.club.logo.startsWith('data:image/png;base64,'), true)

    assert.equal((await bea.call('POST', '/api/clubs/logo', { logo: PNG })).status, 400)

    const invite = await ada.call('POST', '/api/clubs/invites', { username: 'bea' })
    assert.equal(invite.status, 200)
    const notes = await bea.call('GET', '/api/notifications')
    assert.match(notes.data.notifications[0].body, /Ada invited you to join Pond United/)
    const cyInvite = await ada.call('POST', '/api/clubs/invites', { username: 'Cyra' })
    assert.equal(cyInvite.status, 200)
    const cyNotes = await cy.call('GET', '/api/notifications')
    const cyNote = cyNotes.data.notifications.find((n) => n.kind === 'club_invite')
    const no = await cy.call('POST', `/api/notifications/${cyNote.id}/respond`, { action: 'decline' })
    assert.equal(no.data.notification.status, 'declined')
    assert.equal(no.data.user.club, null)
    const own = await cy.call('POST', '/api/clubs', { name: 'Other Pond' })
    assert.equal(own.status, 200)
    assert.equal(own.data.club.name, 'Other Pond')

    const yes = await bea.call('POST', `/api/notifications/${notes.data.notifications[0].id}/respond`, { action: 'accept' })
    assert.equal(yes.status, 200, JSON.stringify(yes.data))
    assert.equal(yes.data.user.club.name, 'Pond United')

    app.db.prepare('UPDATE users SET rating = ? WHERE username = ?').run(1400, 'Bea')
    const board = await ada.call('GET', '/api/clubs/mine')
    assert.deepEqual(board.data.club.members.map((m) => m.username), ['Bea', 'Ada'])
    assert.equal(board.data.club.members[0].rating, 1400)

    const outsider = client(app.port)
    await outsider.call('POST', '/api/signup', { username: 'Dee', password: 'secret' })
    const joined = await outsider.call('POST', '/api/clubs/join', { code: code.toLowerCase() })
    assert.equal(joined.status, 200)
    assert.equal(joined.data.club.members.length, 3)

    const left = await outsider.call('POST', '/api/clubs/leave', {})
    assert.equal(left.status, 200)
    assert.equal(left.data.user.club, null)
    const after = await ada.call('GET', '/api/clubs/mine')
    assert.equal(after.data.club.members.some((m) => m.username === 'Dee'), false)
  } finally {
    await app.close()
  }
})

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
        throw new Error('timed out')
      },
    }))
    ws.on('error', reject)
  })
}

test('5 minute bot matches and separate 3 minute queues', async () => {
  const app = await start({ port: 0, dbPath: ':memory:' })
  try {
    const people = []
    for (const name of ['Ash', 'Bay', 'Cam']) {
      const c = client(app.port)
      assert.equal((await c.call('POST', '/api/signup', { username: name, password: 'secret' })).status, 200)
      people.push(c)
    }
    const socks = []
    for (const c of people) {
      const sock = await openSocket(app.port, c.jar.cookie)
      await sock.waitFor((m) => m.t === 'ready')
      socks.push(sock)
    }
    socks[0].send({ t: 'bots', mode: '1v1', minutes: 5, difficulty: 'easy' })
    const started = await socks[0].waitFor((m) => m.t === 'start')
    assert.equal(started.snap.minutes, 5)
    assert.equal(started.snap.duration, 300)
    assert.ok(started.snap.clock > 298)
    assert.equal(started.snap.ranked, false)
    socks[0].send({ t: 'hook-end' })
    await socks[0].waitFor((m) => m.t === 'end')

    socks[0].send({ t: 'queue', mode: '1v1', minutes: 3 })
    socks[1].send({ t: 'queue', mode: '1v1', minutes: 3 })
    socks[2].send({ t: 'queue', mode: '1v1', minutes: 5 })
    const match = await socks[0].waitFor((m) => m.t === 'start' && m.snap?.minutes === 3)
    assert.equal(match.snap.minutes, 3)
    assert.equal(match.snap.ranked, true)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(socks[2].inbox.some((m) => m.t === 'start'), false)
    const queued = socks[2].inbox.filter((m) => m.t === 'queue').at(-1)
    assert.equal(queued.minutes, 5)
    assert.equal(queued.count, 1)
    for (const sock of socks) sock.ws.close()
  } finally {
    await app.close()
  }
})
