import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CELEBRATION_SECONDS,
  GOAL_H,
  GOAL_W,
  SPRINT,
  SPRINT_BALL,
  balanceTeams,
  createMatch,
  modeForSide,
  integrateMover,
  rankFor,
  ratingDelta,
  step,
} from '../public/shared/game.js'

function players(n, ratings) {
  return Array.from({ length: n }, (_, i) => ({
    id: String(i + 1),
    name: `P${i + 1}`,
    rating: ratings ? ratings[i] : 1000 + i,
    color: '#ff6a1a',
  }))
}

function duel() {
  const match = createMatch({
    mode: '1v1',
    minutes: 3,
    players: [
      { id: '1', name: 'Ada', rating: 1000, team: 'A', color: '#ff6a1a' },
      { id: '2', name: 'Bea', rating: 1000, team: 'B', color: '#2f8cff' },
    ],
  })
  match.phase = 'play'
  match.phaseT = 0
  return match
}

test('ball locks onto the player who has it and follows a turn', () => {
  const match = duel()
  const ada = match.players[0]
  match.ball.owner = ada.id
  ada.x = 0.4
  ada.z = -0.2
  ada.yaw = Math.PI / 2
  step(match, 1 / 30)
  assert.equal(match.ball.owner, ada.id)
  assert.ok(Math.abs(match.ball.x - (ada.x + Math.sin(ada.yaw) * 0.23)) < 0.05)
  assert.ok(match.ball.z > ada.z - 0.05)
})

test('a kick leaves the foot and can score in the small goal', () => {
  const match = duel()
  const ada = match.players[0]
  const bea = match.players[1]
  bea.x = 1.6
  bea.z = 0
  ada.x = 0
  ada.z = 2.1
  ada.yaw = 0
  match.ball.owner = ada.id
  ada.pressed.kick = true
  let scored = false
  for (let i = 0; i < 90; i++) {
    const events = step(match, 1 / 30)
    if (events.some((e) => e.type === 'goal' && e.team === 'A')) scored = true
  }
  assert.equal(scored, true)
  assert.equal(match.score.A, 1)
  assert.equal(ada.goals, 1)
  assert.equal(match.phase, 'celebrate')
})

test('a ball over the crossbar is not a goal', () => {
  const match = duel()
  const hl = match.length / 2
  match.ball.owner = null
  match.ball.x = 0
  match.ball.y = 0.5
  match.ball.z = hl - 0.08
  match.ball.vz = 4
  for (let i = 0; i < 20; i++) step(match, 1 / 30)
  assert.equal(match.score.A, 0)
  assert.equal(match.score.B, 0)
})

test('celebration lasts 5 seconds and the other team waits', () => {
  const match = duel()
  const ada = match.players[0]
  const bea = match.players[1]
  ada.x = 0
  ada.z = 2.1
  ada.yaw = 0
  bea.x = 1.5
  match.ball.owner = ada.id
  ada.pressed.kick = true
  let goal = false
  for (let i = 0; i < 40 && !goal; i++) {
    goal = step(match, 1 / 30).some((e) => e.type === 'goal')
  }
  assert.equal(goal, true)
  assert.equal(match.celebration, CELEBRATION_SECONDS)
  const z = bea.z
  bea.cmd.mz = -1
  let elapsed = 0
  while (match.phase === 'celebrate' && elapsed < 6) {
    step(match, 1 / 30)
    elapsed += 1 / 30
  }
  assert.ok(elapsed > 4.5 && elapsed < 5.4)
  assert.equal(match.phase, 'countdown')
  assert.ok(Math.abs(bea.z - z) < 0.08)
  const ax = ada.x
  const az = ada.z
  const bx = bea.x
  const bz = bea.z
  ada.cmd.mx = 1
  ada.cmd.mz = 1
  bea.cmd.mx = -1
  bea.cmd.mz = 1
  step(match, 1 / 30)
  assert.equal(match.phase, 'countdown')
  assert.equal(ada.x, ax)
  assert.equal(ada.z, az)
  assert.equal(bea.x, bx)
  assert.equal(bea.z, bz)
  const kicker = match.players.find((p) => p.id === match.ball.owner)
  assert.equal(kicker.team, 'B')
  assert.ok(Math.hypot(match.ball.x - kicker.x, match.ball.z - kicker.z) < 0.25)
})

test('slide tackle steals, a miss stuns, and a timed spin makes the tackle miss', () => {
  const miss = duel()
  const tackler = miss.players[1]
  tackler.x = 1.4
  tackler.z = -1
  tackler.yaw = 0
  tackler.pressed.slide = true
  let stunned = false
  for (let i = 0; i < 40; i++) {
    step(miss, 1 / 30)
    if (tackler.stun > 0) stunned = true
  }
  assert.equal(stunned, true)
  assert.ok(tackler.slideCd > 0 || stunned)

  const hit = duel()
  const ada = hit.players[0]
  const bea = hit.players[1]
  ada.x = 0
  ada.z = 0
  ada.yaw = 0
  hit.ball.owner = ada.id
  bea.x = 0
  bea.z = -0.2
  bea.yaw = 0
  bea.pressed.slide = true
  let stolen = false
  for (let i = 0; i < 20; i++) {
    const events = step(hit, 1 / 30)
    if (events.some((e) => e.type === 'steal')) stolen = true
  }
  assert.equal(stolen, true)
  assert.equal(hit.ball.owner, bea.id)

  const dodge = duel()
  const carrier = dodge.players[0]
  const slider = dodge.players[1]
  carrier.x = 0
  carrier.z = 0
  dodge.ball.owner = carrier.id
  carrier.pressed.spin = true
  slider.x = 0.05
  slider.z = -0.05
  slider.yaw = 0
  slider.pressed.slide = true
  let dodged = false
  for (let i = 0; i < 30; i++) {
    const events = step(dodge, 1 / 30)
    if (events.some((e) => e.type === 'dodge')) dodged = true
  }
  assert.equal(dodged, true)
  assert.equal(dodge.ball.owner, carrier.id)
  assert.ok(slider.stun > 0)
})

test('spin cannot be spammed during its cooldown', () => {
  const match = duel()
  const ada = match.players[0]
  match.ball.owner = ada.id
  ada.pressed.spin = true
  step(match, 1 / 30)
  assert.ok(ada.spinning > 0 || ada.spinCd > 0)
  while (ada.spinning > 0) step(match, 1 / 30)
  assert.ok(ada.spinCd > 1)
  ada.pressed.spin = true
  step(match, 1 / 30)
  assert.equal(ada.spinning, 0)
})

test('sprinting with the ball is slower and stamina drains then refills', () => {
  function pace(withBall) {
    const match = duel()
    const ada = match.players[0]
    if (!withBall) match.ball.owner = null
    else match.ball.owner = ada.id
    ada.cmd.mx = 0
    ada.cmd.mz = 1
    ada.cmd.sprint = true
    for (let i = 0; i < 20; i++) integrateMover(ada, 1 / 30, match)
    return ada
  }
  const free = pace(false)
  const carrying = pace(true)
  assert.ok(Math.hypot(free.vx, free.vz) > Math.hypot(carrying.vx, carrying.vz) + 0.2)
  assert.ok(Math.hypot(free.vx, free.vz) > SPRINT * 0.7)
  assert.ok(Math.hypot(carrying.vx, carrying.vz) < SPRINT_BALL + 0.15)
  assert.ok(free.stamina < 90)

  const match = duel()
  const ada = match.players[0]
  match.ball.owner = null
  ada.stamina = 40
  ada.cmd = { mx: 0, mz: 0, sprint: false }
  for (let i = 0; i < 30; i++) integrateMover(ada, 1 / 30, match)
  assert.ok(ada.stamina > 55)
})

test('goalies exist only in 3v3 and a pass can earn an assist', () => {
  const small = createMatch({ mode: '2v2', minutes: 5, players: players(4).map((p, i) => ({ ...p, team: i < 2 ? 'A' : 'B' })) })
  assert.equal(small.players.some((p) => p.goalie), false)
  const big = createMatch({ mode: '3v3', minutes: 3, players: players(6).map((p, i) => ({ ...p, team: i < 3 ? 'A' : 'B' })) })
  assert.equal(big.players.filter((p) => p.goalie && p.team === 'A').length, 1)
  assert.equal(big.players.filter((p) => p.goalie && p.team === 'B').length, 1)

  const match = createMatch({
    mode: '2v2',
    minutes: 3,
    players: players(4).map((p, i) => ({ ...p, team: i < 2 ? 'A' : 'B' })),
  })
  match.phase = 'play'
  const passer = match.players[0]
  const scorer = match.players[1]
  for (const p of match.players.slice(2)) { p.x = 2; p.z = 0 }
  passer.x = 0
  passer.z = 1
  passer.yaw = 0
  scorer.x = 0
  scorer.z = 2.3
  scorer.yaw = 0
  match.ball.owner = passer.id
  passer.pressed.pass = true
  step(match, 1 / 30)
  match.ball.owner = scorer.id
  match.ball.lastTouch = { id: scorer.id, team: 'A', t: match.elapsed }
  scorer.pressed.kick = true
  let assist = false
  for (let i = 0; i < 50; i++) {
    const events = step(match, 1 / 30)
    if (events.some((e) => e.type === 'goal' && e.assist === scorer.name)) assist = false
    if (events.some((e) => e.type === 'goal' && e.assist === passer.name)) assist = true
  }
  assert.equal(assist, true)
  assert.equal(passer.assists, 1)
  assert.equal(scorer.goals, 1)
})

test('a 3v3 can start with no goalies, and a goalie kick follows the power bar', () => {
  const open = createMatch({
    mode: '3v3',
    minutes: 3,
    goalies: false,
    players: players(6).map((p, i) => ({ ...p, team: i < 3 ? 'A' : 'B' })),
  })
  assert.equal(open.goalies, false)
  assert.equal(open.players.some((p) => p.goalie), false)

  function shot(power) {
    const match = createMatch({
      mode: '3v3',
      minutes: 3,
      goalies: true,
      players: players(6).map((p, i) => ({ ...p, team: i < 3 ? 'A' : 'B' })),
    })
    match.phase = 'play'
    const gk = match.players.find((p) => p.goalie && p.team === 'A')
    for (const p of match.players) {
      if (p !== gk) { p.x = 5; p.z = 0 }
    }
    gk.x = 0
    gk.z = 0
    gk.yaw = 0
    gk.vx = 0
    gk.vz = 0
    match.ball.owner = gk.id
    gk.cmd.power = power
    gk.pressed.kick = true
    step(match, 1 / 30)
    return Math.hypot(match.ball.vx, match.ball.vz)
  }
  assert.ok(shot(1) > shot(0.2) + 1)
})

test('a shot from the side still travels toward the crosshair point', () => {
  const match = duel()
  match.phase = 'play'
  const ada = match.players[0]
  ada.x = 0
  ada.z = 0
  ada.yaw = 0
  ada.vx = 0
  ada.vz = 0
  ada.cmd.aimX = 0
  ada.cmd.aimZ = 3
  match.ball.owner = ada.id
  match.ball.x = 0.28
  match.ball.z = 0.2
  match.ball.vx = 0
  match.ball.vz = 0
  ada.pressed.kick = true
  step(match, 1 / 60)
  const dx = ada.cmd.aimX - 0.28
  const dz = ada.cmd.aimZ - 0.2
  const cross = Math.abs(match.ball.vx * dz - match.ball.vz * dx)
  const scale = Math.hypot(match.ball.vx, match.ball.vz) * Math.hypot(dx, dz)
  assert.ok(scale > 1)
  assert.ok(cross / scale < 0.08, `cross ${cross / scale}`)
})

test('a shot follows the aim direction instead of auto-aiming at the goal', () => {
  const match = duel()
  match.phase = 'play'
  const ada = match.players[0]
  ada.x = 0
  ada.z = 0
  ada.yaw = 0
  ada.vx = 1.2
  ada.vz = 0
  ada.cmd.aim = Math.PI / 2
  match.ball.owner = ada.id
  match.ball.x = ada.x
  match.ball.z = ada.z + 0.18
  ada.pressed.kick = true
  step(match, 1 / 60)
  assert.ok(match.ball.vx > 2, `vx ${match.ball.vx}`)
  assert.ok(Math.abs(match.ball.vz) < 0.35, `vz ${match.ball.vz}`)
  const aimX = Math.sin(ada.cmd.aim)
  const aimZ = Math.cos(ada.cmd.aim)
  for (let i = 0; i < 8; i++) step(match, 1 / 60)
  const lateral = Math.abs(match.ball.x * aimZ - match.ball.z * aimX)
  assert.ok(lateral < 0.08, `lateral ${lateral}`)
})

test('rating rewards goals and assists, and teams get balanced by rank', () => {
  const plain = ratingDelta({ teamAvg: 1000, oppAvg: 1000, won: true, draw: false, goals: 0, assists: 0 })
  const star = ratingDelta({ teamAvg: 1000, oppAvg: 1000, won: true, draw: false, goals: 2, assists: 1 })
  const quietLoss = ratingDelta({ teamAvg: 1000, oppAvg: 1000, won: false, draw: false, goals: 0, assists: 0 })
  const braveLoss = ratingDelta({ teamAvg: 1000, oppAvg: 1000, won: false, draw: false, goals: 2, assists: 1 })
  assert.ok(star > plain)
  assert.ok(braveLoss > quietLoss)
  assert.ok(plain > 0)
  assert.ok(quietLoss < 0)
  const teams = balanceTeams([
    { id: 'a', rating: 1500 },
    { id: 'b', rating: 1400 },
    { id: 'c', rating: 1100 },
    { id: 'd', rating: 1000 },
  ])
  const sum = (list) => list.reduce((s, p) => s + p.rating, 0)
  assert.ok(Math.abs(sum(teams.A) - sum(teams.B)) <= 200)
  assert.equal(rankFor(1000), 'Hatchling')
  assert.equal(rankFor(2100), 'Legend')
  const ten = balanceTeams(Array.from({ length: 10 }, (_, i) => ({ id: String(i), rating: 2000 - i })))
  assert.equal(ten.A.length, 5)
  assert.equal(ten.B.length, 5)
  assert.equal(modeForSide(2), '2v2')
  assert.equal(modeForSide(5), '5v5')
  const five = createMatch({
    mode: '5v5',
    minutes: 3,
    players: Array.from({ length: 10 }, (_, i) => ({
      id: String(i + 1),
      name: `D${i}`,
      rating: 1000,
      color: '#ff6a1a',
      team: i < 5 ? 'A' : 'B',
    })),
  })
  const sideA = five.players.filter((p) => p.team === 'A')
  assert.equal(sideA.filter((p) => p.goalie).length, 1)
  assert.equal(sideA.filter((p) => !p.goalie).length, 4)
})

test('goals are 1.5x and a walk-in still scores', () => {
  assert.equal(GOAL_W, 0.63)
  assert.equal(GOAL_H, 0.39)
  const match = duel()
  match.phase = 'play'
  const ada = match.players[0]
  const hl = match.length / 2
  ada.x = 0
  ada.z = hl - 0.06
  ada.yaw = 0
  match.ball.owner = ada.id
  match.ball.x = 0
  match.ball.z = hl - 0.2
  match.ball.y = 0.078
  let scored = false
  for (let i = 0; i < 8 && !scored; i++) scored = step(match, 1 / 30).some((e) => e.type === 'goal')
  assert.equal(scored, true)
})

test('spin works without the ball', () => {
  const match = duel()
  match.phase = 'play'
  const ada = match.players[0]
  match.ball.owner = null
  ada.pressed.spin = true
  const before = ada.yaw
  step(match, 1 / 30)
  assert.ok(ada.spinning > 0.4)
  step(match, 1 / 30)
  assert.notEqual(ada.yaw, before)
})
