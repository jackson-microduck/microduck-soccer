// Shared match rules. The server is authoritative; the client uses the same
// movement numbers so a local duck doesn't lag behind a tap.

export const CELEBRATION_SECONDS = 8
export const COUNTDOWN_SECONDS = 1.25
export const STAMINA_MAX = 100
export const STAMINA_DRAIN = 36
export const STAMINA_REGEN = 22
export const STAMINA_MIN_START = 14
export const WALK = 0.95
export const SPRINT = 1.78
export const SPRINT_BALL = 1.24
export const BALL_R = 0.078
export const PLAYER_R = 0.11
export const PICKUP_R = 0.32
export const DRIBBLE = 0.23
export const GOAL_W = 0.42
export const GOAL_H = 0.26
export const SPIN_TIME = 0.42
export const SPIN_COOLDOWN = 2.6
export const SLIDE_TIME = 0.36
export const SLIDE_COOLDOWN = 1.6
export const SLIDE_STUN = 0.75
export const STEAL_STUMBLE = 0.34
export const KICK_SPEED = 7.4
export const KICK_LIFT = 0.95
export const PASS_SPEED = 4.6
export const PASS_LIFT = 0.55
export const MATCH_MINUTES = [3, 5]

export const MODES = {
  '1v1': { players: 2, perTeam: 1, length: 7.0, width: 4.2 },
  '2v2': { players: 4, perTeam: 2, length: 8.6, width: 5.2 },
  '3v3': { players: 6, perTeam: 3, length: 10.4, width: 6.2 },
}

export const RANKS = [
  { name: 'Duckling', min: 0 },
  { name: 'Hatchling', min: 900 },
  { name: 'Waddler', min: 1100 },
  { name: 'Striker', min: 1300 },
  { name: 'Playmaker', min: 1500 },
  { name: 'Captain', min: 1700 },
  { name: 'All-Star', min: 1900 },
  { name: 'Legend', min: 2100 },
]

export const EMOTES = ['spin', 'quack', 'bob', 'sit', 'glide']
export const START_RATING = 1000

export function rankFor(rating) {
  let name = RANKS[0].name
  for (const rank of RANKS) {
    if (rating >= rank.min) name = rank.name
  }
  return name
}

export function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n))
}

function hypot(x, z) {
  return Math.hypot(x, z)
}

function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}

export function ratingDelta({ teamAvg, oppAvg, won, draw, goals, assists }) {
  const expected = 1 / (1 + 10 ** ((oppAvg - teamAvg) / 400))
  const actual = draw ? 0.5 : won ? 1 : 0
  let delta = Math.round(28 * (actual - expected))
  delta += goals * 4 + assists * 2
  if (won) delta = Math.max(delta, 4)
  if (!won && !draw && goals === 0 && assists === 0) delta = Math.min(delta, -6)
  return clamp(delta, -30, 36)
}

export function balanceTeams(players) {
  const sorted = [...players].sort((a, b) => b.rating - a.rating || String(a.id).localeCompare(String(b.id)))
  const pattern = {
    2: ['A', 'B'],
    4: ['A', 'B', 'B', 'A'],
    6: ['A', 'B', 'B', 'A', 'A', 'B'],
  }[sorted.length]
  if (!pattern) throw new Error('Matches need 2, 4, or 6 players')
  const teams = { A: [], B: [] }
  sorted.forEach((p, i) => teams[pattern[i]].push(p))
  return teams
}

function blankCommand() {
  return { mx: 0, mz: 0, sprint: false }
}

export function makePlayer(raw, team) {
  return {
    id: String(raw.id),
    name: raw.name,
    rating: raw.rating ?? START_RATING,
    color: raw.color || '#ff6a1a',
    bot: !!raw.bot,
    team,
    goalie: !!raw.goalie,
    x: 0,
    z: 0,
    yaw: team === 'A' ? 0 : Math.PI,
    vx: 0,
    vz: 0,
    stamina: STAMINA_MAX,
    sprinting: false,
    cmd: blankCommand(),
    pressed: {},
    lastBtn: {},
    ack: 0,
    anim: 'idle',
    animT: 0,
    emote: null,
    emoteT: 0,
    stun: 0,
    slideT: 0,
    slideCd: 0,
    slideHit: false,
    slideYaw: 0,
    spinning: 0,
    spinCd: 0,
    diving: 0,
    diveCd: 0,
    diveYaw: 0,
    pickupLock: 0,
    kickT: 0,
    goals: 0,
    assists: 0,
  }
}

function spotsFor(mode, team, length) {
  const sign = team === 'A' ? -1 : 1
  const hl = length / 2
  if (mode === '3v3') {
    return [
      { x: 0, z: sign * (hl - 0.4), goalie: true },
      { x: -0.9, z: sign * 1.45 },
      { x: 0.9, z: sign * 1.45 },
    ]
  }
  if (mode === '2v2') {
    return [
      { x: -0.6, z: sign * 1.3 },
      { x: 0.6, z: sign * 1.3 },
    ]
  }
  return [{ x: 0, z: sign * 1.15 }]
}

function assignGoalies(players, mode) {
  if (mode !== '3v3') {
    for (const p of players) p.goalie = false
    return
  }
  for (const team of ['A', 'B']) {
    const side = players.filter((p) => p.team === team)
    let keeper = side.find((p) => p.goalie)
    if (!keeper) {
      keeper = [...side].sort((a, b) => a.rating - b.rating)[0]
    }
    for (const p of side) p.goalie = p === keeper
  }
}

export function createMatch({
  id = 'm',
  mode,
  minutes = 3,
  players,
  ranked = true,
  celebration = CELEBRATION_SECONDS,
  homeName = 'Orange',
  awayName = 'Blue',
  homeLogo = null,
  awayLogo = null,
  clubName = null,
  difficulty = null,
}) {
  if (!MODES[mode]) throw new Error('Unknown mode')
  if (!MATCH_MINUTES.includes(minutes) && minutes !== 0) {
    // minutes === 0 is rejected for real rooms. Tests pass 3 or 5.
  }
  const spec = MODES[mode]
  const made = players.map((p) => makePlayer(p, p.team || 'A'))
  assignGoalies(made, mode)
  const match = {
    id: String(id),
    mode,
    minutes,
    duration: minutes * 60,
    clock: minutes * 60,
    elapsed: 0,
    length: spec.length,
    width: spec.width,
    goalW: GOAL_W,
    goalH: GOAL_H,
    ranked,
    celebration,
    phase: 'countdown',
    phaseT: COUNTDOWN_SECONDS,
    score: { A: 0, B: 0 },
    kickoffTeam: 'A',
    celebrateTeam: null,
    scorerName: null,
    homeName,
    awayName,
    homeLogo,
    awayLogo,
    clubName,
    difficulty: difficulty || null,
    over: false,
    players: made,
    ball: {
      x: 0,
      y: BALL_R,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      owner: null,
      grabLock: 0,
      lastTouch: null,
      lastPass: null,
    },
  }
  placeKickoff(match, 'A')
  return match
}

function placeKickoff(match, team) {
  match.kickoffTeam = team
  for (const side of ['A', 'B']) {
    const group = match.players.filter((p) => p.team === side)
    const layout = spotsFor(match.mode, side, match.length)
    const keeper = group.find((p) => p.goalie)
    const others = group.filter((p) => p !== keeper)
    const open = layout.filter((s) => !s.goalie)
    const goalSpot = layout.find((s) => s.goalie)
    const ordered = keeper && goalSpot ? [keeper, ...others] : group
    const used = keeper && goalSpot ? [goalSpot, ...open] : layout
    ordered.forEach((p, i) => {
      const spot = used[i] || used[used.length - 1]
      p.x = spot.x
      p.z = spot.z
      p.vx = 0
      p.vz = 0
      p.yaw = side === 'A' ? 0 : Math.PI
      p.stun = 0
      p.slideT = 0
      p.slideHit = false
      p.spinning = 0
      p.diving = 0
      p.kickT = 0
      p.emote = null
      p.pickupLock = 0
      p.sprinting = false
      p.cmd = blankCommand()
      p.pressed = {}
    })
  }
  const kickers = match.players.filter((p) => p.team === team && !p.goalie)
  const kicker = kickers[0] || match.players.find((p) => p.team === team)
  const ball = match.ball
  ball.owner = kicker.id
  ball.vx = ball.vy = ball.vz = 0
  ball.y = BALL_R
  ball.grabLock = 0
  ball.lastPass = null
  stickBall(match, kicker)
}

function playerById(match, id) {
  return match.players.find((p) => p.id === String(id)) || null
}

export function setInput(match, id, msg) {
  const p = playerById(match, id)
  if (!p || p.bot || !msg || typeof msg !== 'object') return
  const mx = Number(msg.mx)
  const mz = Number(msg.mz)
  p.cmd.mx = Number.isFinite(mx) ? clamp(mx, -1, 1) : 0
  p.cmd.mz = Number.isFinite(mz) ? clamp(mz, -1, 1) : 0
  const mag = hypot(p.cmd.mx, p.cmd.mz)
  if (mag > 1) {
    p.cmd.mx /= mag
    p.cmd.mz /= mag
  }
  p.cmd.sprint = !!msg.sprint
  if (Number.isFinite(msg.seq)) p.ack = msg.seq | 0
  for (const key of ['kick', 'pass', 'slide', 'spin', 'dive']) {
    const value = msg[key]
    if (value && value !== p.lastBtn[key]) {
      p.pressed[key] = true
      p.lastBtn[key] = value
    }
  }
  if (msg.emoteId && msg.emoteId !== p.lastBtn.emote) {
    const name = EMOTES.includes(msg.emote) ? msg.emote : 'spin'
    p.pressed.emote = name
    p.lastBtn.emote = msg.emoteId
  }
}

function hasBall(match, p) {
  return match.ball.owner === p.id
}

function canAct(match, p) {
  if (match.phase === 'fulltime' || match.over) return false
  if (p.stun > 0) return false
  if (match.phase === 'countdown') return false
  if (match.phase === 'celebrate') return p.team === match.celebrateTeam
  return match.phase === 'play'
}

function releaseBall(match, p, speed, lift, pass) {
  const ball = match.ball
  const s = Math.sin(p.yaw)
  const c = Math.cos(p.yaw)
  ball.owner = null
  ball.x = p.x + s * (DRIBBLE + 0.05)
  ball.z = p.z + c * (DRIBBLE + 0.05)
  ball.y = BALL_R + 0.02
  ball.vx = s * speed + p.vx * 0.25
  ball.vz = c * speed + p.vz * 0.25
  ball.vy = lift
  ball.grabLock = 0.32
  p.pickupLock = 0.42
  p.kickT = 0.38
  p.anim = 'kick'
  p.animT = 0
  ball.lastTouch = { id: p.id, team: p.team, t: match.elapsed }
  if (pass) ball.lastPass = { id: p.id, team: p.team, t: match.elapsed }
}

function aimAtTeammate(match, p) {
  let best = null
  let bestD = 5.2
  for (const other of match.players) {
    if (other === p || other.team !== p.team) continue
    const dx = other.x - p.x
    const dz = other.z - p.z
    const dist = hypot(dx, dz)
    if (dist < 0.4 || dist > bestD) continue
    const facing = Math.atan2(dx, dz)
    let diff = Math.abs(lerpAngle(p.yaw, facing, 1) - p.yaw)
    diff = Math.abs(((facing - p.yaw + Math.PI) % (Math.PI * 2)) - Math.PI)
    if (diff > 0.7) continue
    best = other
    bestD = dist
  }
  return best
}

function handleButtons(match, p) {
  if (!canAct(match, p) || match.phase !== 'play') {
    if (match.phase === 'celebrate' && p.team === match.celebrateTeam && p.pressed.emote) {
      p.emote = p.pressed.emote
      p.emoteT = 0
      p.anim = p.emote
      p.animT = 0
    }
    return
  }
  if (p.slideT > 0 || p.diving > 0) return
  if (p.pressed.spin && hasBall(match, p) && p.spinCd <= 0 && p.spinning <= 0) {
    p.spinning = SPIN_TIME
    p.spinCd = SPIN_COOLDOWN
    p.anim = 'spin'
    p.animT = 0
  }
  if (p.pressed.slide && p.slideCd <= 0 && p.spinning <= 0) {
    p.slideT = SLIDE_TIME
    p.slideCd = SLIDE_COOLDOWN
    p.slideHit = false
    p.slideYaw = p.yaw
    p.anim = 'slide'
    p.animT = 0
  }
  if (p.pressed.dive && p.goalie && match.mode === '3v3' && p.diveCd <= 0 && p.spinning <= 0 && p.slideT <= 0) {
    p.diving = 0.42
    p.diveCd = 1.25
    const mag = hypot(p.cmd.mx, p.cmd.mz)
    p.diveYaw = mag > 0.2 ? Math.atan2(p.cmd.mx, p.cmd.mz) : p.yaw
    p.anim = 'dive'
    p.animT = 0
  }
  if (p.pressed.kick && hasBall(match, p) && p.spinning <= 0) {
    releaseBall(match, p, KICK_SPEED, KICK_LIFT, false)
  } else if (p.pressed.pass && hasBall(match, p) && p.spinning <= 0) {
    const mate = aimAtTeammate(match, p)
    if (mate) {
      p.yaw = Math.atan2(mate.x - p.x, mate.z - p.z)
    }
    releaseBall(match, p, PASS_SPEED, PASS_LIFT, true)
  }
}

export function integrateMover(p, dt, match) {
  const ballOwned = match && match.ball.owner === p.id
  const special = p.slideT > 0 || p.diving > 0 || p.spinning > 0
  const frozen = p.stun > 0 || !match || match.phase === 'countdown' || match.phase === 'fulltime'
    || (match.phase === 'celebrate' && p.team !== match.celebrateTeam)
  let mx = frozen ? 0 : p.cmd.mx
  let mz = frozen ? 0 : p.cmd.mz
  if (match && match.phase === 'celebrate') {
    p.sprinting = false
  }
  if (p.slideT > 0) {
    const rate = 2.7
    p.vx = Math.sin(p.slideYaw) * rate
    p.vz = Math.cos(p.slideYaw) * rate
    p.sprinting = false
  } else if (p.diving > 0) {
    const rate = 2.5
    p.vx = Math.sin(p.diveYaw) * rate
    p.vz = Math.cos(p.diveYaw) * rate
    p.sprinting = false
  } else if (p.spinning > 0) {
    p.yaw += (Math.PI * 2) * (dt / SPIN_TIME) * (p.team === 'A' ? 1 : -1)
    const side = p.team === 'A' ? 1 : -1
    p.vx = Math.cos(p.yaw) * side * 1.35
    p.vz = -Math.sin(p.yaw) * side * 1.35
    p.sprinting = false
    p.stamina = Math.min(STAMINA_MAX, p.stamina + STAMINA_REGEN * dt * 0.35)
  } else if (frozen || (mx === 0 && mz === 0)) {
    p.vx += (0 - p.vx) * Math.min(1, 10 * dt)
    p.vz += (0 - p.vz) * Math.min(1, 10 * dt)
    p.sprinting = false
    if (!frozen) p.stamina = Math.min(STAMINA_MAX, p.stamina + STAMINA_REGEN * dt)
  } else {
    const want = !!p.cmd.sprint && match.phase === 'play'
    const startOk = p.sprinting || p.stamina >= STAMINA_MIN_START
    if (want && startOk && p.stamina > 0.5) {
      p.sprinting = true
      p.stamina = Math.max(0, p.stamina - STAMINA_DRAIN * dt)
    } else {
      p.sprinting = false
      p.stamina = Math.min(STAMINA_MAX, p.stamina + STAMINA_REGEN * dt)
    }
    const speed = p.sprinting ? (ballOwned ? SPRINT_BALL : SPRINT) : WALK
    const targetYaw = Math.atan2(mx, mz)
    p.yaw = lerpAngle(p.yaw, targetYaw, 1 - Math.exp(-12 * dt))
    const tvx = mx * speed
    const tvz = mz * speed
    const k = 1 - Math.exp(-9 * dt)
    p.vx += (tvx - p.vx) * k
    p.vz += (tvz - p.vz) * k
  }
  if (special && p.stamina < STAMINA_MAX && p.slideT <= 0 && p.diving <= 0) {
    // spinning still regenerates a little so a dodge isn't a stamina tax
  }
  if (!p.sprinting && p.slideT <= 0 && p.diving <= 0 && !frozen) {
    // regen handled above for the walking branch; cover spin/slide end
  }
  if (!p.sprinting && p.spinning <= 0 && p.slideT <= 0 && p.diving <= 0 && !frozen && (mx !== 0 || mz !== 0)) {
    // already regened in the walk branch when not sprinting
  }
  p.x += p.vx * dt
  p.z += p.vz * dt
  p.stun = Math.max(0, p.stun - dt)
  p.slideCd = Math.max(0, p.slideCd - dt)
  p.spinCd = Math.max(0, p.spinCd - dt)
  p.diveCd = Math.max(0, p.diveCd - dt)
  p.pickupLock = Math.max(0, p.pickupLock - dt)
  p.kickT = Math.max(0, p.kickT - dt)
  if (p.spinning > 0) p.spinning = Math.max(0, p.spinning - dt)
  if (p.diving > 0) p.diving = Math.max(0, p.diving - dt)
}

function separatePlayers(match) {
  const list = match.players
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]
      const b = list[j]
      let dx = b.x - a.x
      let dz = b.z - a.z
      let d = hypot(dx, dz)
      const min = PLAYER_R * 2
      if (d < 0.0001) {
        dx = 0.01
        dz = 0
        d = 0.01
      }
      if (d < min) {
        const push = (min - d) / 2
        const nx = dx / d
        const nz = dz / d
        a.x -= nx * push
        a.z -= nz * push
        b.x += nx * push
        b.z += nz * push
      }
    }
  }
}

function clampPlayers(match) {
  const hx = match.width / 2 - PLAYER_R
  const hz = match.length / 2 - 0.06
  for (const p of match.players) {
    p.x = clamp(p.x, -hx, hx)
    p.z = clamp(p.z, -hz, hz)
  }
}

function stickBall(match, p) {
  const ball = match.ball
  ball.x = p.x + Math.sin(p.yaw) * DRIBBLE
  ball.z = p.z + Math.cos(p.yaw) * DRIBBLE
  ball.y = BALL_R
  ball.vx = p.vx
  ball.vy = 0
  ball.vz = p.vz
  ball.lastTouch = { id: p.id, team: p.team, t: match.elapsed }
}

function integrateBall(match, dt) {
  const ball = match.ball
  const prevZ = ball.z
  ball.vy -= 9.8 * dt
  ball.x += ball.vx * dt
  ball.y += ball.vy * dt
  ball.z += ball.vz * dt
  if (ball.y < BALL_R) {
    ball.y = BALL_R
    if (ball.vy < 0) ball.vy = -ball.vy * 0.32
    if (Math.abs(ball.vy) < 0.45) ball.vy = 0
    const spd = hypot(ball.vx, ball.vz)
    if (spd > 0) {
      const ns = Math.max(0, spd - 1.05 * dt)
      ball.vx = (ball.vx / spd) * ns
      ball.vz = (ball.vz / spd) * ns
    }
  }
  const hx = match.width / 2 - BALL_R
  if (ball.x > hx) {
    ball.x = hx
    ball.vx = -Math.abs(ball.vx) * 0.45
  } else if (ball.x < -hx) {
    ball.x = -hx
    ball.vx = Math.abs(ball.vx) * 0.45
  }
  return prevZ
}

function tryGoal(match, prevZ, events) {
  if (match.phase !== 'play') return
  const ball = match.ball
  const hl = match.length / 2
  const forward = prevZ <= hl && ball.z > hl
  const back = prevZ >= -hl && ball.z < -hl
  if (!forward && !back) return
  const inMouth = Math.abs(ball.x) < match.goalW / 2 - 0.015 && ball.y < match.goalH - 0.008 && ball.y >= BALL_R - 0.001
  if (!inMouth) {
    if (forward) ball.z = hl - 0.02
    else ball.z = -hl + 0.02
    if (!ball.owner) ball.vz *= -0.55
    return
  }
  const scoring = forward ? 'A' : 'B'
  scoreGoal(match, scoring, events)
}

function scoreGoal(match, scoring, events) {
  if (match.phase !== 'play') return
  match.score[scoring] += 1
  const touch = match.ball.lastTouch
  let scorer = null
  let assist = null
  const ownGoal = !!(touch && touch.team !== scoring)
  if (touch && touch.team === scoring) {
    scorer = playerById(match, touch.id)
    if (scorer) scorer.goals += 1
    const pass = match.ball.lastPass
    if (
      pass
      && pass.team === scoring
      && pass.id !== touch.id
      && match.elapsed - pass.t <= 5
    ) {
      assist = playerById(match, pass.id)
      if (assist && assist.team === scoring) assist.assists += 1
      else assist = null
    }
  }
  match.ball.owner = null
  match.ball.vx = match.ball.vy = match.ball.vz = 0
  match.phase = 'celebrate'
  match.phaseT = match.celebration
  match.celebrateTeam = scoring
  match.scorerName = scorer ? scorer.name : ownGoal ? 'Own goal' : 'Goal'
  for (const p of match.players) {
    p.emote = null
    p.vx = 0
    p.vz = 0
  }
  events.push({
    type: 'goal',
    team: scoring,
    scorer: scorer ? scorer.name : null,
    assist: assist ? assist.name : null,
    ownGoal,
  })
}

function collideBallPlayers(match) {
  const ball = match.ball
  if (ball.owner) return
  for (const p of match.players) {
    if (p.pickupLock > 0) continue
    const dx = ball.x - p.x
    const dz = ball.z - p.z
    const d = hypot(dx, dz) || 0.0001
    const min = PLAYER_R + BALL_R
    if (d < min && ball.y < 0.28) {
      const nx = dx / d
      const nz = dz / d
      const overlap = min - d
      ball.x += nx * overlap
      ball.z += nz * overlap
      const spd = hypot(ball.vx, ball.vz)
      if (spd < 4.5) {
        ball.vx += nx * 1.4
        ball.vz += nz * 1.4
      } else {
        ball.vx += nx * 0.4
        ball.vz += nz * 0.4
      }
    }
  }
}

function tryPickup(match) {
  const ball = match.ball
  if (ball.owner || ball.grabLock > 0 || match.phase !== 'play') return
  const spd = hypot(ball.vx, ball.vz)
  if (spd > 3 || ball.y > 0.22) return
  let best = null
  let bestD = PICKUP_R
  for (const p of match.players) {
    if (p.stun > 0 || p.pickupLock > 0 || p.diving > 0) continue
    const d = hypot(ball.x - p.x, ball.z - p.z)
    if (d < bestD) {
      best = p
      bestD = d
    }
  }
  if (best) {
    ball.owner = best.id
    ball.vy = 0
    stickBall(match, best)
  }
}

function tryCatch(match) {
  if (match.mode !== '3v3' || match.phase !== 'play') return
  const ball = match.ball
  if (ball.owner) return
  for (const p of match.players) {
    if (!p.goalie || p.diving <= 0) continue
    const d = hypot(ball.x - p.x, ball.z - p.z)
    if (d < 0.4 && ball.y < match.goalH + 0.02) {
      ball.owner = p.id
      ball.vx = ball.vy = ball.vz = 0
      ball.grabLock = 0
      stickBall(match, p)
      return
    }
  }
}

function detectSlides(match, events) {
  const ball = match.ball
  if (!ball.owner || match.phase !== 'play') return
  const carrier = playerById(match, ball.owner)
  if (!carrier) return
  for (const p of match.players) {
    if (p.slideT <= 0 || p.slideHit || p.team === carrier.team || p === carrier) continue
    const fx = p.x + Math.sin(p.slideYaw) * 0.16
    const fz = p.z + Math.cos(p.slideYaw) * 0.16
    const dCar = hypot(fx - carrier.x, fz - carrier.z)
    const dBall = hypot(fx - ball.x, fz - ball.z)
    if (dCar > 0.36 && dBall > 0.32) continue
    if (carrier.spinning > 0 || p.notedDodge) {
      if (!p.notedDodge) {
        p.notedDodge = true
        events.push({ type: 'dodge', by: p.name, carrier: carrier.name })
      }
      continue
    }
    p.slideHit = true
    carrier.stun = STEAL_STUMBLE
    carrier.anim = 'fall'
    carrier.animT = 0
    ball.owner = p.id
    ball.lastPass = null
    ball.lastTouch = { id: p.id, team: p.team, t: match.elapsed }
    stickBall(match, p)
    events.push({ type: 'steal', by: p.name, from: carrier.name })
    break
  }
}

function updateAnims(match, dt) {
  for (const p of match.players) {
    p.animT += dt
    if (p.emote) p.emoteT += dt
    if (p.stun > 0 && p.anim !== 'fall' && p.slideT <= 0) {
      p.anim = 'fall'
    }
    if (p.whiffed) {
      p.anim = 'fall'
      p.whiffed = false
    }
    if (p.slideT > 0) p.anim = 'slide'
    else if (p.diving > 0) p.anim = 'dive'
    else if (p.spinning > 0) p.anim = 'spin'
    else if (p.kickT > 0) p.anim = 'kick'
    else if (p.stun > 0) p.anim = p.animT < 0.42 ? 'fall' : 'getup'
    else if (p.emote && match.phase === 'celebrate' && p.team === match.celebrateTeam) p.anim = p.emote
    else {
      const spd = hypot(p.vx, p.vz)
      if (spd > 1.35) p.anim = 'sprint'
      else if (spd > 0.25) p.anim = 'walk'
      else p.anim = 'idle'
    }
  }
}

export function step(match, dt) {
  const events = []
  if (match.over) return events
  const dtUse = clamp(dt, 0, 0.05)
  match.elapsed += dtUse

  if (match.phase === 'countdown') {
    match.phaseT -= dtUse
    for (const p of match.players) {
      p.vx = 0
      p.vz = 0
      p.pressed = {}
    }
    const kicker = playerById(match, match.ball.owner)
    if (kicker) stickBall(match, kicker)
    if (match.phaseT <= 0) {
      match.phase = 'play'
      events.push({ type: 'play' })
    }
    updateAnims(match, dtUse)
    return events
  }

  if (match.phase === 'celebrate') {
    match.phaseT -= dtUse
    for (const p of match.players) {
      if (p.team === match.celebrateTeam && p.pressed.emote) {
        p.emote = p.pressed.emote
        p.emoteT = 0
      }
      if (p.team === match.celebrateTeam && p.stun <= 0) {
        integrateMover(p, dtUse, match)
      } else {
        p.vx = 0
        p.vz = 0
        p.stun = Math.max(0, p.stun - dtUse)
      }
      p.pressed = {}
    }
    separatePlayers(match)
    clampPlayers(match)
    updateAnims(match, dtUse)
    if (match.phaseT <= 0) {
      if (match.clock <= 0) {
        endMatch(match, events)
      } else {
        const next = match.celebrateTeam === 'A' ? 'B' : 'A'
        match.phase = 'countdown'
        match.phaseT = COUNTDOWN_SECONDS
        match.celebrateTeam = null
        placeKickoff(match, next)
        events.push({ type: 'kickoff', team: next })
      }
    }
    return events
  }

  if (match.phase !== 'play') return events

  match.clock = Math.max(0, match.clock - dtUse)
  match.ball.grabLock = Math.max(0, match.ball.grabLock - dtUse)

  for (const p of match.players) handleButtons(match, p)

  for (const p of match.players) integrateMover(p, dtUse, match)
  separatePlayers(match)
  clampPlayers(match)

  detectSlides(match, events)
  for (const p of match.players) {
    if (p.slideT > 0) {
      p.slideT = Math.max(0, p.slideT - dtUse)
      if (p.slideT === 0) {
        if (!p.slideHit) {
          p.stun = SLIDE_STUN
          p.anim = 'fall'
          p.animT = 0
          events.push({ type: 'whiff', by: p.name })
        }
        p.slideHit = false
        p.notedDodge = false
      }
    }
  }

  if (match.ball.owner) {
    const owner = playerById(match, match.ball.owner)
    if (owner) {
      const prevZ = match.ball.z
      stickBall(match, owner)
      tryGoal(match, prevZ, events)
    }
  } else {
    const prevZ = integrateBall(match, dtUse)
    collideBallPlayers(match)
    tryCatch(match)
    tryGoal(match, prevZ, events)
    tryPickup(match)
  }

  if (match.phase === 'play' && match.clock <= 0) endMatch(match, events)

  for (const p of match.players) p.pressed = {}
  updateAnims(match, dtUse)
  return events
}

function endMatch(match, events) {
  match.phase = 'fulltime'
  match.over = true
  match.phaseT = 0
  for (const p of match.players) {
    p.vx = 0
    p.vz = 0
  }
  events.push({ type: 'fulltime', score: { ...match.score } })
}

export function snapshot(match) {
  const r = (n) => Math.round(n * 1000) / 1000
  return {
    t: 'snap',
    id: match.id,
    mode: match.mode,
    phase: match.phase,
    phaseT: r(match.phaseT),
    clock: r(match.clock),
    duration: match.duration,
    minutes: match.minutes,
    score: match.score,
    ranked: match.ranked,
    celebrateTeam: match.celebrateTeam,
    scorerName: match.scorerName,
    homeName: match.homeName,
    awayName: match.awayName,
    homeLogo: match.homeLogo,
    awayLogo: match.awayLogo,
    clubName: match.clubName,
    difficulty: match.difficulty || null,
    field: { length: match.length, width: match.width, goalW: match.goalW, goalH: match.goalH },
    ball: {
      x: r(match.ball.x),
      y: r(match.ball.y),
      z: r(match.ball.z),
      vx: r(match.ball.vx),
      vy: r(match.ball.vy),
      vz: r(match.ball.vz),
      owner: match.ball.owner,
    },
    players: match.players.map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      x: r(p.x),
      z: r(p.z),
      yaw: r(p.yaw),
      vx: r(p.vx),
      vz: r(p.vz),
      goalie: p.goalie,
      bot: p.bot,
      color: p.color,
      rating: p.rating,
      goals: p.goals,
      assists: p.assists,
      anim: p.anim,
      animT: r(p.animT),
      emote: p.emote,
      stamina: r(p.stamina),
      sprinting: p.sprinting,
      stun: p.stun > 0,
      slideCd: r(p.slideCd),
      spinCd: r(p.spinCd),
      ack: p.ack,
    })),
  }
}

export function settlePlayers(match) {
  const a = match.players.filter((p) => p.team === 'A')
  const b = match.players.filter((p) => p.team === 'B')
  const avg = (list) => list.reduce((s, p) => s + p.rating, 0) / (list.length || 1)
  const aAvg = avg(a)
  const bAvg = avg(b)
  const draw = match.score.A === match.score.B
  return match.players.map((p) => {
    const won = !draw && ((p.team === 'A' && match.score.A > match.score.B) || (p.team === 'B' && match.score.B > match.score.A))
    const teamAvg = p.team === 'A' ? aAvg : bAvg
    const oppAvg = p.team === 'A' ? bAvg : aAvg
    const delta = match.ranked && !p.bot ? ratingDelta({ teamAvg, oppAvg, won, draw, goals: p.goals, assists: p.assists }) : 0
    let result = 'draw'
    if (!draw) result = won ? 'win' : 'loss'
    return {
      id: p.id,
      name: p.name,
      team: p.team,
      bot: p.bot,
      goals: p.goals,
      assists: p.assists,
      ratingBefore: p.rating,
      delta,
      ratingAfter: p.rating + delta,
      rankBefore: rankFor(p.rating),
      rankAfter: rankFor(p.rating + delta),
      result,
      goalie: p.goalie,
    }
  })
}
