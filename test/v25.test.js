import test from 'node:test'
import assert from 'node:assert/strict'
import { start } from '../server/index.js'

function cookieFrom(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || '']
  const match = /md=([^;]+)/.exec(list.join(';'))
  return match ? `md=${match[1]}` : ''
}

test('player search matches part of a name', async () => {
  const app = await start({ port: 0, dbPath: ':memory:' })
  try {
    const signup = async (username) => {
      const res = await fetch(`http://127.0.0.1:${app.port}/api/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'secret' }),
      })
      return cookieFrom(res)
    }
    const cookie = await signup('Ada')
    await signup('Bea')
    const data = await (await fetch(`http://127.0.0.1:${app.port}/api/players?q=ea`, { headers: { cookie } })).json()
    assert.deepEqual(data.players.map((p) => p.username), ['Bea'])
    const me = await (await fetch(`http://127.0.0.1:${app.port}/api/me`, { headers: { cookie } })).json()
    assert.equal(me.user.goals, 0)
  } finally {
    await app.close()
  }
})
