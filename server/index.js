import express from 'express'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
import {
  cleanColor,
  cleanUsername,
  hashPassword,
  randomCode,
  randomToken,
  validLogo,
  verifyPassword,
} from './auth.js'
import {
  addMembership,
  clubSummary,
  createNotification,
  getNotification,
  getUserById,
  getUserByName,
  leaderboards,
  listNotifications,
  membership,
  myClubs,
  openDatabase,
  ownedCount,
  publicUser,
  searchUsers,
  setActiveClub,
  setNotificationStatus,
} from './db.js'
import { createHub } from './hub.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const hits = new Map()

function limited(key, max, windowMs) {
  const now = Date.now()
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs)
  if (recent.length >= max) {
    hits.set(key, recent)
    return true
  }
  recent.push(now)
  hits.set(key, recent)
  return false
}

function readCookie(req, name) {
  const raw = req.headers.cookie || ''
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return ''
}

function writeCookie(res, req, token, clear = false) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https'
  const parts = [
    `md=${clear ? '' : token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    clear ? 'Max-Age=0' : 'Max-Age=31536000',
  ]
  if (secure) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

export function start(opts = {}) {
  const dbPath = opts.dbPath || path.join(root, 'data', 'league.sqlite')
  const db = openDatabase(dbPath)
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json({ limit: '2mb' }))

  function userFrom(req) {
    const token = readCookie(req, 'md')
    if (!token) return null
    const session = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token)
    if (!session) return null
    return getUserById(db, session.user_id)
  }

  function requireUser(req, res) {
    const user = userFrom(req)
    if (!user) {
      res.status(401).json({ error: 'Log in first.' })
      return null
    }
    return user
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, game: 'microduck-league' })
  })

  if (process.env.ALLOW_TEST_HOOKS === '1') {
    app.get('/api/test-boom', () => {
      throw new Error('Boom from the server')
    })
  }

  function routeId(value) {
    const n = Number(value)
    return Number.isInteger(n) && n > 0 ? n : null
  }

  app.post('/api/signup', (req, res) => {
    const ip = req.ip || 'local'
    if (limited(`up:${ip}`, 20, 60_000)) return res.status(429).json({ error: 'Too many signups. Wait a minute.' })
    const username = cleanUsername(req.body?.username)
    const password = String(req.body?.password || '')
    if (!username) return res.status(400).json({ error: 'Usernames are 3–16 letters, numbers, or underscores.' })
    if (password.length < 4 || password.length > 72) {
      return res.status(400).json({ error: 'Use a password between 4 and 72 characters.' })
    }
    if (getUserByName(db, username)) return res.status(409).json({ error: 'That username is taken. Try another.' })
    const now = new Date().toISOString()
    const info = db.prepare(
      'INSERT INTO users (username, password_hash, color, created_at) VALUES (?, ?, ?, ?)',
    ).run(username, hashPassword(password), cleanColor(req.body?.color), now)
    const token = randomToken()
    db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, Number(info.lastInsertRowid), now)
    writeCookie(res, req, token)
    res.json({ user: publicUser(db, getUserById(db, Number(info.lastInsertRowid))) })
  })

  app.post('/api/login', (req, res) => {
    const ip = req.ip || 'local'
    if (limited(`in:${ip}`, 30, 60_000)) return res.status(429).json({ error: 'Too many tries. Wait a minute.' })
    const username = cleanUsername(req.body?.username)
    const password = String(req.body?.password || '')
    const user = username ? getUserByName(db, username) : null
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Username or password does not match.' })
    }
    const token = randomToken()
    db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, user.id, new Date().toISOString())
    writeCookie(res, req, token)
    res.json({ user: publicUser(db, user) })
  })

  app.post('/api/logout', (req, res) => {
    const token = readCookie(req, 'md')
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
    writeCookie(res, req, '', true)
    res.json({ ok: true })
  })

  app.get('/api/me', (req, res) => {
    const user = userFrom(req)
    res.json({ user: user ? publicUser(db, user) : null })
  })

  app.patch('/api/me', (req, res) => {
    const user = requireUser(req, res)
    if (!user) return
    const color = cleanColor(req.body?.color)
    db.prepare('UPDATE users SET color = ? WHERE id = ?').run(color, user.id)
    res.json({ user: publicUser(db, getUserById(db, user.id)) })
  })

  app.get('/api/players', (req, res) => {
    if (!requireUser(req, res)) return
    const data = searchUsers(db, req.query.q, 40)
    res.json(data)
  })

  app.get('/api/players/:username', (req, res) => {
    if (!requireUser(req, res)) return
    const user = getUserByName(db, req.params.username)
    if (!user || user.is_bot) return res.status(404).json({ error: 'No player with that username.' })
    res.json({ player: publicUser(db, user) })
  })

  app.post('/api/clubs', (req, res) => {
    const user = requireUser(req, res)
    if (!user) return
    if (ownedCount(db, user.id) >= 8) {
      return res.status(400).json({ error: 'You can own up to 8 clubs.' })
    }
    const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ')
    if (!/^[A-Za-z0-9 ]{3,24}$/.test(name)) {
      return res.status(400).json({ error: 'Club names are 3–24 letters, numbers, and spaces.' })
    }
    let code = randomCode()
    for (let i = 0; i < 6 && db.prepare('SELECT id FROM clubs WHERE code = ?').get(code); i++) code = randomCode()
    const now = new Date().toISOString()
    const info = db.prepare(
      'INSERT INTO clubs (name, code, owner_id, created_at) VALUES (?, ?, ?, ?)',
    ).run(name, code, user.id, now)
    const clubId = Number(info.lastInsertRowid)
    addMembership(db, user.id, clubId, 'owner')
    setActiveClub(db, user.id, clubId)
    res.json({ club: clubSummary(db, clubId) })
  })

  app.post('/api/clubs/join', (req, res) => {
    const user = requireUser(req, res)
    if (!user) return
    const code = String(req.body?.code || '').trim().toUpperCase()
    const club = db.prepare('SELECT * FROM clubs WHERE code = ?').get(code)
    if (!club) return res.status(404).json({ error: 'No club uses that code.' })
    if (membership(db, user.id, club.id)) return res.status(400).json({ error: 'You are already in that club.' })
    addMembership(db, user.id, club.id, 'member')
    if (!user.club_id) setActiveClub(db, user.id, club.id)
    res.json({ club: clubSummary(db, club.id) })
  })

  app.post('/api/clubs/active', (req, res) => {
    const user = requireUser(req, res)
    if (!user) return
    const clubId = Number(req.body?.id)
    if (!membership(db, user.id, clubId)) return res.status(403).json({ error: 'You are not in that club.' })
    setActiveClub(db, user.id, clubId)
    const lists = myClubs(db, user.id)
    res.json({ club: clubSummary(db, clubId), owned: lists.owned, joined: lists.joined, user: publicUser(db, getUserById(db, user.id)) })
  })

  app.post('/api/clubs/leave', (req, res) => {
    const user = requireUser(req, res)
    if (!user) return
    const clubId = Number(req.body?.clubId) || user.club_id
    if (!clubId || !membership(db, user.id, clubId)) {
      return res.json({ ok: true, user: publicUser(db, getUserById(db, user.id)) })
    }
    const club = db.prepare('SELECT * FROM clubs WHERE id = ?').get(clubId)
    db.prepare('DELETE FROM memberships WHERE user_id = ? AND club_id = ?').run(user.id, clubId)
    if (club && club.owner_id === user.id) {
      const next = db.prepare('SELECT user_id FROM memberships WHERE club_id = ? ORDER BY user_id LIMIT 1').get(clubId)
      if (next) {
        db.prepare(`UPDATE memberships SET role = 'owner' WHERE user_id = ? AND club_id = ?`).run(next.user_id, clubId)
        db.prepare('UPDATE clubs SET owner_id = ? WHERE id = ?').run(next.user_id, clubId)
      } else {
        db.prepare('DELETE FROM clubs WHERE id = ?').run(clubId)
      }
    }
    if (user.club_id === clubId) {
      const next = db.prepare('SELECT club_id FROM memberships WHERE user_id = ? ORDER BY club_id LIMIT 1').get(user.id)
      setActiveClub(db, user.id, next ? next.club_id : null)
    }
    const lists = myClubs(db, user.id)
    const fresh = getUserById(db, user.id)
    res.json({
      ok: true,
      user: publicUser(db, fresh),
      club: fresh.club_id ? clubSummary(db, fresh.club_id) : null,
      owned: lists.owned,
      joined: lists.joined,
    })
  })

  app.get('/api/clubs/mine', (req, res) => {
    const user = requireUser(req, res)
    if (!user) return
    const lists = myClubs(db, user.id)
    res.json({
      club: user.club_id ? clubSummary(db, user.club_id) : null,
      owned: lists.owned,
      joined: lists.joined,
    })
  })

  app.get('/api/leaderboards', (req, res) => {
    const user = requireUser(req, res)
    if (!user) return
    res.json(leaderboards(db, user.id))
  })

  app.post('/api/clubs/challenge', (req, res) => {
    const user = requireUser(req, res)
    if (!user) return
    if (!user.club_id) return res.status(400).json({ error: 'Pick a club you own first.' })
    const from = db.prepare('SELECT * FROM clubs WHERE id = ?').get(user.club_id)
    if (!from || from.owner_id !== user.id) return res.status(403).json({ error: 'Only a club owner can send a challenge.' })
    const name = String(req.body?.name || '').trim()
    const to = db.prepare('SELECT * FROM clubs WHERE name = ? COLLATE NOCASE').get(name)
    if (!to) return res.status(404).json({ error: 'No club with that name.' })
    if (to.id === from.id) return res.status(400).json({ error: 'Pick a different club.' })
    const mode = req.body?.mode
    const minutes = Number(req.body?.minutes)
    if (!['1v1', '2v2', '3v3'].includes(mode) || ![3, 5].includes(minutes)) {
      return res.status(400).json({ error: 'Pick 1v1, 2v2, or 3v3 and a 3 or 5 minute match.' })
    }
    const goalies = mode === '3v3' && req.body?.goalies !== false && req.body?.goalies !== 0 ? 1 : 0
    const now = new Date().toISOString()
    const info = db.prepare(
      `INSERT INTO challenges (from_club_id, to_club_id, from_user_id, mode, minutes, goalies, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(from.id, to.id, user.id, mode, minutes, goalies, 'pending', now)
    const keeper = mode === '3v3' ? (goalies ? 'with goalies' : 'with no goalies') : ''
    const note = createNotification(db, {
      userId: to.owner_id,
      kind: 'club_challenge',
      body: `${from.name} challenged ${to.name} to ${mode} · ${minutes} min${keeper ? ` ${keeper}` : ''}.`,
      payload: {
        challengeId: Number(info.lastInsertRowid),
        fromClub: from.name,
        toClub: to.name,
        mode,
        minutes,
        goalies,
      },
    })
    hub.pushNote(to.owner_id, note)
    res.json({ ok: true })
  })

  app.get('/api/clubs/:id', (req, res) => {
    const user = requireUser(req, res)
    if (!user) return
    const clubId = routeId(req.params.id)
    const club = clubId ? clubSummary(db, clubId) : null
    if (!club) return res.status(404).json({ error: 'Club not found.' })
    if (!membership(db, user.id, club.id)) club.code = null
    res.json({ club })
  })

  app.post('/api/clubs/logo', (req, res) => {
    const user = requireUser(req, res)
    if (!user) return
    if (!user.club_id) return res.status(400).json({ error: 'Create or join a club first.' })
    const club = db.prepare('SELECT * FROM clubs WHERE id = ?').get(user.club_id)
    if (!club || club.owner_id !== user.id) return res.status(403).json({ error: 'Only the club creator can change the logo.' })
    const logo = validLogo(req.body?.logo)
    if (logo === false) return res.status(400).json({ error: 'Logo must be a small PNG or JPEG.' })
    db.prepare('UPDATE clubs SET logo = ? WHERE id = ?').run(logo, club.id)
    res.json({ club: clubSummary(db, club.id) })
  })

  app.post('/api/clubs/invites', (req, res) => {
    const user = requireUser(req, res)
    if (!user) return
    if (!user.club_id) return res.status(400).json({ error: 'Join a club before inviting friends.' })
    const name = cleanUsername(req.body?.username)
    if (!name) return res.status(400).json({ error: 'Enter a username.' })
    const target = getUserByName(db, name)
    if (!target || target.is_bot) return res.status(404).json({ error: 'No player with that username.' })
    if (target.id === user.id) return res.status(400).json({ error: 'You are already in your club.' })
    const club = db.prepare('SELECT * FROM clubs WHERE id = ?').get(user.club_id)
    if (!club || club.owner_id !== user.id) return res.status(403).json({ error: 'Only the club owner can invite.' })
    if (membership(db, target.id, club.id)) return res.status(400).json({ error: `${target.username} is already in this club.` })
    const existing = db.prepare(
      'SELECT id FROM club_invites WHERE club_id = ? AND invitee_id = ? AND status = ?',
    ).get(user.club_id, target.id, 'pending')
    if (existing) return res.status(400).json({ error: 'That invite is already waiting.' })
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO club_invites (club_id, inviter_id, invitee_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(club.id, user.id, target.id, 'pending', now)
    const note = createNotification(db, {
      userId: target.id,
      kind: 'club_invite',
      body: `${user.username} invited you to join ${club.name}`,
      payload: { from: user.username, clubName: club.name, clubId: club.id, logo: club.logo || null },
    })
    hub.pushNote(target.id, note)
    res.json({ ok: true })
  })

  app.get('/api/notifications', (req, res) => {
    const user = requireUser(req, res)
    if (!user) return
    res.json({ notifications: listNotifications(db, user.id) })
  })

  app.post('/api/notifications/:id/respond', (req, res) => {
    const user = requireUser(req, res)
    if (!user) return
    const noteId = routeId(req.params.id)
    const note = noteId ? getNotification(db, noteId) : null
    if (!note || note.payload == null) return res.status(404).json({ error: 'Invite not found.' })
    const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(noteId)
    if (!row || row.user_id !== user.id) return res.status(404).json({ error: 'Invite not found.' })
    if (row.status !== 'pending') return res.json({ notification: getNotification(db, row.id) })
    const action = req.body?.action === 'accept' ? 'accepted' : 'declined'
    let roomCode = null
    if (action === 'accepted' && row.kind === 'club_invite') {
      const fresh = getUserById(db, user.id)
      const payload = JSON.parse(row.payload)
      const club = db.prepare('SELECT id FROM clubs WHERE id = ?').get(payload.clubId)
      if (!club) return res.status(400).json({ error: 'That club is gone.' })
      if (membership(db, user.id, club.id)) return res.status(400).json({ error: 'You are already in that club.' })
      addMembership(db, user.id, club.id, 'member')
      if (!fresh.club_id) setActiveClub(db, user.id, club.id)
      db.prepare(
        'UPDATE club_invites SET status = ? WHERE club_id = ? AND invitee_id = ? AND status = ?',
      ).run('accepted', club.id, user.id, 'pending')
    }
    if (row.kind === 'club_challenge') {
      const payload = JSON.parse(row.payload)
      const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(payload.challengeId)
      if (!challenge || challenge.status !== 'pending') {
        return res.status(400).json({ error: 'That challenge is already settled.' })
      }
      const toClub = db.prepare('SELECT * FROM clubs WHERE id = ?').get(challenge.to_club_id)
      const fromClub = db.prepare('SELECT * FROM clubs WHERE id = ?').get(challenge.from_club_id)
      if (!toClub || toClub.owner_id !== user.id) {
        return res.status(403).json({ error: 'Only that club’s owner can answer.' })
      }
      if (action === 'declined') {
        db.prepare('UPDATE challenges SET status = ? WHERE id = ?').run('declined', challenge.id)
        if (fromClub) {
          const note = createNotification(db, {
            userId: fromClub.owner_id,
            kind: 'club_challenge_result',
            body: `${toClub.name} declined the match.`,
            payload: { challengeId: challenge.id, fromClub: fromClub.name, toClub: toClub.name },
          })
          hub.pushNote(fromClub.owner_id, note)
        }
      } else if (fromClub) {
        const room = hub.openChallenge({
          fromClub,
          toClub,
          ownerId: fromClub.owner_id,
          mode: challenge.mode,
          minutes: challenge.minutes,
          goalies: challenge.goalies,
        })
        roomCode = room.code
        db.prepare('UPDATE challenges SET status = ?, room_code = ? WHERE id = ?').run('accepted', room.code, challenge.id)
        const members = db.prepare('SELECT user_id FROM memberships WHERE club_id = ? OR club_id = ?').all(fromClub.id, toClub.id)
        const told = new Set()
        for (const member of members) {
          if (told.has(member.user_id)) continue
          told.add(member.user_id)
          const note = createNotification(db, {
            userId: member.user_id,
            kind: 'club_match',
            body: `${fromClub.name} vs ${toClub.name} is on. Room ${room.code}.`,
            payload: {
              roomCode: room.code,
              mode: challenge.mode,
              minutes: challenge.minutes,
              goalies: challenge.goalies,
            },
          })
          hub.pushNote(member.user_id, note)
        }
      }
    }
    if (action === 'declined' && row.kind === 'club_invite') {
      const payload = JSON.parse(row.payload)
      db.prepare(
        'UPDATE club_invites SET status = ? WHERE club_id = ? AND invitee_id = ? AND status = ?',
      ).run('declined', payload.clubId, user.id, 'pending')
    }
    setNotificationStatus(db, row.id, user.id, action)
    const freshUser = getUserById(db, user.id)
    res.json({
      notification: getNotification(db, row.id),
      user: publicUser(db, freshUser),
      club: freshUser.club_id ? clubSummary(db, freshUser.club_id) : null,
      roomCode,
    })
  })

  app.use('/vendor/three', express.static(path.join(root, 'node_modules/three')))
  app.use(express.static(path.join(root, 'public')))
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err)
    const message = err instanceof Error && err.message ? err.message : 'Something went wrong.'
    res.status(err.status || 500).json({ error: message })
  })

  const server = http.createServer(app)
  const wss = new WebSocketServer({ server })
  const hub = createHub(db)
  const timer = setInterval(() => hub.tick(), 1000 / 30)

  wss.on('connection', (ws, req) => {
    const token = readCookie(req, 'md')
    const session = token ? db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) : null
    const user = session ? getUserById(db, session.user_id) : null
    if (!user) {
      ws.close(4001, 'login')
      return
    }
    hub.attach(ws, user)
  })

  const port = Number(opts.port ?? process.env.PORT ?? 8741)
  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      const actual = server.address().port
      console.log(`Microduck League on http://127.0.0.1:${actual}`)
      resolve({
        server,
        port: actual,
        db,
        close() {
          clearInterval(timer)
          for (const client of wss.clients) client.close()
          return new Promise((done) => server.close(() => done()))
        },
      })
    })
  })
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirect) start()
