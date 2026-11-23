// Roblox-style thumbstick. dx/dy are pixels from the touch-down point.
export function thumbVector(dx, dy, radius) {
  const r = Math.max(8, radius)
  const dead = r * 0.12
  const mag = Math.hypot(dx, dy)
  if (mag <= dead) return { x: 0, y: 0, strength: 0, sprint: false }
  const strength = Math.min(1, (mag - dead) / (r - dead))
  return {
    x: (dx / mag) * strength,
    y: (dy / mag) * strength,
    strength,
    sprint: strength >= 0.9,
  }
}
