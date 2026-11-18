import { MODES } from '../public/shared/game.js'

export const BOT_DIFFICULTIES = ['easy', 'medium', 'hard']

const EMOTES = ['spin', 'quack', 'bob', 'sit', 'glide']

// Cheap per-difficulty knobs. The whole roster is a handful of distance checks
// once per server tick, so a 3v3 of bots stays light.
const PROFILES = {
  easy: {
    move: 0.55,
    support: 0.42,
    shootDist: 0.85,
    aimError: 0.22,
    passLead: 1.5,
    slideDist: 0.4,
    slideAfter: 2.8,
    spinDist: 0.4,
    sprintAt: 99,
    sprintMin: 70,
    diveReach: 0.72,
    shotSpeed: 1.5,
  },
  medium: {
    move: 0.78,
    support: 0.62,
    shootDist: 1.25,
    aimError: 0.1,
    passLead: 0.65,
    slideDist: 0.52,
    slideAfter: 1.1,
    spinDist: 0.56,
    sprintAt: 1.25,
    sprintMin: 26,
    diveReach: 1.05,
    shotSpeed: 1.05,
  },
  hard: {
    move: 0.96,
    support: 0.82,
    shootDist: 1.7,
    aimError: 0.03,
    passLead: 0.2,
    slideDist: 0.64,
    slideAfter: 0.35,
    spinDist: 0.72,
    sprintAt: 0.75,
    sprintMin: 10,
    diveReach: 1.35,
    shotSpeed: 0.65,
  },
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n))
}

function hash(id) {
  let n = 0
  const s = String(id)
  for (let i = 0; i < s.length; i++) n = (n * 33 + s.charCodeAt(i)) | 0
  return n
}

function profileFor(match) {
  return PROFILES[match.difficulty] || PROFILES.medium
}

function moveToward(p, x, z, scale) {
  const dx = x - p.x
  const dz = z - p.z
  const dist = Math.hypot(dx, dz)
  if (dist < 0.18) {
    p.cmd.mx = 0
    p.cmd.mz = 0
    return dist
  }
  p.cmd.mx = (dx / dist) * scale
  p.cmd.mz = (dz / dist) * scale
  return dist
}

function face(p, x, z) {
  p.yaw = Math.atan2(x - p.x, z - p.z)
}

export function driveBots(match) {
  const profile = profileFor(match)
  const ball = match.ball
  let chaseId = null
  let chaseDist = Infinity
  let pressId = null
  let pressDist = Infinity
  if (!ball.owner) {
    for (const p of match.players) {
      if (!p.bot || p.goalie) continue
      const dist = Math.hypot(ball.x - p.x, ball.z - p.z)
      if (dist < chaseDist) {
        chaseDist = dist
        chaseId = p.id
      }
    }
  } else {
    for (const p of match.players) {
      if (!p.bot || p.goalie || p.id === ball.owner) continue
      const owner = match.players.find((q) => q.id === ball.owner)
      if (!owner || owner.team === p.team) continue
      const dist = Math.hypot(owner.x - p.x, owner.z - p.z)
      if (dist < pressDist) {
        pressDist = dist
        pressId = p.id
      }
    }
  }

  for (const p of match.players) {
    if (!p.bot) continue
    p.cmd.sprint = false
    if (match.phase === 'celebrate') {
      p.cmd.mx = 0
      p.cmd.mz = 0
      if (p.team === match.celebrateTeam && !p.emote) {
        p.pressed.emote = EMOTES[Math.abs(hash(p.id)) % EMOTES.length]
      }
      continue
    }
    if (match.phase !== 'play') continue
    const dir = p.team === 'A' ? 1 : -1
    const goalZ = dir * (match.length / 2 - 0.3)
    if (p.goalie) {
      driveGoalie(match, p, profile, dir)
      continue
    }
    if (ball.owner === p.id) {
      driveCarrier(match, p, profile, goalZ, dir)
      continue
    }
    if (ball.owner) {
      const carrier = match.players.find((q) => q.id === ball.owner)
      if (carrier && carrier.team !== p.team) {
        if (p.id === pressId) {
          const dist = moveToward(p, carrier.x, carrier.z, profile.move)
          p.cmd.sprint = dist > profile.sprintAt && p.stamina > profile.sprintMin
          if (dist < profile.slideDist && p.slideCd <= 0 && match.elapsed > profile.slideAfter) {
            face(p, carrier.x, carrier.z)
            p.pressed.slide = true
          }
        } else {
          moveToward(p, p.team === 'A' ? -0.7 : 0.7, goalZ * 0.35, profile.support)
        }
      } else if (carrier) {
        const spotZ = clamp(carrier.z + dir * 1.15, -match.length / 2 + 0.6, match.length / 2 - 0.6)
        const spotX = ((hash(p.id) % 3) - 1) * 0.7
        moveToward(p, spotX, spotZ, profile.support)
      }
      continue
    }
    if (p.id === chaseId) {
      const dist = moveToward(p, ball.x, ball.z, profile.move)
      p.cmd.sprint = dist > profile.sprintAt && p.stamina > profile.sprintMin
    } else {
      moveToward(p, (hash(p.id) % 2 === 0 ? -0.6 : 0.6), goalZ * 0.4, profile.support)
    }
  }
}

function driveGoalie(match, p, profile, dir) {
  const ball = match.ball
  const line = -dir * (match.length / 2 - 0.4)
  const tx = clamp(ball.x * 0.9, -match.goalW * 0.42, match.goalW * 0.42)
  moveToward(p, tx, line, 0.9)
  const towardOwn = dir === 1 ? ball.vz < -profile.shotSpeed : ball.vz > profile.shotSpeed
  const near = Math.hypot(ball.x - p.x, ball.z - p.z) < profile.diveReach
  if (!ball.owner && towardOwn && near && p.diveCd <= 0) p.pressed.dive = true
  if (ball.owner === p.id) {
    p.yaw = dir === 1 ? 0 : Math.PI
    p.pressed.kick = true
  }
}

function driveCarrier(match, p, profile, goalZ, dir) {
  const wobble = Math.sin(hash(p.id) * 0.17 + match.elapsed * 0.8) * profile.aimError
  const shotX = clamp(wobble, -0.2, 0.2)
  let teammate = null
  let teammateLead = 0
  const myGoal = Math.abs(goalZ - p.z)
  for (const other of match.players) {
    if (other === p || other.team !== p.team || other.goalie) continue
    const ahead = dir === 1 ? other.z > p.z + 0.4 : other.z < p.z - 0.4
    if (!ahead) continue
    const lead = myGoal - Math.abs(goalZ - other.z)
    const dist = Math.hypot(other.x - p.x, other.z - p.z)
    if (lead > teammateLead && dist < 4.8 && dist > 0.6) {
      teammate = other
      teammateLead = lead
    }
  }
  const closeDefender = defenderNear(match, p, profile.spinDist)
  if (closeDefender && p.spinCd <= 0 && p.spinning <= 0) {
    p.pressed.spin = true
    moveToward(p, shotX, goalZ, profile.move * 0.5)
    return
  }
  const shotDist = Math.hypot(shotX - p.x, goalZ - p.z)
  if (shotDist < profile.shootDist && Math.abs(p.x) < match.goalW * 0.7) {
    face(p, shotX, goalZ)
    p.cmd.mx = 0
    p.cmd.mz = 0
    p.pressed.kick = true
    return
  }
  if (teammate && teammateLead >= profile.passLead) {
    face(p, teammate.x, teammate.z)
    p.pressed.pass = true
    return
  }
  const dist = moveToward(p, shotX, goalZ, profile.move)
  p.cmd.sprint = dist > profile.sprintAt && p.stamina > profile.sprintMin
}

function defenderNear(match, p, radius) {
  for (const other of match.players) {
    if (other.team === p.team) continue
    if (Math.hypot(other.x - p.x, other.z - p.z) < radius) return other
  }
  return null
}

export function botRoster(count, rating) {
  const palette = [
    ['Quackers', '#ffb000'],
    ['Puddles', '#7bd15c'],
    ['Nibbles', '#c084fc'],
    ['Scooter', '#38bdf8'],
    ['Beaky', '#fb7185'],
    ['Dottie', '#94a3b8'],
  ]
  const bots = []
  for (let i = 0; i < count; i++) {
    const [name, color] = palette[i % palette.length]
    bots.push({
      id: `bot-${i + 1}`,
      name,
      rating: Math.round(rating),
      color,
      bot: true,
    })
  }
  return bots
}

export function rosterSize(mode) {
  return MODES[mode].players
}
