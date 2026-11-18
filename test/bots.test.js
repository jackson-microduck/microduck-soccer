import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createMatch, step } from '../public/shared/game.js'
import { driveBots } from '../server/bots.js'
import { start } from '../server/index.js'

process.env.ALLOW_TEST_HOOKS = '1'

function side(match, team) {
  return match.players.filter((p) => p.team === team)
}

function playable(match) {
  match.phase = 'play'
  match.phaseT = 0
  return match
}

test('bots chase, pass, shoot, slide, spin, sprint, and the goalie dives', () => {
  const attack = playable(createMatch({
    mode: '2v2',
    minutes: 3,
    ranked: false,
    difficulty: 'hard',
    players: [
      { id: 'bot-1', name: 'Quackers', rating: 1000, team: 'A', bot: true },
      { id: 'bot-2', name: 'Puddles', rating: 1000, team: 'A', bot: true },
      { id: 'bot-3', name: 'Nibbles', rating: 1000, team: 'B', bot: true },
      { id: 'bot-4', name: 'Scooter', rating: 1000, team: 'B', bot: true },
    ],
  }))
  const carrier = attack.players[0]
  const mate = attack.players[1]
  carrier.x = 0
  carrier.z = 0
  carrier.yaw = 0
  mate.x = 0.2
  mate.z = 2.1
  attack.players[2].x = 1.8
  attack.players[2].z = -1
  attack.players[3].x = -1.8
  attack.players[3].z = -1
  attack.ball.owner = carrier.id
  attack.elapsed = 1
  driveBots(attack)
  assert.equal(carrier.pressed.pass, true)
  const passed = step(attack, 1 / 30)
  assert.equal(passed.some((e) => e.type === 'goal'), false)
  assert.equal(attack.ball.owner, null)
  assert.equal(attack.ball.lastPass && attack.ball.lastPass.id, carrier.id)

  const shot = playable(createMatch({
    mode: '1v1',
    minutes: 3,
    ranked: false,
    difficulty: 'hard',
    players: [
      { id: 'bot-1', name: 'Quackers', rating: 1000, team: 'A', bot: true },
      { id: '1', name: 'Ada', rating: 1000, team: 'B' },
    ],
  }))
  const shooter = shot.players[0]
  shooter.x = 0
  shooter.z = shot.length / 2 - 1.35
  shooter.yaw = 0
  shot.ball.owner = shooter.id
  shot.players[1].x = 1.6
  shot.players[1].z = 0
  driveBots(shot)
  assert.equal(shooter.pressed.kick, true)
  step(shot, 1 / 30)
  assert.equal(shot.ball.owner, null)
  assert.ok(shot.ball.vz > 2)

  const tackle = playable(createMatch({
    mode: '1v1',
    minutes: 3,
    ranked: false,
    difficulty: 'hard',
    players: [
      { id: '1', name: 'Ada', rating: 1000, team: 'A' },
      { id: 'bot-1', name: 'Quackers', rating: 1000, team: 'B', bot: true },
    ],
  }))
  const human = tackle.players[0]
  const slider = tackle.players[1]
  human.x = 0
  human.z = 0
  slider.x = 0
  slider.z = -0.28
  slider.yaw = 0
  tackle.ball.owner = human.id
  tackle.elapsed = 2
  driveBots(tackle)
  assert.equal(slider.pressed.slide, true)
  let stolen = false
  for (let i = 0; i < 20; i++) {
    const events = step(tackle, 1 / 30)
    if (events.some((e) => e.type === 'steal')) stolen = true
  }
  assert.equal(stolen, true)
  assert.ok(slider.slideCd > 0)
  slider.pressed.slide = true
  const before = slider.slideT
  step(tackle, 1 / 30)
  assert.ok(slider.slideT <= before)

  const dodge = playable(createMatch({
    mode: '1v1',
    minutes: 3,
    ranked: false,
    difficulty: 'hard',
    players: [
      { id: 'bot-1', name: 'Quackers', rating: 1000, team: 'A', bot: true },
      { id: 'bot-2', name: 'Puddles', rating: 1000, team: 'B', bot: true },
    ],
  }))
  const spinner = dodge.players[0]
  const marker = dodge.players[1]
  spinner.x = 0
  spinner.z = 0
  marker.x = 0.25
  marker.z = 0.05
  dodge.ball.owner = spinner.id
  dodge.elapsed = 2
  driveBots(dodge)
  assert.equal(spinner.pressed.spin, true)
  assert.equal(marker.pressed.slide, true)
  let dodged = false
  for (let i = 0; i < 24; i++) {
    const events = step(dodge, 1 / 30)
    driveBots(dodge)
    if (events.some((e) => e.type === 'dodge')) dodged = true
  }
  assert.equal(dodged, true)
  assert.equal(dodge.ball.owner, spinner.id)
  assert.ok(marker.stun > 0)

  const chase = playable(createMatch({
    mode: '1v1',
    minutes: 3,
    ranked: false,
    difficulty: 'hard',
    players: [
      { id: 'bot-1', name: 'Quackers', rating: 1000, team: 'A', bot: true },
      { id: '1', name: 'Ada', rating: 1000, team: 'B' },
    ],
  }))
  const runner = chase.players[0]
  runner.x = -1.5
  runner.z = -1.5
  runner.stamina = 100
  chase.ball.owner = null
  chase.ball.x = 1.2
  chase.ball.z = 1.2
  driveBots(chase)
  assert.equal(runner.cmd.sprint, true)
  const hardPace = Math.hypot(runner.cmd.mx, runner.cmd.mz)
  for (let i = 0; i < 15; i++) {
    driveBots(chase)
    step(chase, 1 / 30)
  }
  assert.ok(runner.stamina < 90)

  const easy = playable(createMatch({
    mode: '1v1',
    minutes: 3,
    difficulty: 'easy',
    ranked: false,
    players: [
      { id: 'bot-1', name: 'Quackers', rating: 1000, team: 'A', bot: true },
      { id: '1', name: 'Ada', rating: 1000, team: 'B' },
    ],
  }))
  easy.players[0].x = -1.5
  easy.players[0].z = -1.5
  easy.ball.owner = null
  easy.ball.x = 1.2
  easy.ball.z = 1.2
  driveBots(easy)
  const easyPace = Math.hypot(easy.players[0].cmd.mx, easy.players[0].cmd.mz)
  assert.ok(easyPace < hardPace - 0.2)
  assert.equal(easy.players[0].cmd.sprint, false)

  const cage = playable(createMatch({
    mode: '3v3',
    minutes: 3,
    difficulty: 'hard',
    ranked: false,
    players: [
      { id: 'bot-1', name: 'Quackers', rating: 1000, team: 'A', bot: true, goalie: true },
      { id: '1', name: 'Ada', rating: 1200, team: 'A' },
      { id: '2', name: 'Bea', rating: 1100, team: 'A' },
      { id: 'bot-2', name: 'Puddles', rating: 1000, team: 'B', bot: true, goalie: true },
      { id: '3', name: 'Cam', rating: 1000, team: 'B' },
      { id: '4', name: 'Dee', rating: 1000, team: 'B' },
    ],
  }))
  const keeper = cage.players.find((p) => p.goalie && p.team === 'A')
  assert.equal(keeper.bot, true)
  cage.ball.owner = null
  cage.ball.x = keeper.x
  cage.ball.y = 0.1
  cage.ball.z = keeper.z + 0.2
  cage.ball.vz = -2
  driveBots(cage)
  assert.equal(keeper.pressed.dive, true)
  step(cage, 1 / 30)
  assert.equal(cage.ball.owner, keeper.id)
})

function cookieFrom(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || '']
  const match = /md=([^;]+)/.exec(list.join(';'))
  return match ? `md=${match[1]}` : ''
}

test('play vs bots fills both teams and does not change rating', async () => {
  const app = await start({ port: 0, dbPath: ':memory:' })
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Jackson', password: 'ducks' }),
    })
    const cookie = cookieFrom(res)
    const me = (await res.json()).user
    assert.equal(me.rating, 1000)
    const ws = await new Promise((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${app.port}`, { headers: { Cookie: cookie } })
      const inbox = []
      sock.on('message', (buf) => inbox.push(JSON.parse(String(buf))))
      sock.on('open', () => resolve({
        sock,
        inbox,
        send(msg) { sock.send(JSON.stringify(msg)) },
        async waitFor(pred) {
          const started = Date.now()
          while (Date.now() - started < 4000) {
            const found = inbox.find(pred)
            if (found) return found
            await new Promise((r) => setTimeout(r, 20))
          }
          throw new Error('timed out')
        },
      }))
      sock.on('error', reject)
    })
    await ws.waitFor((m) => m.t === 'ready')
    ws.send({ t: 'bots', mode: '2v2', minutes: 5, difficulty: 'nope' })
    const rejected = await ws.waitFor((m) => m.t === 'error')
    assert.match(rejected.message, /Easy, Medium, or Hard/)
    ws.send({ t: 'bots', mode: '2v2', minutes: 3, difficulty: 'hard' })
    const started = await ws.waitFor((m) => m.t === 'start')
    assert.equal(started.snap.ranked, false)
    assert.equal(started.snap.difficulty, 'hard')
    assert.equal(started.snap.players.length, 4)
    assert.equal(started.snap.players.filter((p) => p.bot).length, 3)
    assert.equal(started.snap.players.filter((p) => p.team === 'A').length, 2)
    assert.equal(started.snap.players.filter((p) => p.team === 'B').length, 2)
    assert.equal(started.you.team, 'A')
    assert.equal(started.snap.players.some((p) => p.goalie), false)
    ws.send({ t: 'hook-end' })
    const end = await ws.waitFor((m) => m.t === 'end')
    assert.equal(end.ranked, false)
    assert.equal(end.difficulty, 'hard')
    const after = await fetch(`http://127.0.0.1:${app.port}/api/me`, { headers: { cookie } })
    const body = await after.json()
    assert.equal(body.user.rating, 1000)
    assert.equal(body.user.matches, 0)

    ws.send({ t: 'bots', mode: '3v3', minutes: 5, difficulty: 'easy' })
    const third = await ws.waitFor((m) => m.t === 'start' && m.snap.mode === '3v3')
    assert.equal(third.snap.players.filter((p) => p.goalie && p.bot).length, 2)
    assert.equal(third.you.goalie, false)
    assert.equal(side({ players: third.snap.players }, 'A').filter((p) => p.goalie).length, 1)
    assert.equal(side({ players: third.snap.players }, 'B').filter((p) => p.goalie).length, 1)
    ws.send({ t: 'hook-end' })
    await ws.waitFor((m) => m.t === 'end' && m.mode === '3v3')

    ws.send({ t: 'bots', mode: '3v3', minutes: 5, difficulty: 'medium', goalie: true })
    const keeping = await ws.waitFor((m) => m.t === 'start' && m.you.goalie === true)
    assert.equal(keeping.snap.difficulty, 'medium')
    assert.equal(keeping.snap.players.filter((p) => p.goalie).length, 2)
    ws.sock.close()
  } finally {
    await app.close()
  }
})
