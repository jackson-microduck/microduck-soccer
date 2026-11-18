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

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  return db
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
  if (!query) {
    total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n
    rows = db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE LIMIT ?').all(limit)
  } else {
    total = db.prepare('SELECT COUNT(*) AS n FROM users WHERE username LIKE ? COLLATE NOCASE').get(`%${query}%`).n
    rows = db.prepare('SELECT * FROM users WHERE username LIKE ? COLLATE NOCASE ORDER BY username COLLATE NOCASE LIMIT ?').all(`%${query}%`, limit)
  }
  return { total, players: rows.map((row) => publicUser(db, row)) }
}

export function clubSummary(db, clubId) {
  const club = db.prepare('SELECT * FROM clubs WHERE id = ?').get(clubId)
  if (!club) return null
  const members = db.prepare('SELECT * FROM users WHERE club_id = ? ORDER BY rating DESC, goals DESC, username COLLATE NOCASE').all(clubId)
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
  }
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
