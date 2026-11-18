import { MODES } from '../public/shared/game.js'

const EMOTES = ['spin', 'quack', 'bob', 'sit', 'glide']

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n))
}

function moveToward(p, x, z, scale = 0.7) {
  const dx = x - p.x
  const dz = z - p.z
  const dist = Math.hypot(dx, dz)
  if (dist < 0.2) {
    p.cmd.mx = 0
    p.cmd.mz = 0
    return dist
  }
  p.cmd.mx = (dx / dist) * scale
  p.cmd.mz = (dz / dist) * scale
  return dist
}

export function driveBots(match) {
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
    const ball = match.ball
    const dir = p.team === 'A' ? 1 : -1
    const goalZ = dir * (match.length / 2 - 0.35)
    if (p.goalie) {
      const line = dir * -(match.length / 2 - 0.42)
      const tx = clamp(ball.x * 0.85, -match.goalW * 0.45, match.goalW * 0.45)
      moveToward(p, tx, line)
      const closing = dir === 1 ? ball.vz > 1.2 : ball.vz < -1.2
      if (!ball.owner && closing && Math.hypot(ball.x - p.x, ball.z - p.z) < 1.15) p.pressed.dive = true
      if (ball.owner === p.id) {
        p.yaw = dir === 1 ? 0 : Math.PI
        p.pressed.kick = true
      }
      continue
    }
    if (ball.owner === p.id) {
      const wander = Math.sin(match.elapsed * 2.2 + hash(p.id)) * 0.16
      const shotX = clamp(wander, -0.12, 0.12)
      const dist = moveToward(p, shotX, goalZ, 0.62)
      p.cmd.sprint = false
      if (dist < 1.15 && Math.abs(p.x) < match.goalW * 0.45) {
        p.yaw = Math.atan2(shotX - p.x, goalZ - p.z)
        p.cmd.mx = 0
        p.cmd.mz = 0
        p.pressed.kick = true
      }
      continue
    }
    if (ball.owner) {
      const carrier = match.players.find((q) => q.id === ball.owner)
      if (carrier && carrier.team !== p.team) {
        const dist = moveToward(p, carrier.x, carrier.z, 0.75)
        p.cmd.sprint = dist > 1.4 && p.stamina > 40 && match.elapsed > 3
        if (dist < 0.48 && p.slideCd <= 0 && match.elapsed > 2.4) p.pressed.slide = true
      } else {
        moveToward(p, shotLane(p), goalZ * 0.45, 0.55)
      }
      continue
    }
    const dist = moveToward(p, ball.x, ball.z, 0.8)
    p.cmd.sprint = dist > 1.2 && p.stamina > 40 && match.elapsed > 2
  }
}

function shotLane(p) {
  return p.team === 'A' ? -0.45 : 0.45
}

function hash(id) {
  let n = 0
  const s = String(id)
  for (let i = 0; i < s.length; i++) n = (n * 33 + s.charCodeAt(i)) | 0
  return n
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
