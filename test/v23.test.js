import test from 'node:test'
import assert from 'node:assert/strict'
import { start } from '../server/index.js'
import { openDatabase, creditSharedClub } from '../server/db.js'
import { BALL_R, GOAL_W, createMatch, step } from '../public/shared/game.js'

function cookieFrom(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || '']
  const match = /md=([^;]+)/.exec(list.join(';'))
  return match ? `md=${match[1]}` : ''
}

test('stun, posts, messages, replies, and shared club wins', async () => {
  const hit = createMatch({
    mode: '1v1', minutes: 3,
    players: [
      { id: '1', name: 'Ada', rating: 1000, team: 'A' },
      { id: '2', name: 'Bea', rating: 1000, team: 'B' },
    ],
  })
  hit.phase = 'play'
  const ada = hit.players[0]
  const bea = hit.players[1]
  ada.x = 0
  ada.z = 0
  ada.yaw = 0
  bea.x = 0.2
  bea.z = 0.2
  hit.ball.owner = bea.id
  ada.pressed.slide = true
  step(hit, 1 / 30)
  assert.ok(bea.stun > 0.9, `stun ${bea.stun}`)

  const wide = createMatch({
    mode: '1v1', minutes: 3,
    players: [
      { id: '1', name: 'Ada', rating: 1000, team: 'A' },
      { id: '2', name: 'Bea', rating: 1000, team: 'B' },
    ],
  })
  wide.phase = 'play'
  wide.ball.owner = null
  wide.ball.x = GOAL_W / 2 - 0.02
  wide.ball.y = BALL_R
  wide.ball.z = wide.length / 2 - 0.02
  wide.ball.vz = 4
  const missed = step(wide, 1 / 30).some((e) => e.type === 'goal')
  assert.equal(missed, false)

  const db = openDatabase(':memory:')
  const now = new Date().toISOString()
  await db.prepare('INSERT INTO clubs (name, code, owner_id, created_at) VALUES (?, ?, ?, ?)').run('Pond', 'POND', 1, now)
  await creditSharedClub(db, [
    { id: 1, bot: false, clubId: 1, team: 'A', result: 'win' },
    { id: 2, bot: false, clubId: 1, team: 'A', result: 'win' },
  ])
  const club = await db.prepare('SELECT wins FROM clubs WHERE id = ?').get(1)
  assert.equal(club.wins, 1)

  const app = await start({ port: 0, dbPath: ':memory:' })
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Ada', password: 'secret' }),
    })
    const cookie = cookieFrom(res)
    const me = await (await fetch(`http://127.0.0.1:${app.port}/api/me`, { headers: { cookie } })).json()
    await fetch(`http://127.0.0.1:${app.port}/api/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Bea', password: 'secret' }),
    })
    const found = await (await fetch(`http://127.0.0.1:${app.port}/api/players?q=Bea`, { headers: { cookie } })).json()
    const sent = await fetch(`http://127.0.0.1:${app.port}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ id: found.players[0].id, text: 'Hey Bea' }),
    })
    const thread = await sent.json()
    assert.equal(sent.status, 200)
    assert.equal(thread.messages[0].body, 'Hey Bea')
    await fetch(`http://127.0.0.1:${app.port}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ text: 'Post is sticky' }),
    })
    process.env.FEEDBACK_TOKEN = 'club-token'
    const reply = await fetch(`http://127.0.0.1:${app.port}/api/feedback/reply?token=club-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Ada', text: 'Fixed the post' }),
    })
    assert.equal(reply.status, 200)
    await fetch(`http://127.0.0.1:${app.port}/api/feedback/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ text: 'Thanks!' }),
    })
    const list = await (await fetch(`http://127.0.0.1:${app.port}/api/feedback?token=club-token`)).json()
    assert.equal(list.replies.some((row) => row.kind === 'player' && row.text === 'Thanks!'), true)
    assert.equal(me.user.goals, 0)
  } finally {
    delete process.env.FEEDBACK_TOKEN
    await app.close()
  }
})
