import {
  MODES,
  balanceTeams,
  createMatch,
  rankFor,
  setInput,
  settlePlayers,
  snapshot,
  step,
} from '../public/shared/game.js'
import { createNotification, getUserById, persistResult } from './db.js'
import { BOT_DIFFICULTIES, botRoster, driveBots } from './bots.js'
import { randomCode } from './auth.js'

const TICK = 1 / 30

export function createHub(db) {
  const online = new Map()
  const rooms = new Map()
  const queues = new Map()
  const matches = new Map()
  let seq = 1

  function send(ws, obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj))
  }

  function fail(conn, message) {
    send(conn.ws, { t: 'error', message })
  }

  function fresh(id) {
    const user = getUserById(db, id)
    if (!user) return null
    return {
      id: user.id,
      name: user.username,
      rating: user.rating,
      color: user.color,
      bot: false,
    }
  }

  function leaveQueue(conn) {
    if (!conn.queue) return
    const list = queues.get(conn.queue) || []
    queues.set(conn.queue, list.filter((c) => c !== conn))
    const key = conn.queue
    conn.queue = null
    broadcastQueue(key)
  }

  function broadcastQueue(key) {
    const list = queues.get(key) || []
    const [mode, minutes] = key.split(':')
    const payload = {
      t: 'queue',
      mode,
      minutes: Number(minutes),
      count: list.length,
      need: MODES[mode] ? MODES[mode].players : 0,
    }
    for (const conn of list) send(conn.ws, payload)
  }

  function roomView(room) {
    return {
      t: 'room',
      code: room.code,
      mode: room.mode,
      minutes: room.minutes,
      hostId: room.hostId,
      clubOnly: !!room.clubId,
      practice: room.practice,
      clubName: room.clubName,
      clubLogo: room.clubLogo,
      clubId: room.clubId,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        rating: p.rating,
        color: p.color,
        rank: rankFor(p.rating),
        goalie: !!p.wantGoalie,
      })),
      invites: room.invites,
    }
  }

  function sendRoom(room) {
    const view = roomView(room)
    for (const p of room.players) {
      const conn = online.get(p.id)
      if (conn) send(conn.ws, view)
    }
  }

  function leaveRoom(conn) {
    if (!conn.roomCode) return
    const room = rooms.get(conn.roomCode)
    conn.roomCode = null
    if (!room || room.started) return
    room.players = room.players.filter((p) => p.id !== conn.user.id)
    if (!room.players.length) {
      rooms.delete(room.code)
      return
    }
    if (room.hostId === conn.user.id) room.hostId = room.players[0].id
    sendRoom(room)
  }

  function pushNote(userId, note) {
    const conn = online.get(userId)
    if (conn) send(conn.ws, { t: 'note', note })
  }

  function beginMatch(humanConns, { mode, minutes, clubName, clubLogo, fill, difficulty, botMatch }) {
    const need = MODES[mode].players
    const humans = humanConns.map((conn) => ({
      ...fresh(conn.user.id),
      wantGoalie: !!conn.wantGoalie,
    }))
    let bots = []
    if (humans.length < need) {
      if (!fill) return null
      const avg = humans.reduce((sum, p) => sum + p.rating, 0) / humans.length
      bots = botRoster(need - humans.length, avg)
    }
    const seeded = [...humans, ...bots]
    const teams = balanceTeams(seeded)
    if (mode === '3v3') {
      for (const side of ['A', 'B']) {
        const group = teams[side]
        const claim = group.find((p) => p.wantGoalie && !p.bot)
        let keeper = claim
        if (!keeper && botMatch) keeper = group.find((p) => p.bot)
        if (!keeper) keeper = [...group].sort((a, b) => a.rating - b.rating)[0]
        for (const p of group) p.goalie = p === keeper
      }
    }
    const players = []
    for (const side of ['A', 'B']) {
      for (const p of teams[side]) players.push({ ...p, team: side })
    }
    const ranked = bots.length === 0
    const id = `m${seq++}`
    const match = createMatch({
      id,
      mode,
      minutes,
      players,
      ranked,
      homeName: 'Orange',
      awayName: 'Blue',
      homeLogo: clubLogo || null,
      awayLogo: clubLogo || null,
      clubName: clubName || null,
      difficulty: botMatch ? difficulty : (bots.length ? 'medium' : null),
    })
    const sockets = new Set()
    const live = { id, match, sockets, done: false }
    matches.set(id, live)
    for (const conn of humanConns) {
      leaveQueue(conn)
      conn.roomCode = null
      conn.matchId = id
      sockets.add(conn.ws)
      const you = match.players.find((p) => p.id === String(conn.user.id))
      send(conn.ws, {
        t: 'start',
        you: { id: you.id, team: you.team, goalie: you.goalie },
        snap: snapshot(match),
      })
    }
    return live
  }

  function finish(live) {
    if (live.done) return
    live.done = true
    const settled = settlePlayers(live.match)
    if (live.match.ranked) {
      persistResult(db, {
        mode: live.match.mode,
        minutes: live.match.minutes,
        score: live.match.score,
        players: settled,
      })
    }
    const payload = {
      t: 'end',
      ranked: live.match.ranked,
      score: live.match.score,
      mode: live.match.mode,
      minutes: live.match.minutes,
      difficulty: live.match.difficulty,
      clubName: live.match.clubName,
      players: settled.map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        bot: p.bot,
        goals: p.goals,
        assists: p.assists,
        ratingBefore: p.ratingBefore,
        delta: p.delta,
        ratingAfter: p.ratingAfter,
        rankBefore: p.rankBefore,
        rankAfter: p.rankAfter,
        result: p.result,
        goalie: p.goalie,
      })),
    }
    for (const p of live.match.players) {
      if (p.bot) continue
      const conn = online.get(Number(p.id))
      if (!conn) continue
      send(conn.ws, payload)
      if (conn.matchId === live.id) conn.matchId = null
    }
    matches.delete(live.id)
  }

  function tick() {
    for (const live of matches.values()) {
      driveBots(live.match)
      const events = step(live.match, TICK)
      const snap = JSON.stringify(snapshot(live.match))
      const extra = events.length ? JSON.stringify({ t: 'events', events }) : null
      for (const ws of live.sockets) {
        if (ws.readyState === 1) {
          if (extra) ws.send(extra)
          ws.send(snap)
        }
      }
      if (live.match.over) finish(live)
    }
  }

  function onMessage(conn, msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.t === 'queue') {
      const mode = msg.mode
      const minutes = Number(msg.minutes)
      if (!MODES[mode] || ![3, 5].includes(minutes)) return fail(conn, 'Pick 1v1, 2v2, or 3v3 and a 3 or 5 minute match.')
      if (conn.matchId) return fail(conn, 'You are already in a match.')
      leaveRoom(conn)
      leaveQueue(conn)
      const key = `${mode}:${minutes}`
      const list = queues.get(key) || []
      if (!list.includes(conn)) list.push(conn)
      queues.set(key, list)
      conn.queue = key
      broadcastQueue(key)
      if (list.length >= MODES[mode].players) {
        const taken = list.splice(0, MODES[mode].players)
        queues.set(key, list)
        for (const c of taken) c.queue = null
        beginMatch(taken, { mode, minutes, fill: false })
        broadcastQueue(key)
      }
      return
    }
    if (msg.t === 'leave-queue') {
      leaveQueue(conn)
      send(conn.ws, { t: 'queue', count: 0, need: 0 })
      return
    }
    if (msg.t === 'bots') {
      const mode = msg.mode
      const minutes = Number(msg.minutes)
      const difficulty = msg.difficulty
      if (!MODES[mode] || ![3, 5].includes(minutes)) return fail(conn, 'Pick 1v1, 2v2, or 3v3 and a 3 or 5 minute match.')
      if (!BOT_DIFFICULTIES.includes(difficulty)) return fail(conn, 'Pick Easy, Medium, or Hard.')
      if (conn.matchId) return fail(conn, 'You are already in a match.')
      leaveQueue(conn)
      leaveRoom(conn)
      conn.wantGoalie = !!msg.goalie && mode === '3v3'
      const live = beginMatch([conn], {
        mode,
        minutes,
        fill: true,
        difficulty,
        botMatch: true,
      })
      if (!live) return fail(conn, 'Could not start the bot match.')
      return
    }
    if (msg.t === 'host') {
      const mode = msg.mode
      const minutes = Number(msg.minutes)
      if (!MODES[mode] || ![3, 5].includes(minutes)) return fail(conn, 'Pick a mode and a 3 or 5 minute length.')
      if (conn.matchId) return fail(conn, 'You are already in a match.')
      leaveQueue(conn)
      leaveRoom(conn)
      const user = getUserById(db, conn.user.id)
      let club = null
      if (msg.clubOnly) {
        if (!user.club_id) return fail(conn, 'Join a club before hosting a club match.')
        club = db.prepare('SELECT * FROM clubs WHERE id = ?').get(user.club_id)
      }
      let code = randomCode()
      for (let i = 0; i < 8 && rooms.has(code); i++) code = randomCode()
      const me = fresh(user.id)
      const room = {
        code,
        mode,
        minutes,
        hostId: user.id,
        clubId: club ? club.id : null,
        clubName: club ? club.name : null,
        clubLogo: club ? club.logo || null : null,
        practice: !!msg.practice,
        players: [{ ...me, wantGoalie: !!conn.wantGoalie }],
        invites: [],
        started: false,
      }
      rooms.set(code, room)
      conn.roomCode = code
      sendRoom(room)
      return
    }
    if (msg.t === 'join') {
      const code = String(msg.code || '').trim().toUpperCase()
      const room = rooms.get(code)
      if (!room || room.started) return fail(conn, 'That room code is not open.')
      if (conn.matchId) return fail(conn, 'You are already in a match.')
      if (room.players.some((p) => p.id === conn.user.id)) {
        conn.roomCode = code
        sendRoom(room)
        return
      }
      if (room.players.length >= MODES[room.mode].players) return fail(conn, 'That room is full.')
      const user = getUserById(db, conn.user.id)
      if (room.clubId && user.club_id !== room.clubId) return fail(conn, 'This match is only for members of that club.')
      leaveQueue(conn)
      leaveRoom(conn)
      room.players.push({ ...fresh(user.id), wantGoalie: !!conn.wantGoalie })
      room.invites = room.invites.filter((invite) => invite.id !== user.id)
      conn.roomCode = code
      sendRoom(room)
      return
    }
    if (msg.t === 'goalie') {
      conn.wantGoalie = !!msg.on
      const room = rooms.get(conn.roomCode)
      if (!room) return
      const p = room.players.find((item) => item.id === conn.user.id)
      if (p) p.wantGoalie = conn.wantGoalie
      sendRoom(room)
      return
    }
    if (msg.t === 'invite') {
      const room = rooms.get(conn.roomCode)
      if (!room || room.hostId !== conn.user.id) return fail(conn, 'Only the host can invite.')
      if (!room.clubId) return fail(conn, 'Invites are for club matches. Turn on Club match when you create the room.')
      const members = db.prepare('SELECT id, username FROM users WHERE club_id = ?').all(room.clubId)
      const ids = [...new Set((msg.ids || []).map((id) => Number(id)))]
        .filter((id) => members.some((m) => m.id === id) && id !== conn.user.id && !room.players.some((p) => p.id === id))
      if (!ids.length) return fail(conn, 'Pick clubmates who are not already in the room.')
      const chosen = ids.map((id) => members.find((m) => m.id === id))
      for (const member of chosen) {
        const others = chosen.filter((item) => item.id !== member.id).map((item) => item.username)
        const note = createNotification(db, {
          userId: member.id,
          kind: 'match_invite',
          body: `${conn.user.username} invited you to a match for ${room.clubName}`,
          payload: {
            from: conn.user.username,
            fromId: conn.user.id,
            clubName: room.clubName,
            clubId: room.clubId,
            logo: room.clubLogo,
            roomCode: room.code,
            mode: room.mode,
            minutes: room.minutes,
            others,
          },
        })
        if (!room.invites.some((invite) => invite.id === member.id)) {
          room.invites.push({ id: member.id, name: member.username })
        }
        pushNote(member.id, note)
      }
      sendRoom(room)
      send(conn.ws, { t: 'invited', count: chosen.length })
      return
    }
    if (msg.t === 'start') {
      const room = rooms.get(conn.roomCode)
      if (!room || room.hostId !== conn.user.id) return fail(conn, 'Only the host can start.')
      const need = MODES[room.mode].players
      if (room.players.length < need && !room.practice) {
        return fail(conn, `Need ${need} players, or turn on practice ducks to fill the rest.`)
      }
      if (room.players.length < 1) return fail(conn, 'Nobody is in the room.')
      const conns = []
      for (const p of room.players) {
        const c = online.get(p.id)
        if (!c) return fail(conn, 'A player dropped. Have them rejoin the room.')
        conns.push(c)
      }
      const live = beginMatch(conns, {
        mode: room.mode,
        minutes: room.minutes,
        clubName: room.clubName,
        clubLogo: room.clubLogo,
        fill: room.practice,
      })
      if (!live) return fail(conn, 'Need a full room, or turn on practice ducks.')
      rooms.delete(room.code)
      return
    }
    if (msg.t === 'leave') {
      leaveQueue(conn)
      leaveRoom(conn)
      if (conn.matchId) {
        const live = matches.get(conn.matchId)
        if (live) {
          live.sockets.delete(conn.ws)
          const p = live.match.players.find((item) => item.id === String(conn.user.id))
          if (p) {
            p.cmd.mx = 0
            p.cmd.mz = 0
            p.cmd.sprint = false
          }
        }
        conn.matchId = null
      }
      send(conn.ws, { t: 'left' })
      return
    }
    if (msg.t === 'in') {
      if (!conn.matchId) return
      const live = matches.get(conn.matchId)
      if (!live) return
      setInput(live.match, conn.user.id, msg)
      return
    }
    if (msg.t === 'hook-end' && process.env.ALLOW_TEST_HOOKS === '1' && conn.matchId) {
      const live = matches.get(conn.matchId)
      if (!live || live.done) return
      live.match.clock = 0
      live.match.phase = 'fulltime'
      live.match.over = true
      finish(live)
    }
  }

  function attach(ws, user) {
    const prev = online.get(user.id)
    if (prev && prev.ws !== ws) {
      prev.alive = false
      try { prev.ws.close() } catch { /* already gone */ }
    }
    const conn = {
      ws,
      user,
      queue: prev?.queue || null,
      roomCode: prev?.roomCode || null,
      matchId: prev?.matchId || null,
      wantGoalie: !!prev?.wantGoalie,
      alive: true,
    }
    online.set(user.id, conn)
    if (prev?.queue) {
      const list = queues.get(prev.queue) || []
      const idx = list.indexOf(prev)
      if (idx >= 0) list[idx] = conn
    }
    if (conn.matchId && matches.has(conn.matchId)) {
      const live = matches.get(conn.matchId)
      live.sockets.add(ws)
      const you = live.match.players.find((p) => p.id === String(user.id))
      send(ws, { t: 'start', you: { id: you.id, team: you.team, goalie: you.goalie }, snap: snapshot(live.match) })
    } else if (conn.roomCode && rooms.has(conn.roomCode)) {
      send(ws, roomView(rooms.get(conn.roomCode)))
    }
    send(ws, { t: 'ready' })
    ws.on('message', (buf) => {
      let msg
      try { msg = JSON.parse(String(buf)) } catch { return }
      onMessage(conn, msg)
    })
    ws.on('close', () => {
      if (!conn.alive) return
      if (online.get(user.id) !== conn) return
      leaveQueue(conn)
      if (conn.matchId && matches.has(conn.matchId)) {
        const live = matches.get(conn.matchId)
        live.sockets.delete(ws)
        const p = live.match.players.find((item) => item.id === String(user.id))
        if (p) {
          p.cmd.mx = 0
          p.cmd.mz = 0
          p.cmd.sprint = false
        }
      } else {
        leaveRoom(conn)
      }
      online.delete(user.id)
    })
  }

  return { attach, tick, pushNote, online, rooms }
}
