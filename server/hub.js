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
import { createNotification, getUserById, getUserByName, membership, persistResult, recordClubMatch, touchFriendPlay } from './db.js'
import { BOT_DIFFICULTIES, botRoster, driveBots } from './bots.js'
import { cleanChat, cleanUsername, randomCode } from './auth.js'

const TICK = 1 / 60

export function createHub(db) {
  const online = new Map()
  const rooms = new Map()
  const queues = new Map()
  const matches = new Map()
  const parties = new Map()

  function partyView(party) {
    return {
      t: 'party',
      id: party.id,
      clubId: party.clubId || null,
      members: [...party.members].map((id) => {
        const mate = online.get(id)
        return { id, name: mate?.user?.username || 'Duck', online: !!mate }
      }),
      chat: party.chat || [],
    }
  }

  function sendParty(party) {
    const view = partyView(party)
    for (const id of party.members) {
      const mate = online.get(id)
      if (mate) send(mate.ws, view)
    }
  }

  async function ensureClubParty(conn) {
    const user = await getUserById(db, conn.user.id)
    if (user) conn.user = user
    if (!user?.club_id) return null
    const id = `c${user.club_id}`
    let party = parties.get(id)
    if (!party) {
      party = { id, leaderId: user.id, clubId: user.club_id, members: new Set(), chat: [] }
      parties.set(id, party)
    }
    party.members.add(user.id)
    conn.partyId = id
    party.chat = await loadChat(id)
    sendParty(party)
    return party
  }

  async function loadChat(channel) {
    const rows = await db.prepare(
      'SELECT user_id, username, body FROM chat_messages WHERE channel = ? ORDER BY id DESC LIMIT 40',
    ).all(channel)
    return rows.reverse().map((row) => ({ id: row.user_id, name: row.username, text: row.body }))
  }

  async function saveChat(channel, user, text) {
    await db.prepare(
      'INSERT INTO chat_messages (channel, user_id, username, body, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(channel, user.id, user.username, text, new Date().toISOString())
  }

  function mirrorClubChat(channel, chat) {
    const party = parties.get(channel)
    if (party) {
      party.chat = chat
      sendParty(party)
    }
    for (const room of rooms.values()) {
      if (!room.started && room.clubId && `c${room.clubId}` === channel) {
        room.chat = chat
        sendRoom(room)
      }
    }
  }

  function partyMates(conn) {
    const party = parties.get(conn.partyId)
    if (!party) return [conn]
    const mates = []
    for (const id of party.members) {
      const mate = online.get(id)
      if (mate && !mate.matchId) mates.push(mate)
    }
    return mates.length ? mates : [conn]
  }
  let seq = 1

  function send(ws, obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj))
  }

  function fail(conn, message) {
    send(conn.ws, { t: 'error', message })
  }

  async function fresh(id) {
    const user = await getUserById(db, id)
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
    const [mode, minutes, goalies, kind] = key.split(':')
    const payload = {
      t: 'queue',
      mode,
      minutes: Number(minutes),
      goalies: goalies === '1',
      quick: kind === 'q',
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
      goalies: room.mode === '3v3' ? room.goalies !== false : false,
      versus: !!room.versus,
      awayName: room.awayName || null,
      awayClubId: room.awayClubId || null,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        rating: p.rating,
        color: p.color,
        rank: rankFor(p.rating),
        goalie: !!p.wantGoalie,
        ready: !!p.ready || p.id === room.hostId,
        side: p.side || null,
      })),
      invites: room.invites,
      chat: room.chat || [],
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

  function useGoalies(mode, goalies) {
    return mode === '3v3' && goalies !== false && goalies !== 0
  }

  async function beginMatch(humanConns, opts) {
    const { mode, minutes, clubName, clubLogo, fill, difficulty, botMatch } = opts
    const goaliesOn = useGoalies(mode, opts.goalies)
    const need = MODES[mode].players
    const humans = []
    for (const conn of humanConns) {
      humans.push({
        ...(await fresh(conn.user.id)),
        wantGoalie: goaliesOn && !!conn.wantGoalie,
        side: opts.sides ? opts.sides.get(conn.user.id) : null,
      })
    }
    let bots = []
    let teams
    if (opts.sides) {
      teams = { A: [], B: [] }
      for (const human of humans) teams[human.side === 'B' ? 'B' : 'A'].push(human)
    } else {
      if (humans.length < need) {
        if (!fill) return null
        const avg = humans.reduce((sum, p) => sum + p.rating, 0) / humans.length
        bots = botRoster(need - humans.length, avg)
      }
      teams = balanceTeams([...humans, ...bots])
    }
    if (goaliesOn) {
      for (const side of ['A', 'B']) {
        const group = teams[side]
        const claim = group.find((p) => p.wantGoalie && !p.bot)
        let keeper = claim
        if (!keeper && botMatch) keeper = group.find((p) => p.bot)
        if (!keeper) keeper = [...group].sort((a, b) => a.rating - b.rating)[0]
        for (const p of group) p.goalie = p === keeper
      }
    } else {
      for (const side of ['A', 'B']) {
        for (const p of teams[side]) p.goalie = false
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
      goalies: goaliesOn,
      homeName: opts.homeName || 'Orange',
      awayName: opts.awayName || 'Blue',
      homeLogo: opts.homeLogo || clubLogo || null,
      awayLogo: opts.awayLogo || null,
      clubName: clubName || null,
      difficulty: botMatch ? difficulty : null,
    })
    match.homeClubId = opts.homeClubId || null
    match.awayClubId = opts.awayClubId || null
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

  async function finish(live) {
    if (live.done) return
    live.done = true
    const settled = settlePlayers(live.match)
    await touchFriendPlay(db, settled.filter((p) => !p.bot).map((p) => p.id))
    await persistResult(db, {
      mode: live.match.mode,
      minutes: live.match.minutes,
      score: live.match.score,
      players: settled,
    })
    if (live.match.ranked && live.match.homeClubId && live.match.awayClubId) {
      await recordClubMatch(db, live.match.homeClubId, live.match.awayClubId, live.match.score)
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

  let netTick = 0
  async function tick() {
    netTick++
    const sendSnap = netTick % 3 === 0
    for (const [key, list] of queues) {
      if (!key.endsWith(':q') || !list.length) continue
      const [mode, minutes, goalies] = key.split(':')
      const need = MODES[mode]?.players || 0
      if (!list[0].queueAt) list[0].queueAt = Date.now()
      const waited = Date.now() - list[0].queueAt
      if (list.length < need && waited < 8000) continue
      const taken = list.splice(0, Math.min(need, list.length))
      for (const c of taken) c.queue = null
      await beginMatch(taken, {
        mode,
        minutes: Number(minutes),
        fill: true,
        goalies: goalies === '1',
      })
      broadcastQueue(key)
    }
    for (const live of matches.values()) {
      driveBots(live.match)
      const events = step(live.match, TICK)
      const snap = sendSnap ? JSON.stringify(snapshot(live.match, true)) : null
      const extra = events.length ? JSON.stringify({ t: 'events', events }) : null
      for (const ws of live.sockets) {
        if (ws.readyState !== 1) continue
        if (extra) ws.send(extra)
        if (snap) ws.send(snap)
      }
      if (live.match.over) await finish(live)
    }
  }

  async function onMessage(conn, msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.t === 'quick' || msg.t === 'queue') {
      if (msg.t === 'quick') {
        const mode = msg.mode
        const minutes = Number(msg.minutes)
        if (!MODES[mode] || ![3, 5].includes(minutes)) return fail(conn, 'Pick 1v1, 2v2, or 3v3 and a 3 or 5 minute match.')
        if (conn.matchId) return fail(conn, 'You are already in a match.')
        leaveRoom(conn)
        leaveQueue(conn)
        const goalies = useGoalies(mode, msg.goalies) ? 1 : 0
        const key = `${mode}:${minutes}:${goalies}:q`
        const list = queues.get(key) || []
        conn.queueAt = Date.now()
        for (const mate of partyMates(conn)) {
          if (mate.matchId) continue
          leaveQueue(mate)
          if (!list.includes(mate)) list.push(mate)
          mate.queue = key
          if (!mate.queueAt) mate.queueAt = conn.queueAt
        }
        queues.set(key, list)
        broadcastQueue(key)
        return
      }
    }
    if (msg.t === 'queue') {
      const mode = msg.mode
      const minutes = Number(msg.minutes)
      if (!MODES[mode] || ![3, 5].includes(minutes)) return fail(conn, 'Pick 1v1, 2v2, or 3v3 and a 3 or 5 minute match.')
      if (conn.matchId) return fail(conn, 'You are already in a match.')
      leaveRoom(conn)
      leaveQueue(conn)
      const goalies = useGoalies(mode, msg.goalies) ? 1 : 0
      const key = `${mode}:${minutes}:${goalies}`
      const list = queues.get(key) || []
      if (!list.includes(conn)) list.push(conn)
      queues.set(key, list)
      conn.queue = key
      broadcastQueue(key)
      if (list.length >= MODES[mode].players) {
        const taken = list.splice(0, MODES[mode].players)
        queues.set(key, list)
        for (const c of taken) c.queue = null
        await beginMatch(taken, { mode, minutes, fill: false, goalies: key.endsWith(':1') })
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
      conn.wantGoalie = !!msg.goalie && useGoalies(mode, msg.goalies)
      const live = await beginMatch([conn], {
        mode,
        minutes,
        fill: true,
        difficulty,
        botMatch: true,
        goalies: msg.goalies,
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
      const user = await getUserById(db, conn.user.id)
      let club = null
      if (msg.clubOnly) {
        if (!user.club_id) return fail(conn, 'Join a club before hosting a club match.')
        club = await db.prepare('SELECT * FROM clubs WHERE id = ?').get(user.club_id)
        if (!club || !await membership(db, user.id, club.id)) return fail(conn, 'Join a club before hosting a club match.')
        const open = [...rooms.values()].find((r) => r.clubId === club.id && !r.versus && !r.started)
        if (open) {
          conn.roomCode = open.code
          if (!open.players.some((p) => p.id === user.id)) {
            open.players.push({ ...(await fresh(user.id)), wantGoalie: false, ready: false })
          }
          sendRoom(open)
          return
        }
      }
      let code = randomCode()
      for (let i = 0; i < 8 && rooms.has(code); i++) code = randomCode()
      const me = await fresh(user.id)
      const room = {
        code,
        mode,
        minutes,
        hostId: user.id,
        clubId: club ? club.id : null,
        clubName: club ? club.name : null,
        clubLogo: club ? club.logo || null : null,
        practice: !!msg.practice,
        goalies: useGoalies(mode, msg.goalies),
        versus: false,
        players: [{ ...me, wantGoalie: !!conn.wantGoalie && useGoalies(mode, msg.goalies), ready: true }],
        invites: [],
        chat: club ? await loadChat(`c${club.id}`) : [],
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
      const user = await getUserById(db, conn.user.id)
      if (room.versus) {
        const home = await membership(db, user.id, room.clubId)
        const away = await membership(db, user.id, room.awayClubId)
        if (!home && !away) return fail(conn, 'This match is only for the two clubs.')
        let side
        if (away?.role === 'owner') side = 'B'
        else if (home?.role === 'owner') side = 'A'
        else if (home && !away) side = 'A'
        else if (away && !home) side = 'B'
        else {
          const aCount = room.players.filter((p) => p.side === 'A').length
          const bCount = room.players.filter((p) => p.side === 'B').length
          side = aCount <= bCount ? 'A' : 'B'
        }
        const perTeam = MODES[room.mode].players / 2
        if (room.players.filter((p) => p.side === side).length >= perTeam) {
          return fail(conn, 'That side is full.')
        }
        leaveQueue(conn)
        leaveRoom(conn)
        room.players.push({
          ...(await fresh(user.id)),
          wantGoalie: !!conn.wantGoalie && room.goalies !== false,
          ready: false,
          side,
        })
        conn.roomCode = code
        sendRoom(room)
        return
      }
      if (room.clubId && !await membership(db, user.id, room.clubId)) return fail(conn, 'This match is only for members of that club.')
      leaveQueue(conn)
      leaveRoom(conn)
      room.players.push({ ...(await fresh(user.id)), wantGoalie: !!conn.wantGoalie && room.goalies !== false, ready: false })
      room.invites = room.invites.filter((invite) => invite.id !== user.id)
      conn.roomCode = code
      sendRoom(room)
      return
    }
    if (msg.t === 'ready') {
      const room = rooms.get(conn.roomCode)
      if (!room || room.started) return
      const player = room.players.find((item) => item.id === conn.user.id)
      if (!player || player.id === room.hostId) return
      player.ready = !player.ready
      sendRoom(room)
      return
    }
    if (msg.t === 'options') {
      const room = rooms.get(conn.roomCode)
      if (!room || room.started) return
      if (room.hostId !== conn.user.id) return fail(conn, 'Only the host sets the match.')
      if (!room.clubId || room.versus) return fail(conn, 'Only the host sets the match.')
      const mode = msg.mode
      const minutes = Number(msg.minutes)
      if (!MODES[mode] || ![3, 5].includes(minutes)) return fail(conn, 'Pick a mode and a 3 or 5 minute length.')
      if (room.players.length > MODES[mode].players) return fail(conn, 'Too many players for that mode.')
      room.mode = mode
      room.minutes = minutes
      room.goalies = useGoalies(mode, msg.goalies)
      for (const player of room.players) {
        if (player.id !== room.hostId) player.ready = false
        if (!room.goalies) player.wantGoalie = false
      }
      sendRoom(room)
      return
    }
    if (msg.t === 'goalie') {
      const room = rooms.get(conn.roomCode)
      if (room && room.goalies === false) return fail(conn, 'This match has no goalies.')
      conn.wantGoalie = !!msg.on
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
      const members = await db.prepare(`SELECT u.id, u.username FROM memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.club_id = ? AND COALESCE(u.is_bot, 0) = 0`).all(room.clubId)
      const ids = [...new Set((msg.ids || []).map((id) => Number(id)))]
        .filter((id) => members.some((m) => m.id === id) && id !== conn.user.id && !room.players.some((p) => p.id === id))
      if (!ids.length) return fail(conn, 'Pick clubmates who are not already in the room.')
      const chosen = ids.map((id) => members.find((m) => m.id === id))
      for (const member of chosen) {
        const others = chosen.filter((item) => item.id !== member.id).map((item) => item.username)
        const note = await createNotification(db, {
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
      if ((room.clubId || room.versus) && room.players.some((p) => p.id !== room.hostId && !p.ready)) {
        return fail(conn, 'Wait until the other players are ready.')
      }
      if (room.versus) {
        const perTeam = MODES[room.mode].players / 2
        const home = room.players.filter((p) => p.side === 'A').length
        const away = room.players.filter((p) => p.side === 'B').length
        if (home < perTeam || away < perTeam) {
          return fail(conn, `Each club needs ${perTeam} players.`)
        }
      }
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
      const sides = room.versus ? new Map(room.players.map((p) => [p.id, p.side || 'A'])) : null
      const live = await beginMatch(conns, {
        mode: room.mode,
        minutes: room.minutes,
        clubName: room.versus ? null : room.clubName,
        clubLogo: room.clubLogo,
        fill: room.versus ? false : !!(room.practice || room.clubId),
        goalies: room.goalies,
        sides,
        homeName: room.versus ? room.clubName : 'Orange',
        awayName: room.versus ? room.awayName : 'Blue',
        homeLogo: room.clubLogo,
        awayLogo: room.versus ? room.awayLogo : null,
        homeClubId: room.versus ? room.clubId : null,
        awayClubId: room.versus ? room.awayClubId : null,
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
    if (msg.t === 'say') {
      const text = cleanChat(msg.text)
      if (!text) return
      if (conn.chatAt && Date.now() - conn.chatAt < 400) return
      conn.chatAt = Date.now()
      const room = conn.roomCode && rooms.get(conn.roomCode)
      if (!room || !room.clubId || room.started) return
      const channel = `c${room.clubId}`
      await saveChat(channel, conn.user, text)
      room.chat = await loadChat(channel)
      mirrorClubChat(channel, room.chat)
      return
    }
    if (msg.t === 'party-say') {
      const text = cleanChat(msg.text)
      if (!text) return
      if (conn.chatAt && Date.now() - conn.chatAt < 700) return
      conn.chatAt = Date.now()
      const party = parties.get(conn.partyId)
      if (!party) return fail(conn, 'Join a club or party before chatting.')
      await saveChat(party.id, conn.user, text)
      party.chat = await loadChat(party.id)
      if (party.clubId) mirrorClubChat(party.id, party.chat)
      else sendParty(party)
      return
    }
    if (msg.t === 'party-invite') {
      const target = online.get(Number(msg.id))
      if (!target) return fail(conn, 'They are offline.')
      let party = conn.partyId && parties.get(conn.partyId)
      if (!party || String(party.id).startsWith('c')) {
        party = { id: `p${conn.user.id}`, leaderId: conn.user.id, members: new Set([conn.user.id]), chat: [] }
        parties.set(party.id, party)
        conn.partyId = party.id
        party.chat = await loadChat(party.id)
      }
      const note = await createNotification(db, {
        userId: target.user.id,
        kind: 'party_invite',
        body: `${conn.user.username} invited you to a party`,
        payload: { partyId: party.id, from: conn.user.username },
      })
      pushNote(target.user.id, note)
      sendParty(party)
      return
    }
    if (msg.t === 'party-join') {
      const party = parties.get(String(msg.id))
      if (!party) return fail(conn, 'That party is gone.')
      party.members.add(conn.user.id)
      conn.partyId = party.id
      party.chat = await loadChat(party.id)
      sendParty(party)
      return
    }
    if (msg.t === 'join-player') {
      const target = online.get(Number(msg.id))
      if (!target) return fail(conn, 'They are offline.')
      if (target.matchId) {
        const live = matches.get(target.matchId)
        if (!live || live.done || live.match.over) return fail(conn, 'That match already finished.')
        const bots = live.match.players.filter((p) => p.bot)
        if (!bots.length) return fail(conn, 'That match is humans only.')
        if (conn.matchId) return fail(conn, 'You are already in a match.')
        if (live.match.players.some((p) => p.id === String(conn.user.id))) return fail(conn, 'You are already in that match.')
        const me = await fresh(conn.user.id)
        const slot = bots[bots.length - 1]
        const prev = slot.id
        if (live.match.ball.owner === prev) live.match.ball.owner = String(me.id)
        if (live.match.ball.lastTouch?.id === prev) live.match.ball.lastTouch.id = String(me.id)
        if (live.match.ball.lastPass?.id === prev) live.match.ball.lastPass.id = String(me.id)
        slot.id = String(me.id)
        slot.name = me.name
        slot.rating = me.rating
        slot.color = me.color
        slot.bot = false
        slot.cmd = { mx: 0, mz: 0, sprint: false, sens: 1 }
        leaveQueue(conn)
        leaveRoom(conn)
        conn.matchId = live.id
        live.sockets.add(conn.ws)
        send(conn.ws, {
          t: 'start',
          you: { id: slot.id, team: slot.team, goalie: !!slot.goalie },
          snap: snapshot(live.match),
        })
        const full = JSON.stringify(snapshot(live.match))
        for (const ws of live.sockets) {
          if (ws !== conn.ws && ws.readyState === 1) ws.send(full)
        }
        return
      }
      if (target.roomCode && rooms.has(target.roomCode)) {
        const room = rooms.get(target.roomCode)
        if (!room.players.some((p) => p.id === conn.user.id)) {
          if (room.players.length >= MODES[room.mode].players) return fail(conn, 'That room is full.')
          leaveQueue(conn)
          leaveRoom(conn)
          room.players.push({ ...(await fresh(conn.user.id)), wantGoalie: false, ready: false })
        }
        conn.roomCode = room.code
        sendRoom(room)
        return
      }
      if (target.partyId && parties.has(target.partyId)) {
        const party = parties.get(target.partyId)
        party.members.add(conn.user.id)
        conn.partyId = party.id
        party.chat = await loadChat(party.id)
        sendParty(party)
        return
      }
      return fail(conn, 'They are not in a match or party.')
    }
    if (msg.t === 'invite-name') {
      const room = rooms.get(conn.roomCode)
      if (!room || room.hostId !== conn.user.id || room.started) return fail(conn, 'Only the host can invite.')
      const username = cleanUsername(msg.username)
      if (!username) return fail(conn, 'Type their username.')
      const user = await getUserByName(db, username)
      if (!user || user.is_bot) return fail(conn, 'No player with that name.')
      if (user.id === conn.user.id) return fail(conn, 'That is you.')
      if (room.players.some((p) => p.id === user.id)) return fail(conn, 'They are already in the room.')
      if (room.versus) return fail(conn, 'Both clubs already share this match.')
      if (room.clubId && !await membership(db, user.id, room.clubId)) return fail(conn, 'This club match is only for members.')
      const note = await createNotification(db, {
        userId: user.id,
        kind: 'match_invite',
        body: `${conn.user.username} invited you to a match`,
        payload: { roomCode: room.code, mode: room.mode, minutes: room.minutes, others: [] },
      })
      if (!room.invites.some((invite) => invite.id === user.id)) room.invites.push({ id: user.id, name: user.username })
      pushNote(user.id, note)
      sendRoom(room)
      return
    }
    if (msg.t === 'invite-match') {
      const target = online.get(Number(msg.id))
      if (!target) return fail(conn, 'They are offline.')
      if (!conn.roomCode || !rooms.has(conn.roomCode)) {
        let code = randomCode()
        for (let i = 0; i < 8 && rooms.has(code); i++) code = randomCode()
        const me = await fresh(conn.user.id)
        const room = {
          code,
          mode: '2v2',
          minutes: 3,
          hostId: conn.user.id,
          practice: true,
          goalies: false,
          versus: false,
          players: [{ ...me, wantGoalie: false, ready: true }],
          invites: [],
          chat: [],
          started: false,
        }
        rooms.set(code, room)
        conn.roomCode = code
        sendRoom(room)
      }
      const room = rooms.get(conn.roomCode)
      const note = await createNotification(db, {
        userId: target.user.id,
        kind: 'match_invite',
        body: `${conn.user.username} invited you to a match`,
        payload: { roomCode: room.code, mode: room.mode, minutes: room.minutes, others: [] },
      })
      pushNote(target.user.id, note)
      return
    }
    if (msg.t === 'club-lobby') {
      const user = await getUserById(db, conn.user.id)
      if (!user?.club_id || !await membership(db, user.id, user.club_id)) return
      const room = [...rooms.values()].find((r) => r.clubId === user.club_id && !r.versus && !r.started)
      if (!room) return
      if (room.players.some((p) => p.id === user.id)) {
        conn.roomCode = room.code
        sendRoom(room)
        return
      }
      if (room.players.length >= MODES[room.mode].players) return
      leaveQueue(conn)
      leaveRoom(conn)
      room.players.push({ ...(await fresh(user.id)), wantGoalie: false, ready: false })
      conn.roomCode = room.code
      sendRoom(room)
      return
    }
    if (msg.t === 'in') {
      if (!conn.matchId) return
      const live = matches.get(conn.matchId)
      if (!live) return
      setInput(live.match, conn.user.id, msg)
      return
    }
    if (msg.t === 'hook-score' && process.env.ALLOW_TEST_HOOKS === '1' && conn.matchId) {
      const live = matches.get(conn.matchId)
      if (!live || live.done) return
      const match = live.match
      const me = match.players.find((p) => p.id === String(conn.user.id))
      if (!me) return
      match.phase = 'play'
      const sign = me.team === 'A' ? 1 : -1
      const hl = match.length / 2
      match.ball.owner = null
      match.ball.x = 0
      match.ball.y = 0.08
      match.ball.z = sign * (hl - 0.03)
      match.ball.vx = 0
      match.ball.vy = 0
      match.ball.vz = sign * 8
      match.ball.lastTouch = { id: me.id, team: me.team, t: match.elapsed }
      if (msg.assist) {
        const mate = match.players.find((p) => p.team === me.team && p.id !== me.id)
        if (mate) match.ball.lastPass = { id: mate.id, team: mate.team, t: match.elapsed }
      }
      step(match, 1 / 30)
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
      queueAt: prev?.queueAt || null,
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
    void ensureClubParty(conn)
    ws.on('message', (buf) => {
      let msg
      try { msg = JSON.parse(String(buf)) } catch { return }
      onMessage(conn, msg).catch((err) => {
        console.error(err)
        fail(conn, 'Something went wrong.')
      })
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

  async function openChallenge({ fromClub, toClub, ownerId, mode, minutes, goalies }) {
    let code = randomCode()
    for (let i = 0; i < 8 && rooms.has(code); i++) code = randomCode()
    const owner = await fresh(ownerId)
    const room = {
      code,
      mode,
      minutes,
      hostId: ownerId,
      clubId: fromClub.id,
      clubName: fromClub.name,
      clubLogo: fromClub.logo || null,
      awayClubId: toClub.id,
      awayName: toClub.name,
      awayLogo: toClub.logo || null,
      practice: false,
      goalies: useGoalies(mode, goalies),
      versus: true,
      players: [{ ...owner, wantGoalie: false, ready: true, side: 'A' }],
      invites: [],
      started: false,
    }
    rooms.set(code, room)
    const conn = online.get(ownerId)
    if (conn && !conn.matchId) {
      leaveQueue(conn)
      leaveRoom(conn)
      conn.roomCode = code
      sendRoom(room)
    }
    return room
  }

  return { attach, tick, pushNote, online, rooms, openChallenge }
}
