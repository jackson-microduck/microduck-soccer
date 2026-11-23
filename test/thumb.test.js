import test from 'node:test'
import assert from 'node:assert/strict'
import { thumbVector } from '../public/client/thumb.js'

test('thumbstick is linear, has a small deadzone, and sprints at full push', () => {
  const radius = 48
  const still = thumbVector(2, 1, radius)
  assert.equal(still.strength, 0)
  assert.equal(still.sprint, false)
  const mid = thumbVector(0, -24, radius)
  assert.ok(mid.strength > 0.35 && mid.strength < 0.6, JSON.stringify(mid))
  assert.equal(mid.sprint, false)
  assert.ok(mid.y < 0)
  const full = thumbVector(40, -40, radius)
  assert.equal(full.strength, 1)
  assert.equal(full.sprint, true)
  assert.ok(Math.abs(Math.hypot(full.x, full.y) - 1) < 0.001)
})
