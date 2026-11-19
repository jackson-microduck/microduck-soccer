import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import { rankFor } from '../public/shared/game.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#ff6a1a',
  rating INTEGER NOT NULL DEFAULT 1000,
  goals INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  matches_played INTEGER NOT NULL DEFAULT 0,
  club_id INTEGER,
  is_bot INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clubs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  owner_id INTEGER NOT NULL,
  logo TEXT,
  created_at TEXT NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  goals_for INTEGER NOT NULL DEFAULT 0,
  goals_against INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS memberships (
  user_id INTEGER NOT NULL,
  club_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (user_id, club_id)
);
CREATE TABLE IF NOT EXISTS challenges (
  id INTEGER PRIMARY KEY,
  from_club_id INTEGER NOT NULL,
  to_club_id INTEGER NOT NULL,
  from_user_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  goalies INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  room_code TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS club_invites (
  id INTEGER PRIMARY KEY,
  club_id INTEGER NOT NULL,
  inviter_id INTEGER NOT NULL,
  invitee_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY,
  mode TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  home_score INTEGER NOT NULL,
  away_score INTEGER NOT NULL,
  played_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS match_players (
  match_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  team TEXT NOT NULL,
  goals INTEGER NOT NULL,
  assists INTEGER NOT NULL,
  rating_before INTEGER NOT NULL,
  rating_delta INTEGER NOT NULL,
  result TEXT NOT NULL
);
`

function sqlParam(value, index) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' || typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`SQLite parameter ${index + 1} is not a finite number.`)
    }
    return value
  }
  if (typeof value === 'boolean') {
    throw new TypeError(`SQLite parameter ${index + 1} is a boolean. Bind a string, number, or null.`)
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value
  throw new TypeError(`SQLite parameter ${index + 1} is ${value?.constructor?.name || typeof value}, which node:sqlite cannot bind.`)
}

function wrapDatabase(db) {
  const prepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    const stmt = prepare(sql)
    const call = (method) => (...args) => stmt[method](...args.map((value, index) => sqlParam(value, index)))
    return { run: call('run'), get: call('get'), all: call('all') }
  }
  return db
}

function migrate(db) {
  // Existing league files keep their rows. New columns are added with defaults.
  const row = db.prepare('PRAGMA user_version').get()
  const version = Number(row?.user_version || 0)
  const cols = db.prepare('PRAGMA table_info(users)').all()
  if (cols.length && !cols.some((col) => col.name === 'is_bot')) {
    db.exec('ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0')
  }
  if (version < 1) db.exec('PRAGMA user_version = 1')
  const clubCols = db.prepare('PRAGMA table_info(clubs)').all().map((col) => col.name)
  for (const col of ['wins', 'losses', 'draws', 'goals_for', 'goals_against']) {
    if (clubCols.length && !clubCols.includes(col)) {
      db.exec(`ALTER TABLE clubs ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`)
    }
  }
  const putMember = db.prepare(
    'INSERT OR IGNORE INTO memberships (user_id, club_id, role) VALUES (?, ?, ?)',
  )
  const clubs = db.prepare('SELECT id, owner_id FROM clubs').all()
  for (const club of clubs) putMember.run(club.owner_id, club.id, 'owner')
  const linked = db.prepare('SELECT id, club_id FROM users WHERE club_id IS NOT NULL').all()
  for (const user of linked) {
    const club = clubs.find((row) => row.id === user.club_id)
    if (!club) continue
    putMember.run(user.id, user.club_id, club.owner_id === user.id ? 'owner' : 'member')
  }
}

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  migrate(db)
  return wrapDatabase(db)
}

export function publicUser(db, user) {
  if (!user) return null
  let club = null
  if (user.club_id) {
    const row = db.prepare('SELECT id, name, logo FROM clubs WHERE id = ?').get(user.club_id)
    if (row) club = { id: row.id, name: row.name, logo: row.logo || null }
  }
  return {
    id: user.id,
    username: user.username,
    color: user.color,
    rating: user.rating,
    rank: rankFor(user.rating),
    goals: user.goals,
    assists: user.assists,
    wins: user.wins,
    losses: user.losses,
    draws: user.draws,
    matches: user.matches_played,
    club,
  }
}

export function getUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null
}

export function getUserByName(db, username) {
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) || null
}

export function searchUsers(db, q, limit = 30) {
  const query = String(q || '').trim().slice(0, 16).replace(/[%_]/g, '')
  let rows
  let total
  const human = 'COALESCE(is_bot, 0) = 0'
  if (!query) {
    total = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${human}`).get().n
    rows = db.prepare(`SELECT * FROM users WHERE ${human} ORDER BY username COLLATE NOCASE LIMIT ?`).all(limit)
  } else {
    total = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${human} AND username LIKE ? COLLATE NOCASE`).get(`%${query}%`).n
    rows = db.prepare(`SELECT * FROM users WHERE ${human} AND username LIKE ? COLLATE NOCASE ORDER BY username COLLATE NOCASE LIMIT ?`).all(`%${query}%`, limit)
  }
  return { total, players: rows.map((row) => publicUser(db, row)) }
}

export function clubSummary(db, clubId) {
  const club = db.prepare('SELECT * FROM clubs WHERE id = ?').get(clubId)
  if (!club) return null
  const members = db.prepare(`SELECT u.* FROM memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.club_id = ? AND COALESCE(u.is_bot, 0) = 0
    ORDER BY u.rating DESC, u.goals DESC, u.username COLLATE NOCASE`).all(clubId)
  const owner = members.find((m) => m.id === club.owner_id) || getUserById(db, club.owner_id)
  return {
    id: club.id,
    name: club.name,
    code: club.code,
    owner: owner ? owner.username : '',
    ownerId: club.owner_id,
    logo: club.logo || null,
    createdAt: club.created_at,
    totals: {
      goals: members.reduce((s, m) => s + m.goals, 0),
      assists: members.reduce((s, m) => s + m.assists, 0),
      wins: members.reduce((s, m) => s + m.wins, 0),
      matches: members.reduce((s, m) => s + m.matches_played, 0),
    },
    members: members.map((m) => publicUser(db, m)),
    record: {
      wins: club.wins || 0,
      losses: club.losses || 0,
      draws: club.draws || 0,
      goalsFor: club.goals_for || 0,
      goalsAgainst: club.goals_against || 0,
    },
  }
}

export function membership(db, userId, clubId) {
  return db.prepare('SELECT role FROM memberships WHERE user_id = ? AND club_id = ?').get(userId, clubId) || null
}

export function ownedCount(db, userId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? AND role = 'owner'`).get(userId).n
}

export function myClubs(db, userId) {
  const rows = db.prepare(`SELECT c.id, c.name, c.logo, m.role
    FROM memberships m JOIN clubs c ON c.id = m.club_id
    WHERE m.user_id = ?
    ORDER BY c.name COLLATE NOCASE`).all(userId)
  const brief = (row) => ({ id: row.id, name: row.name, logo: row.logo || null, role: row.role })
  return {
    owned: rows.filter((row) => row.role === 'owner').map(brief),
    joined: rows.filter((row) => row.role !== 'owner').map(brief),
  }
}

export function setActiveClub(db, userId, clubId) {
  db.prepare('UPDATE users SET club_id = ? WHERE id = ?').run(clubId, userId)
}

export function addMembership(db, userId, clubId, role) {
  db.prepare('INSERT OR IGNORE INTO memberships (user_id, club_id, role) VALUES (?, ?, ?)').run(userId, clubId, role)
}

function clubBetter(a, b) {
  const points = (row) => row.wins * 3 + row.draws
  const gd = (row) => row.goals_for - row.goals_against
  if (points(a) !== points(b)) return points(a) > points(b)
  if (gd(a) !== gd(b)) return gd(a) > gd(b)
  if (a.goals_for !== b.goals_for) return a.goals_for > b.goals_for
  return String(a.name).toLowerCase() < String(b.name).toLowerCase()
}

function presentClubRank(row, rank) {
  const gd = (row.goals_for || 0) - (row.goals_against || 0)
  return {
    rank,
    id: row.id,
    name: row.name,
    logo: row.logo || null,
    wins: row.wins || 0,
    losses: row.losses || 0,
    draws: row.draws || 0,
    goalsFor: row.goals_for || 0,
    goalsAgainst: row.goals_against || 0,
    goalDifference: gd,
    points: (row.wins || 0) * 3 + (row.draws || 0),
  }
}

export function leaderboards(db, userId) {
  const humans = db.prepare(`SELECT id, username, rating, goals, assists, wins, losses, draws
    FROM users WHERE COALESCE(is_bot, 0) = 0
    ORDER BY rating DESC, goals DESC, wins DESC, username COLLATE NOCASE`).all()
  const me = humans.find((row) => row.id === userId) || null
  const playerRank = me ? humans.findIndex((row) => row.id === userId) + 1 : null
  const topPlayers = humans.slice(0, 10).map((row, index) => ({
    rank: index + 1,
    id: row.id,
    username: row.username,
    rating: row.rating,
    goals: row.goals,
    assists: row.assists,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
  }))
  const clubs = db.prepare('SELECT * FROM clubs').all().sort((a, b) => (clubBetter(a, b) ? -1 : clubBetter(b, a) ? 1 : 0))
  const topClubs = clubs.slice(0, 10).map((row, index) => presentClubRank(row, index + 1))
  const mine = myClubs(db, userId)
  const mineIds = new Set([...mine.owned, ...mine.joined].map((club) => club.id))
  const yourClubs = clubs
    .map((row, index) => ({ row, rank: index + 1 }))
    .filter((item) => mineIds.has(item.row.id))
    .map((item) => presentClubRank(item.row, item.rank))
  return {
    players: topPlayers,
    you: me ? {
      rank: playerRank,
      id: me.id,
      username: me.username,
      rating: me.rating,
      goals: me.goals,
      assists: me.assists,
      wins: me.wins,
      losses: me.losses,
      draws: me.draws,
    } : null,
    clubs: topClubs,
    yourClubs,
  }
}

export function recordClubMatch(db, homeId, awayId, score) {
  const homeGoals = score.A | 0
  const awayGoals = score.B | 0
  const apply = db.prepare(`UPDATE clubs SET
    wins = wins + ?,
    losses = losses + ?,
    draws = draws + ?,
    goals_for = goals_for + ?,
    goals_against = goals_against + ?
    WHERE id = ?`)
  const home = homeGoals > awayGoals ? 'win' : homeGoals < awayGoals ? 'loss' : 'draw'
  const away = home === 'win' ? 'loss' : home === 'loss' ? 'win' : 'draw'
  const bump = (id, result, gf, ga) => apply.run(
    result === 'win' ? 1 : 0,
    result === 'loss' ? 1 : 0,
    result === 'draw' ? 1 : 0,
    gf,
    ga,
    id,
  )
  bump(homeId, home, homeGoals, awayGoals)
  bump(awayId, away, awayGoals, homeGoals)
}

export function createNotification(db, { userId, kind, body, payload }) {
  const now = new Date().toISOString()
  const info = db.prepare(
    'INSERT INTO notifications (user_id, kind, body, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(userId, kind, body, JSON.stringify(payload), 'pending', now)
  return getNotification(db, Number(info.lastInsertRowid))
}

export function getNotification(db, id) {
  const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id)
  return row ? presentNote(row) : null
}

export function listNotifications(db, userId) {
  const rows = db.prepare(
    'SELECT * FROM notifications WHERE user_id = ? AND status = ? ORDER BY id DESC LIMIT 30',
  ).all(userId, 'pending')
  return rows.map(presentNote)
}

function presentNote(row) {
  return {
    id: row.id,
    kind: row.kind,
    body: row.body,
    payload: JSON.parse(row.payload),
    status: row.status,
    createdAt: row.created_at,
  }
}

export function setNotificationStatus(db, id, userId, status) {
  db.prepare('UPDATE notifications SET status = ? WHERE id = ? AND user_id = ?').run(status, id, userId)
  return getNotification(db, id)
}

export function persistResult(db, { mode, minutes, score, players }) {
  const now = new Date().toISOString()
  const info = db.prepare(
    'INSERT INTO matches (mode, minutes, home_score, away_score, played_at) VALUES (?, ?, ?, ?, ?)',
  ).run(mode, minutes, score.A, score.B, now)
  const matchId = Number(info.lastInsertRowid)
  const insert = db.prepare(
    'INSERT INTO match_players (match_id, user_id, team, goals, assists, rating_before, rating_delta, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const update = db.prepare(`UPDATE users SET
    rating = rating + ?,
    goals = goals + ?,
    assists = assists + ?,
    matches_played = matches_played + 1,
    ${'wins'} = wins + ?,
    losses = losses + ?,
    draws = draws + ?
    WHERE id = ?`)
  for (const p of players) {
    if (p.bot) continue
    const userId = Number(p.id)
    if (!Number.isFinite(userId)) continue
    insert.run(matchId, userId, p.team, p.goals, p.assists, p.ratingBefore, p.delta, p.result)
    update.run(
      p.delta,
      p.goals,
      p.assists,
      p.result === 'win' ? 1 : 0,
      p.result === 'loss' ? 1 : 0,
      p.result === 'draw' ? 1 : 0,
      userId,
    )
  }
  return matchId
}
