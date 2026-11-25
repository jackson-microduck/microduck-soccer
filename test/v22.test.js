import test from 'node:test'
import assert from 'node:assert/strict'
import { start } from '../server/index.js'

function cookieFrom(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || '']
  const match = /md=([^;]+)/.exec(list.join(';'))
  return match ? `md=${match[1]}` : ''
}

test('feedback saves a note and the token gate stays closed', async () => {
  delete process.env.FEEDBACK_TOKEN
  const app = await start({ port: 0, dbPath: ':memory:' })
  try {
    const closed = await fetch(`http://127.0.0.1:${app.port}/api/feedback`)
    assert.equal(closed.status, 403)
    const res = await fetch(`http://127.0.0.1:${app.port}/api/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Ada', password: 'secret' }),
    })
    const cookie = cookieFrom(res)
    const sent = await fetch(`http://127.0.0.1:${app.port}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ text: 'The goal mouth is too wide' }),
    })
    assert.equal(sent.status, 200)
    process.env.FEEDBACK_TOKEN = 'club-token'
    const wrong = await fetch(`http://127.0.0.1:${app.port}/api/feedback?token=nope`)
    assert.equal(wrong.status, 403)
    const open = await fetch(`http://127.0.0.1:${app.port}/api/feedback?token=club-token`)
    const data = await open.json()
    assert.equal(open.status, 200)
    assert.equal(data.feedback[0].username, 'Ada')
    assert.equal(data.feedback[0].text, 'The goal mouth is too wide')
    const me = await fetch(`http://127.0.0.1:${app.port}/api/me`, { headers: { cookie } })
    assert.equal((await me.json()).user.goals, 0)
  } finally {
    delete process.env.FEEDBACK_TOKEN
    await app.close()
  }
})
