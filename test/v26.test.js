import test from 'node:test'
import assert from 'node:assert/strict'
import { createMatch, fieldSize, modeForSide } from '../public/shared/game.js'

function people(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: String(i + 1),
    name: `D${i}`,
    rating: 1000,
    team: i < n / 2 ? 'A' : 'B',
  }))
}

test('fields stay small under 4 players and grow through 8', () => {
  const one = createMatch({ mode: '1v1', minutes: 3, players: people(2) })
  assert.equal(one.length, 7)
  assert.equal(one.width, 4.2)
  const four = createMatch({ mode: '2v2', minutes: 3, players: people(4) })
  assert.ok(four.length > 8.6 && four.length < 10)
  assert.ok(four.width > 5.2)
  const eight = createMatch({ mode: '4v4', minutes: 3, players: people(8) })
  assert.ok(eight.length > four.length)
  assert.equal(eight.goalW, four.goalW)
  assert.equal(modeForSide(4), '4v4')
  assert.equal(fieldSize('1v1', 2).length, 7)
})
