import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import { openPostgres } from '../server/pg.js'
import { SCHEMA } from '../server/db.js'

const tables = [
  'users',
  'sessions',
  'clubs',
  'memberships',
  'challenges',
  'club_invites',
  'notifications',
  'friend_edges',
  'reports',
  'matches',
  'match_players',
  'chat_messages',
  'nicknames',
]
const identity = ['users', 'clubs', 'challenges', 'club_invites', 'notifications', 'reports', 'matches', 'chat_messages']

const url = process.env.DATABASE_URL
if (!url) {
  console.error('Set DATABASE_URL to the Neon pooled connection string.')
  process.exit(1)
}
const file = path.resolve(process.argv[2] || 'data/league.sqlite')
if (!fs.existsSync(file)) {
  console.error(`No SQLite file at ${file}`)
  process.exit(1)
}

const sqlite = new DatabaseSync(file)
const pgdb = await openPostgres(url)
await pgdb.exec(SCHEMA)

for (const table of tables) {
  let cols
  try {
    cols = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((col) => col.name)
  } catch {
    continue
  }
  if (!cols.length) continue
  const rows = sqlite.prepare(`SELECT ${cols.join(', ')} FROM ${table}`).all()
  let copied = 0
  for (const row of rows) {
    const values = cols.map((col) => row[col] ?? null)
    const marks = cols.map(() => '?').join(', ')
    const sql = table === 'match_players'
      ? `INSERT INTO match_players (${cols.join(', ')}) SELECT ${marks} WHERE NOT EXISTS (SELECT 1 FROM match_players WHERE match_id = ? AND user_id = ?)`
      : `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${marks}) ON CONFLICT DO NOTHING`
    const params = table === 'match_players' ? [...values, row.match_id, row.user_id] : values
    const info = await pgdb.prepare(sql).run(...params)
    copied += info.changes || 0
  }
  console.log(`${table}: ${copied} new row${copied === 1 ? '' : 's'} (${rows.length} in sqlite)`)
}

for (const table of identity) {
  await pgdb.prepare(
    `SELECT setval(pg_get_serial_sequence(?, 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${table}), 1), 1), true)`,
  ).get(table)
}
await pgdb.close()
sqlite.close()
console.log('SQLite data is in Postgres. Running this again will not duplicate rows.')
