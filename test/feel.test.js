import test from 'node:test'
import assert from 'node:assert/strict'
import { createMatch, step } from '../public/shared/game.js'
import { start } from '../server/index.js'

function duel() {
  const match = createMatch({
    mode: '1v1',
    minutes: 3,
    players: [
      { id: '1', name: 'Ada', rating: 1000, team: 'A' },
      { id: '2', name: 'Bea', rating: 1000, team: 'B' },
    ],
  })
  match.phase = 'play'
  return match
}

test('spin and a short moment after it cannot be tackled', () => {
  const match = duel()
  const carrier = match.players[0]
  const slider = match.players[1]
  carrier.x = 0
  carrier.z = 0
  match.ball.owner = carrier.id
  carrier.pressed.spin = true
  step(match, 1 / 30)
  assert.ok(carrier.spinning > 0)
  while (carrier.spinning > 0) step(match, 1 / 30)
  assert.ok(carrier.spinGuard > 0)
  carrier.x = 0
  carrier.z = 0
  slider.x = 0.05
  slider.z = 0
  slider.yaw = 0
  slider.pressed.slide = true
  let stolen = false
  for (let i = 0; i < 20; i++) {
    if (step(match, 1 / 30).some((e) => e.type === 'steal')) stolen = true
  }
  assert.equal(stolen, false)
  assert.equal(match.ball.owner, carrier.id)
  assert.ok(slider.stun > 0)
})

test('the ball carrier keeps their line when bumping a defender', () => {
  const match = duel()
  const carrier = match.players[0]
  const defender = match.players[1]
  carrier.x = 0
  carrier.z = 0
  defender.x = 0.12
  defender.z = 0
  match.ball.owner = carrier.id
  const cx = carrier.x
  const dx = defender.x
  step(match, 1 / 30)
  assert.ok(Math.abs(carrier.x - cx) < Math.abs(defender.x - dx))
})

test('bot accounts stay out of search, profiles, clubs, and invites', async () => {
  const app = await start({ port: 0, dbPath: ':memory:' })
  try {
    const signup = async (name) => {
      const res = await fetch(`http://127.0.0.1:${app.port}/api/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name, password: 'secret' }),
      })
      const cookie = res.headers.getSetCookie?.().join(';') || res.headers.get('set-cookie') || ''
      return { cookie: /md=[^;]+/.exec(cookie)?.[0] || '', user: (await res.json()).user }
    }
    const ada = await signup('Ada')
    const call = (cookie, method, path, body) => fetch(`http://127.0.0.1:${app.port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: body ? JSON.stringify(body) : undefined,
    })
    const club = await (await call(ada.cookie, 'POST', '/api/clubs', { name: 'Pond United' })).json()
    app.db.prepare(
      'INSERT INTO users (username, password_hash, color, is_bot, club_id, created_at) VALUES (?, ?, ?, 1, ?, ?)',
    ).run('Quackers', 'x', '#ffb000', club.club.id, new Date().toISOString())
    const search = await (await call(ada.cookie, 'GET', '/api/players?q=Quack')).json()
    assert.equal(search.players.length, 0)
    const profile = await call(ada.cookie, 'GET', '/api/players/Quackers')
    assert.equal(profile.status, 404)
    const invite = await call(ada.cookie, 'POST', '/api/clubs/invites', { username: 'Quackers' })
    assert.equal(invite.status, 404)
    const board = await (await call(ada.cookie, 'GET', '/api/clubs/mine')).json()
    assert.equal(board.club.members.some((m) => m.username === 'Quackers'), false)
  } finally {
    await app.close()
  }
})
