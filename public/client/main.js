import { createWorld, graphicsIsLow } from './world.js'
import { badgeDataUrl, mountLogoStudio, safeLogo } from './logo.js'
import { playGoal, playKick, playQuack, playWhistle, unlockAudio } from './audio.js'
import { cameraMove, rankFor } from '/shared/game.js'

const app = document.getElementById('app')
const matchEl = document.getElementById('match')
const stage = document.getElementById('stage')
const helpEl = document.getElementById('help')
const banner = document.getElementById('banner')
const pad = document.getElementById('pad')

const state = {
  me: null,
  screen: 'loading',
  error: '',
  club: null,
  notes: [],
  directory: { q: '', players: [], total: 0, status: '' },
  profile: null,
  room: null,
  queue: null,
  match: null,
  snap: null,
  result: null,
  you: null,
  pendingNote: null,
  color: '#ff6a1a',
  mode: '1v1',
  minutes: 3,
  clubOnly: false,
  practice: false,
  difficulty: 'medium',
  botGoalie: false,
  goalies: true,
  owned: [],
  joined: [],
  ranks: null,
  toast: '',
}

const COLORS = ['#ff6a1a', '#2f8cff', '#7bd15c', '#c084fc', '#ffb000', '#1c2430']
const input = { mx: 0, mz: 0, sprint: false, kick: 0, pass: 0, slide: 0, spin: 0, dive: 0, emote: 0, emoteName: 'spin' }
const keys = new Set()
let ws
let world
let camYaw = 0
let joy = { x: 0, y: 0, active: false }
let sent = ''
const seenNotes = new Set()
const outbox = []

function hexOk(value) {
  return /^#[0-9a-f]{6}$/i.test(value || '')
}

async function api(url, body, method) {
  const res = await fetch(url, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = {}
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { error: text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) }
    }
  }
  if (!res.ok) {
    const message = data && typeof data.error === 'string' && data.error
      ? data.error
      : (res.statusText || 'Something went wrong.')
    throw new Error(message)
  }
  return data
}

function toast(text) {
  state.toast = text
  const node = document.createElement('div')
  node.className = 'toast'
  node.textContent = text
  document.body.append(node)
  setTimeout(() => node.remove(), 2200)
}

function connect() {
  if (!state.me) return
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const socket = new WebSocket(`${proto}://${location.host}`)
  ws = socket
  socket.addEventListener('open', () => {
    if (ws !== socket) return
    while (outbox.length) socket.send(JSON.stringify(outbox.shift()))
  })
  socket.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    onNet(msg)
  })
  socket.addEventListener('close', () => {
    if (ws === socket && state.me) setTimeout(connect, 1200)
  })
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg))
  else {
    outbox.push(msg)
    if (outbox.length > 20) outbox.shift()
  }
}

function onNet(msg) {
  if (msg.t === 'error') {
    state.error = msg.message
    toast(msg.message)
    if (state.screen === 'lobby') render()
    return
  }
  if (msg.t === 'queue') {
    state.queue = msg.need ? msg : null
    state.room = null
    if (state.screen === 'lobby' || state.screen === 'home') {
      if (msg.need) state.screen = 'lobby'
      render()
    }
    return
  }
  if (msg.t === 'chat') {
    pushMatchChat(msg.name, msg.text)
    return
  }
  if (msg.t === 'room') {
    state.room = msg
    state.queue = null
    const stay = state.screen === 'club' && msg.clubId && !msg.versus
    if (!stay) state.screen = 'lobby'
    state.error = ''
    if (state.pendingNote) {
      const note = state.pendingNote
      state.pendingNote = null
      api(`/api/notifications/${note.id}/respond`, { action: 'accept' }).then(refreshNotes).catch(() => {})
    }
    render()
    return
  }
  if (msg.t === 'left') {
    state.room = null
    state.queue = null
    state.screen = 'home'
    render()
    return
  }
  if (msg.t === 'note') {
    incomingNote(msg.note)
    return
  }
  if (msg.t === 'start') {
    if (state.screen === 'match') {
      if (msg.snap && state.snap) state.snap = mergeSnap(state.snap, msg.snap)
      else if (msg.snap) state.snap = msg.snap
      if (state.snap) {
        world?.pushSnap(state.snap, currentStick())
        updateHud(state.snap)
      }
      return
    }
    state.pendingStart = msg
    state.pickerFor = msg.snap?.id || state.pickerFor || ''
    const overlay = document.getElementById('scheme-picker')
    if (overlay && !overlay.classList.contains('hidden')) return
    showSchemePicker()
    return
  }
  if (msg.t === 'snap') {
    const base = state.snap || state.pendingStart?.snap
    if (base && msg.lite) msg = mergeSnap(base, msg)
    if (state.pendingStart) state.pendingStart.snap = msg
    state.snap = msg
    if (state.screen === 'match') {
      world.pushSnap(msg, currentStick())
      updateHud(msg)
      const me = msg.players.find((p) => p.id === String(state.me.id))
      if (me) camYaw = me.yaw
    }
    return
  }
  if (msg.t === 'events') {
    for (const event of msg.events || []) {
      if (event.type === 'goal') {
        playGoal()
        world.celebrate({ x: state.snap?.ball?.x || 0, z: state.snap?.ball?.z || 0 })
      } else if (event.type === 'play' || event.type === 'kickoff') playWhistle()
      else if (event.type === 'steal') toast(`${event.by} stole the ball`)
      else if (event.type === 'dodge') toast(`${event.carrier} spun past the tackle`)
      else if (event.type === 'whiff' && event.by === state.me.username) toast('Slide missed — stunned')
    }
    return
  }
  if (msg.t === 'end') {
    state.result = msg
    state.matchId = null
    state.screen = 'results'
    hideMatch()
    refreshMe()
    render()
  }
}

function incomingNote(note) {
  if (!note) return
  state.notes = [note, ...state.notes.filter((item) => item.id !== note.id)]
  if (!seenNotes.has(note.id) && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    seenNotes.add(note.id)
    new Notification('Microduck League', { body: note.body })
  }
  if (state.screen === 'home' || state.screen === 'lobby') render()
  else toast(note.body)
}

function applyClubs(data) {
  if (!data) return
  if ('club' in data) state.club = data.club
  if (data.owned) state.owned = data.owned
  if (data.joined) state.joined = data.joined
}

async function refreshMe() {
  const data = await api('/api/me')
  state.me = data.user
  if (state.me) {
    applyClubs(await api('/api/clubs/mine'))
  } else {
    state.club = null
    state.owned = []
    state.joined = []
  }
}

async function refreshNotes() {
  if (!state.me) return
  const data = await api('/api/notifications')
  state.notes = data.notifications
}

function logoFor(src, letter, color) {
  return safeLogo(src) || badgeDataUrl(letter, color)
}

function render() {
  document.body.classList.toggle('playing', state.screen === 'match')
  if (state.screen === 'match') {
    app.replaceChildren()
    return
  }
  app.replaceChildren(shell())
  const slot = document.getElementById('hero-slot')
  if (slot) {
    stage.className = 'stage-hero'
    slot.appendChild(stage)
    world?.resize()
  }
}

function shell() {
  const root = document.createElement('div')
  root.append(topbar())
  if (state.screen === 'loading') root.append(card(p('Loading the pitch…')))
  else if (!state.me) root.append(authCard())
  else if (state.screen === 'directory') root.append(directoryCard())
  else if (state.screen === 'friends') root.append(friendsCard())
  else if (state.screen === 'report') root.append(reportCard())
  else if (state.screen === 'club') root.append(clubCard())
  else if (state.screen === 'ranks') root.append(ranksCard())
  else if (state.screen === 'lobby') root.append(lobbyCard())
  else if (state.screen === 'results') root.append(resultsCard())
  else root.append(homeCard())
  root.append(footer())
  return root
}

function topbar() {
  const bar = document.createElement('div')
  bar.className = 'top'
  const brand = document.createElement('button')
  brand.className = 'brand'
  brand.type = 'button'
  const mark = document.createElement('span')
  mark.className = 'mark'
  mark.textContent = '🦆'
  const words = document.createElement('span')
  const title = document.createElement('b')
  title.textContent = 'Microduck League'
  const sub = document.createElement('small')
  sub.textContent = 'Futsal for tiny robots'
  words.append(title, sub)
  brand.append(mark, words)
  brand.addEventListener('click', () => { state.screen = state.me ? 'home' : 'auth'; render() })
  bar.append(brand)
  if (state.me) {
    const right = document.createElement('div')
    right.className = 'actions'
    const rank = document.createElement('span')
    rank.className = 'pill'
    rank.textContent = `${state.me.rank} · ${state.me.rating}`
    const out = document.createElement('button')
    out.className = 'ghost'
    out.type = 'button'
    out.textContent = 'Log out'
    out.addEventListener('click', logout)
    right.append(rank, out)
    bar.append(right)
  }
  return bar
}

function card(...nodes) {
  const node = document.createElement('section')
  node.className = 'card'
  node.append(...nodes)
  return node
}

function p(text, className) {
  const node = document.createElement('p')
  if (className) node.className = className
  node.textContent = text
  return node
}

function h(tag, text) {
  const node = document.createElement(tag)
  node.textContent = text
  return node
}

function footer() {
  const node = document.createElement('p')
  node.className = 'footer'
  node.append('Robot model: Microduck by ')
  const a = document.createElement('a')
  a.href = 'https://github.com/pollen-robotics/microduck_rl'
  a.textContent = 'Pollen Robotics'
  a.target = '_blank'
  a.rel = 'noreferrer'
  node.append(a, '. Meshes are CC BY-NC-SA 4.0, simplified and recolored for this non-commercial fan game. ')
  const lic = document.createElement('a')
  lic.href = 'https://creativecommons.org/licenses/by-nc-sa/4.0/'
  lic.textContent = 'License'
  lic.target = '_blank'
  lic.rel = 'noreferrer'
  node.append(lic, '.')
  return node
}

function authCard() {
  const box = card()
  box.append(h('h2', state.screen === 'signup' ? 'Make a player' : 'Welcome back'))
  box.append(p(state.screen === 'signup'
    ? 'Pick a username and a password. No email. This stays on the league server as a scrambled password, never the original.'
    : 'Log in with the username you play under. Same Wi-Fi? Your friends can open this same address.'))
  const slot = document.createElement('div')
  slot.id = 'hero-slot'
  box.append(slot)
  const form = document.createElement('form')
  const user = field('Username', 'text', 'username')
  const pass = field('Password', 'password', 'current-password')
  form.append(user.label, user.input, pass.label, pass.input)
  if (state.screen === 'signup') {
    form.append(h('label', 'Duck color'))
    form.append(colorRow())
  }
  const err = p(state.error, 'error')
  const submit = document.createElement('button')
  submit.className = 'primary'
  submit.type = 'submit'
  submit.textContent = state.screen === 'signup' ? 'Create player' : 'Log in'
  const swap = document.createElement('button')
  swap.type = 'button'
  swap.className = 'ghost'
  swap.textContent = state.screen === 'signup' ? 'I already play' : 'New player'
  swap.addEventListener('click', () => {
    state.screen = state.screen === 'signup' ? 'auth' : 'signup'
    state.error = ''
    render()
  })
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    state.error = ''
    try {
      const path = state.screen === 'signup' ? '/api/signup' : '/api/login'
      const data = await api(path, { username: user.input.value, password: pass.input.value, color: state.color })
      state.me = data.user
      state.screen = 'home'
      await refreshNotes()
      connect()
      render()
    } catch (err) {
      state.error = err.message
      render()
    }
  })
  const row = document.createElement('div')
  row.className = 'actions'
  row.append(submit, swap)
  form.append(err, row)
  box.append(form)
  return box
}

function field(label, type, auto) {
  const lab = document.createElement('label')
  lab.textContent = label
  const inputEl = document.createElement('input')
  inputEl.type = type
  inputEl.required = true
  inputEl.maxLength = type === 'password' ? 72 : 16
  inputEl.autocomplete = auto
  return { label: lab, input: inputEl }
}

function colorRow() {
  const row = document.createElement('div')
  row.className = 'swatches'
  for (const color of COLORS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `swatch${color === state.color ? ' on' : ''}`
    b.style.background = color
    b.addEventListener('click', () => { state.color = color; render() })
    row.append(b)
  }
  return row
}

function homeCard() {
  const wrap = document.createElement('div')
  wrap.className = 'layout'
  const hero = card()
  hero.append(h('h2', `Hey ${state.me.username}`))
  hero.append(p('Play a whole match against computer ducks, queue ranked, or open a private room for your club. The ball sticks when you take it. Slide to steal it. Spin to slip a tackle.'))
  const slot = document.createElement('div')
  slot.id = 'hero-slot'
  const actions = document.createElement('div')
  actions.className = 'actions home-actions'
  actions.append(
    button('Quick Match', 'primary big', () => {
      state.screen = 'lobby'
      state.error = ''
      render()
      send({ t: 'quick', mode: '2v2', minutes: 3, goalies: true })
    }),
    button('Play vs bots', 'ghost', () => { state.screen = 'lobby'; state.error = ''; render() }),
    button('Club', 'ghost', () => { state.screen = 'club'; state.askedClub = 0; render() }),
    button('Friends', 'ghost', () => { state.screen = 'friends'; loadFriends(); render() }),
    button('Ranks', 'ghost', () => { state.screen = 'ranks'; loadRanks(); render() }),
    button('Find players', 'ghost', () => { state.screen = 'directory'; loadDirectory(); render() }),
    button('Report', 'ghost', () => { state.screen = 'report'; loadReportNames(); render() }),
    button('Controls', 'ghost', () => openHelp(hero)),
  )
  hero.append(slot, actions)
  const season = card()
  season.append(h('h3', state.me.rank))
  season.append(p(`${state.me.rating} rating`, 'muted'))
  const stats = document.createElement('div')
  stats.className = 'stats'
  for (const [n, label] of [
    [state.me.matches, 'Played'],
    [state.me.wins, 'Wins'],
    [state.me.losses, 'Losses'],
    [state.me.goals, 'Goals'],
    [state.me.assists, 'Assists'],
    [state.me.draws, 'Draws'],
  ]) stats.append(stat(n, label))
  season.append(stats)
  const club = card()
  club.append(h('h3', 'Club'))
  if (state.club) {
    const row = document.createElement('div')
    row.className = 'member'
    row.append(logoImg(state.club.logo, state.club.name, '#ff6a1a'))
    const text = document.createElement('div')
    text.className = 'grow'
    const name = document.createElement('b')
    name.textContent = state.club.name
    text.append(name, p(`Code ${state.club.code} · ${state.club.members.length} players`, 'muted'))
    row.append(text)
    club.append(row)
  } else club.append(p('No club yet. Make one and invite friends from the directory.'))
  club.append(button(state.club ? 'Open club' : 'Create a club', 'ghost', () => { state.screen = 'club'; render() }))
  const notes = card()
  notes.append(h('h3', 'Invites'))
  notes.append(alertsButton())
  if (!state.notes.length) notes.append(p('No invites waiting.', 'muted'))
  for (const note of state.notes) notes.append(noteCard(note))
  wrap.append(hero, season, club, notes)
  return wrap
}

function stat(n, label) {
  const node = document.createElement('div')
  node.className = 'stat'
  const b = document.createElement('b')
  b.textContent = String(n)
  const s = document.createElement('span')
  s.textContent = label
  node.append(b, s)
  return node
}

function button(text, className, onClick) {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = className
  node.textContent = text
  node.addEventListener('click', onClick)
  return node
}

function alertsButton() {
  if (typeof Notification === 'undefined') return p('This browser does not show desktop alerts. Invites still appear here.', 'muted')
  if (Notification.permission === 'granted') return p('Match alerts are on while this page is open.', 'muted')
  return button('Allow match alerts', 'ghost', async () => {
    const result = await Notification.requestPermission()
    toast(result === 'granted' ? 'Alerts on' : 'Alerts stayed off')
    render()
  })
}

function noteCard(note) {
  const node = document.createElement('article')
  node.className = 'note'
  const text = document.createElement('div')
  text.className = 'grow'
  const body = document.createElement('b')
  body.textContent = note.body
  text.append(body)
  const others = note.payload?.others || []
  const extra = document.createElement('div')
  extra.className = 'muted'
  if (note.kind === 'match_invite') {
    extra.textContent = others.length
      ? `Also invited: ${others.join(', ')}. ${note.payload.mode} · ${note.payload.minutes} min.`
      : `You are the only one invited this round. ${note.payload.mode} · ${note.payload.minutes} min.`
  } else if (note.kind === 'club_challenge') {
    extra.textContent = 'Club challenge. Accept to open the match, or decline.'
  } else if (note.kind === 'club_match') {
    extra.textContent = `${note.payload.mode} · ${note.payload.minutes} min. Accept to join the room.`
  } else if (note.kind === 'club_challenge_result') {
    extra.textContent = 'Challenge update'
  } else if (note.kind === 'friend_request') {
    extra.textContent = 'Friend request. Accept to add them to your friends list.'
  } else extra.textContent = 'Club invite'
  text.append(extra)
  const actions = document.createElement('div')
  actions.append(
    button('Accept', 'primary', () => acceptNote(note)),
    button('Decline', 'ghost', () => declineNote(note)),
  )
  node.append(text, actions)
  return node
}

async function acceptNote(note) {
  if (note.kind === 'match_invite' || note.kind === 'club_match') {
    if (note.kind === 'match_invite') state.pendingNote = note
    else api(`/api/notifications/${note.id}/respond`, { action: 'accept' }).then(refreshNotes).catch(() => {})
    state.screen = 'lobby'
    render()
    send({ t: 'join', code: note.payload.roomCode })
    return
  }
  try {
    const data = await api(`/api/notifications/${note.id}/respond`, { action: 'accept' })
    state.me = data.user
    applyClubs(data)
    await refreshMe()
    await refreshNotes()
    if (data.roomCode) {
      state.screen = 'lobby'
      render()
      send({ t: 'join', code: data.roomCode })
      return
    }
    render()
  } catch (err) {
    toast(err.message)
  }
}

async function declineNote(note) {
  await api(`/api/notifications/${note.id}/respond`, { action: 'decline' })
  await refreshNotes()
  render()
}

function directoryCard() {
  const box = card()
  box.classList.add('span-2')
  box.append(h('h2', 'Player directory'))
  box.append(p('Search the server by username. You can see rank, stats, and club. Passwords stay hidden.'))
  const search = document.createElement('input')
  search.type = 'search'
  search.placeholder = 'Find a friend'
  search.value = state.directory.q
  search.addEventListener('input', () => {
    state.directory.q = search.value
    loadDirectory()
  })
  box.append(search, p(state.directory.status, 'muted'))
  const list = document.createElement('div')
  list.className = 'list'
  if (!state.directory.players.length && state.directory.status !== 'loading') {
    list.append(p(state.directory.q ? 'No ducks with that name.' : 'No players yet.', 'muted'))
  }
  for (const player of state.directory.players) list.append(personButton(player))
  box.append(list)
  if (state.profile) box.append(profilePanel(state.profile))
  return box
}

let directoryTimer
function loadDirectory() {
  clearTimeout(directoryTimer)
  state.directory.status = 'loading'
  directoryTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/players?q=${encodeURIComponent(state.directory.q)}`)
      state.directory.players = data.players
      state.directory.total = data.total
      state.directory.status = `${data.total} player${data.total === 1 ? '' : 's'}`
    } catch (err) {
      state.directory.status = err.message
    }
    if (state.screen === 'directory') {
      const focused = document.activeElement?.matches?.('input[type="search"]')
      const caret = focused ? document.activeElement.selectionStart : null
      render()
      if (focused) {
        const box = document.querySelector('input[type="search"]')
        if (box) {
          box.focus()
          if (caret != null) box.setSelectionRange(caret, caret)
        }
      }
    }
  }, 220)
}

function personButton(player) {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = 'person'
  node.append(logoImg(player.club?.logo, player.username, player.color))
  const text = document.createElement('div')
  text.className = 'grow'
  const name = document.createElement('b')
  name.textContent = player.username
  const meta = document.createElement('div')
  meta.className = 'muted'
  meta.textContent = `${player.rank} · ${player.rating} · ${player.goals} goals · ${player.club ? player.club.name : 'No club'}`
  text.append(name, meta)
  node.append(text)
  node.addEventListener('click', async () => {
    const data = await api(`/api/players/${encodeURIComponent(player.username)}`)
    state.profile = data.player
    render()
  })
  return node
}

function profilePanel(player) {
  const box = document.createElement('div')
  box.className = 'card'
  box.append(h('h3', player.username))
  box.append(p(`${player.rank} · ${player.rating}`))
  const stats = document.createElement('div')
  stats.className = 'stats'
  for (const [n, label] of [[player.goals, 'Goals'], [player.assists, 'Assists'], [player.wins, 'Wins'], [player.losses, 'Losses'], [player.matches, 'Played']]) {
    stats.append(stat(n, label))
  }
  box.append(stats)
  if (player.club) {
    const row = document.createElement('div')
    row.className = 'member'
    row.append(logoImg(player.club.logo, player.club.name, '#ff6a1a'))
    const name = document.createElement('b')
    name.textContent = player.club.name
    row.append(name)
    box.append(row)
  }
  if (player.id !== state.me.id) {
    box.append(button('Add friend', 'ghost', async () => {
      try {
        await api('/api/friends', { username: player.username })
        toast(`Asked ${player.username}`)
      } catch (err) { toast(err.message) }
    }))
  }
  if (state.club && state.club.ownerId === state.me.id && player.id !== state.me.id) {
    box.append(button(`Invite to ${state.club.name}`, 'primary', async () => {
      try {
        await api('/api/clubs/invites', { username: player.username })
        toast(`Invited ${player.username}`)
      } catch (err) { toast(err.message) }
    }))
  }
  return box
}

function logoImg(src, name, color) {
  const img = document.createElement('img')
  img.className = 'logo'
  img.alt = ''
  img.src = logoFor(src, name, hexOk(color) ? color : '#ff6a1a')
  return img
}

function clubList(title, rows, empty) {
  const block = document.createElement('div')
  block.append(h('h3', title))
  if (!rows.length) {
    block.append(p(empty, 'muted'))
    return block
  }
  const list = document.createElement('div')
  list.className = 'list'
  for (const club of rows) {
    const row = document.createElement('div')
    row.className = `member${state.club && state.club.id === club.id ? ' you' : ''}`
    row.append(logoImg(club.logo, club.name, '#ff6a1a'))
    const info = document.createElement('div')
    info.className = 'grow'
    const name = document.createElement('b')
    name.textContent = club.name
    const meta = document.createElement('div')
    meta.className = 'muted'
    meta.textContent = state.club && state.club.id === club.id ? 'Active club' : club.role === 'owner' ? 'You own this' : 'Joined'
    info.append(name, meta)
    const actions = document.createElement('div')
    actions.className = 'actions'
    if (!state.club || state.club.id !== club.id) {
      actions.append(button('Switch', 'ghost', async () => {
        try {
          applyClubs(await api('/api/clubs/active', { id: club.id }))
          await refreshMe()
          render()
        } catch (err) { toast(err.message) }
      }))
    }
    actions.append(button('Leave', 'danger', async () => {
      try {
        applyClubs(await api('/api/clubs/leave', { clubId: club.id }))
        await refreshMe()
        render()
      } catch (err) { toast(err.message) }
    }))
    row.append(info, actions)
    list.append(row)
  }
  block.append(list)
  return block
}

function clubCard() {
  const box = card()
  box.append(h('h2', 'Clubs'))
  box.append(p('You can own up to 8 clubs and join as many as you like. The active club is the one invites, the logo, and club matches use.'))
  box.append(clubList('Clubs I own', state.owned, 'You do not own a club yet.'))
  box.append(clubList('Clubs I’ve joined', state.joined, 'You have not joined a club yet.'))
  if (state.owned.length < 8) {
    const name = document.createElement('input')
    name.maxLength = 24
    name.placeholder = 'New club name'
    const code = document.createElement('input')
    code.maxLength = 8
    code.placeholder = 'Join with a code'
    const err = p(state.error, 'error')
    box.append(h('h3', state.owned.length ? 'Add another club' : 'Start a club'), name, button('Create club', 'primary', async () => {
      try {
        await api('/api/clubs', { name: name.value })
        await refreshMe()
        state.error = ''
        render()
      } catch (err) { state.error = err.message; render() }
    }), code, button('Join with code', 'ghost', async () => {
      try {
        await api('/api/clubs/join', { code: code.value })
        await refreshMe()
        state.error = ''
        render()
      } catch (err) { state.error = err.message; render() }
    }), err)
  }
  if (!state.club) return box
  const head = document.createElement('div')
  head.className = 'member you'
  head.append(logoImg(state.club.logo, state.club.name, '#ff6a1a'))
  const text = document.createElement('div')
  const title = document.createElement('h2')
  title.textContent = state.club.name
  text.append(title, p(`Active · code ${state.club.code} · led by ${state.club.owner}`))
  head.append(text)
  box.append(head)
  const totals = document.createElement('div')
  totals.className = 'stats'
  const record = state.club.record || { wins: 0, goalsFor: 0, goalsAgainst: 0 }
  totals.append(
    stat(state.club.totals.goals, 'Goals'),
    stat(state.club.totals.wins, 'Player wins'),
    stat(record.wins, 'Club wins'),
    stat((record.goalsFor || 0) - (record.goalsAgainst || 0), 'Goal diff'),
  )
  box.append(totals, h('h3', 'Players'))
  const list = document.createElement('div')
  list.className = 'list'
  state.club.members.forEach((member, index) => {
    const row = document.createElement('div')
    row.className = 'member'
    const place = document.createElement('b')
    place.textContent = String(index + 1)
    const info = document.createElement('div')
    info.className = 'grow'
    const name = document.createElement('b')
    name.textContent = member.username
    const meta = document.createElement('div')
    meta.className = 'muted'
    meta.textContent = `${member.rank} · ${member.rating} · ${member.goals}G ${member.assists}A · ${member.wins}-${member.losses}`
    info.append(name, meta)
    row.append(place, info)
    list.append(row)
  })
  box.append(list)
  if (state.club.ownerId === state.me.id) {
    box.append(h('h3', 'Add a player'))
    const who = document.createElement('input')
    who.maxLength = 16
    who.placeholder = 'Their username'
    who.autocomplete = 'off'
    box.append(who, button('Invite', 'primary', async () => {
      try {
        await api('/api/clubs/invites', { username: who.value })
        who.value = ''
        toast('Invite sent. They accept it from Home.')
      } catch (err) { toast(err.message) }
    }))
  }
  if (state.club.ownerId === state.me.id) {
    box.append(h('h3', 'Club logo'))
    const studio = document.createElement('div')
    box.append(studio)
    mountLogoStudio(studio, {
      initial: state.club.logo,
      onSave: async (logo) => {
        try {
          const data = await api('/api/clubs/logo', { logo })
          state.club = data.club
          toast('Logo saved')
          render()
        } catch (err) { toast(err.message) }
      },
    })
  }
  box.append(h('h3', 'Club match'))
  if (state.club && state.askedClub !== state.club.id) {
    state.askedClub = state.club.id
    send({ t: 'club-lobby' })
  }
  if (state.room && state.room.clubId === state.club.id && !state.room.versus) {
    box.append(roomCard(card()))
  } else {
    box.append(p('Pick a mode and length, open the match, ready up, then Start. Empty spots fill with practice ducks so the match can begin.'))
    const modes = document.createElement('div')
    modes.className = 'modes'
    for (const mode of ['1v1', '2v2', '3v3']) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `mode${state.mode === mode ? ' on' : ''}`
      b.textContent = mode
      b.addEventListener('click', () => { state.mode = mode; render() })
      modes.append(b)
    }
    const minutes = document.createElement('div')
    minutes.className = 'modes'
    for (const value of [3, 5]) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `minute${state.minutes === value ? ' on' : ''}`
      b.textContent = `${value} min`
      b.addEventListener('click', () => { state.minutes = value; render() })
      minutes.append(b)
    }
    box.append(modes, minutes)
    box.append(button('Open club match', 'primary', () => {
      send({
        t: 'host',
        mode: state.mode,
        minutes: state.minutes,
        clubOnly: true,
        practice: true,
        goalies: state.mode === '3v3' && state.goalies !== false,
      })
    }))
  }
  if (state.club.ownerId === state.me.id) {
    box.append(h('h3', 'Challenge another club'))
    const opponent = document.createElement('input')
    opponent.maxLength = 24
    opponent.placeholder = 'Their club name'
    box.append(opponent, p(`Sends a ${state.mode} · ${state.minutes} min${state.mode === '3v3' ? (state.goalies ? ' · goalies' : ' · no goalies') : ''} challenge. Set that in Match first.`, 'muted'))
    box.append(button('Send challenge', 'primary', async () => {
      try {
        await api('/api/clubs/challenge', {
          name: opponent.value,
          mode: state.mode,
          minutes: state.minutes,
          goalies: state.mode === '3v3' && state.goalies !== false,
        })
        toast('Challenge sent')
      } catch (err) { toast(err.message) }
    }))
  }
  return box
}

async function loadFriends() {
  state.friends = { status: 'loading', list: state.friends?.list || [] }
  try {
    const data = await api('/api/friends')
    state.friends = { status: '', list: data.friends, q: state.friends?.q || '' }
  } catch (err) {
    state.friends = { status: err.message, list: [], q: '' }
  }
  if (state.screen === 'friends') render()
}

function friendsCard() {
  const box = card()
  box.append(h('h2', 'Friends'))
  box.append(p('Sorted by who you played with most recently. Search to filter.'))
  const search = document.createElement('input')
  search.type = 'search'
  search.placeholder = 'Search friends'
  search.value = state.friends?.q || ''
  search.addEventListener('input', () => {
    state.friends = { ...(state.friends || { list: [] }), q: search.value }
    const list = document.getElementById('friend-list')
    if (list) paintFriends(list)
  })
  const list = document.createElement('div')
  list.id = 'friend-list'
  list.className = 'list'
  box.append(search)
  if (!state.friends || state.friends.status === 'loading') box.append(p('Loading friends…', 'muted'))
  else if (state.friends.status) box.append(p(state.friends.status, 'error'))
  paintFriends(list)
  box.append(list)
  return box
}

function paintFriends(list) {
  list.replaceChildren()
  const q = (state.friends?.q || '').trim().toLowerCase()
  const rows = (state.friends?.list || []).filter((f) => !q || f.username.toLowerCase().includes(q))
  if (!rows.length) {
    list.append(p(q ? 'No friend with that name.' : 'No friends yet. Add one from Find players.', 'muted'))
    return
  }
  for (const friend of rows) {
    const row = document.createElement('div')
    row.className = 'member'
    const name = document.createElement('b')
    name.textContent = friend.username
    const meta = document.createElement('span')
    meta.className = 'muted'
    const when = friend.lastPlayed ? `Played ${friend.lastPlayed.slice(0, 16).replace('T', ' ')}` : 'No match together yet'
    meta.textContent = `${friend.online ? 'Online' : 'Offline'} · ${when}`
    row.append(name, meta, button('Remove', 'ghost', async () => {
      try {
        await api('/api/friends/remove', { id: friend.id })
        await loadFriends()
      } catch (err) { toast(err.message) }
    }))
    list.append(row)
  }
}

async function loadReportNames() {
  state.reportNames = []
  try {
    const data = await api('/api/reports/names')
    state.reportNames = data.names || []
  } catch { state.reportNames = [] }
  if (state.screen === 'report') render()
}

function reportCard() {
  const box = card()
  box.append(h('h2', 'Report'))
  box.append(p('Report a player from a recent match, or tell us about a map problem.'))
  const names = state.reportNames || []
  const pick = document.createElement('select')
  const blank = document.createElement('option')
  blank.value = ''
  blank.textContent = names.length ? 'Player from a recent match' : 'No recent opponents yet'
  pick.append(blank)
  for (const name of names) {
    const opt = document.createElement('option')
    opt.value = name
    opt.textContent = name
    pick.append(opt)
  }
  const reason = document.createElement('select')
  for (const label of ['Unsportsmanlike', 'Cheating', 'Harassment', 'Other']) {
    const opt = document.createElement('option')
    opt.value = label
    opt.textContent = label
    reason.append(opt)
  }
  const note = document.createElement('textarea')
  note.maxLength = 80
  note.placeholder = 'What happened?'
  const mapNote = document.createElement('textarea')
  mapNote.maxLength = 80
  mapNote.placeholder = 'Map idea or problem'
  box.append(h('h3', 'Player'), pick, reason, note, button('Report player', 'primary', async () => {
    try {
      await api('/api/reports', { kind: 'player', targetName: pick.value, reason: reason.value, body: note.value })
      note.value = ''
      toast('Report sent')
    } catch (err) { toast(err.message) }
  }))
  box.append(h('h3', 'Map'), mapNote, button('Report map', 'ghost', async () => {
    try {
      await api('/api/reports', { kind: 'map', body: mapNote.value })
      mapNote.value = ''
      toast('Map note sent')
    } catch (err) { toast(err.message) }
  }))
  return box
}

async function loadRanks() {
  state.ranks = { status: 'loading' }
  try {
    state.ranks = await api('/api/leaderboards')
  } catch (err) {
    state.ranks = { status: err.message }
  }
  if (state.screen === 'ranks') render()
}

function rankRow(place, title, meta, mine) {
  const row = document.createElement('div')
  row.className = `member${mine ? ' you' : ''}`
  const badge = document.createElement('b')
  badge.textContent = String(place)
  const info = document.createElement('div')
  info.className = 'grow'
  const name = document.createElement('b')
  name.textContent = title
  const sub = document.createElement('div')
  sub.className = 'muted'
  sub.textContent = meta
  info.append(name, sub)
  row.append(badge, info)
  return row
}

function ranksCard() {
  const box = card()
  box.append(h('h2', 'Ranks'))
  box.append(p('Bots stay off both lists. Your row stays highlighted, even when you are outside the top 10. Club ranks use wins, then goal difference.'))
  if (!state.ranks || state.ranks.status === 'loading') {
    box.append(p('Loading ranks…', 'muted'))
    return box
  }
  if (state.ranks.status && !state.ranks.players) {
    box.append(p(state.ranks.status, 'error'))
    return box
  }
  const yours = new Set((state.ranks.yourClubs || []).map((club) => club.id))
  box.append(h('h3', 'Top clubs'))
  const clubs = document.createElement('div')
  clubs.className = 'list'
  const clubRows = state.ranks.clubs || []
  if (!clubRows.length) clubs.append(p('No clubs yet.', 'muted'))
  for (const club of clubRows) {
    clubs.append(rankRow(
      club.rank,
      club.name,
      `${club.points} pts · ${club.wins}-${club.draws}-${club.losses} · GD ${club.goalDifference}`,
      yours.has(club.id),
    ))
  }
  box.append(clubs)
  const outside = (state.ranks.yourClubs || []).filter((club) => !clubRows.some((row) => row.id === club.id))
  if (outside.length) {
    box.append(h('h3', 'Your clubs'))
    const mine = document.createElement('div')
    mine.className = 'list'
    for (const club of outside) {
      mine.append(rankRow(club.rank, club.name, `${club.points} pts · GD ${club.goalDifference}`, true))
    }
    box.append(mine)
  }
  box.append(h('h3', 'Top players'))
  const players = document.createElement('div')
  players.className = 'list'
  const playerRows = state.ranks.players || []
  if (!playerRows.length) players.append(p('No players yet.', 'muted'))
  const youInList = playerRows.some((row) => row.id === state.me.id)
  for (const player of playerRows) {
    players.append(rankRow(
      player.rank,
      player.username,
      `${player.rating} · ${player.goals} goals · ${player.wins} wins`,
      player.id === state.me.id,
    ))
  }
  if (state.ranks.you && !youInList) {
    const you = state.ranks.you
    players.append(rankRow(you.rank, `${you.username} (you)`, `${you.rating} · ${you.goals} goals · ${you.wins} wins`, true))
  }
  box.append(players)
  return box
}

function lobbyCard() {
  const box = card()
  box.append(h('h2', 'Match'))
  if (state.queue) {
    const keeper = state.queue.mode === '3v3' ? (state.queue.goalies === false ? ' · no goalies' : ' · goalies') : ''
    const kind = state.queue.quick ? 'Quick match' : 'Ranked queue'
    box.append(p(`${kind}: ${state.queue.mode} · ${state.queue.minutes} min${keeper}. ${state.queue.count}/${state.queue.need} ducks.`))
    if (state.queue.quick) box.append(p('If the queue is still short, practice ducks fill in and the match starts.', 'muted'))
    box.append(button('Leave queue', 'ghost', () => send({ t: 'leave-queue' })))
    return box
  }
  if (state.room) return roomCard(box)
  box.append(p('Play vs Bots fills both teams with computer ducks and does not change your rating. Ranked queue matches people by rating. A private room can be a club match with invites.'))
  box.append(h('h3', 'Mode'))
  const modes = document.createElement('div')
  modes.className = 'modes'
  for (const mode of ['1v1', '2v2', '3v3']) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `mode${state.mode === mode ? ' on' : ''}`
    b.textContent = mode
    b.addEventListener('click', () => { state.mode = mode; render() })
    modes.append(b)
  }
  const minutes = document.createElement('div')
  minutes.className = 'modes'
  for (const value of [3, 5]) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `minute${state.minutes === value ? ' on' : ''}`
    b.textContent = `${value} min`
    b.addEventListener('click', () => { state.minutes = value; render() })
    minutes.append(b)
  }
  const keepers = document.createElement('div')
  keepers.className = 'modes'
  if (state.mode === '3v3') {
    for (const [on, label] of [[true, 'Goalies'], [false, 'No goalies']]) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `minute${state.goalies !== false === on ? ' on' : ''}`
      b.textContent = label
      b.addEventListener('click', () => { state.goalies = on; render() })
      keepers.append(b)
    }
  }
  const levels = document.createElement('div')
  levels.className = 'modes'
  for (const level of ['easy', 'medium', 'hard']) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `minute${state.difficulty === level ? ' on' : ''}`
    b.textContent = level[0].toUpperCase() + level.slice(1)
    b.addEventListener('click', () => { state.difficulty = level; render() })
    levels.append(b)
  }
  const botGoalie = document.createElement('label')
  botGoalie.className = 'check'
  const botGoalieInput = document.createElement('input')
  botGoalieInput.type = 'checkbox'
  botGoalieInput.checked = state.botGoalie && state.mode === '3v3' && state.goalies !== false
  botGoalieInput.disabled = state.mode !== '3v3' || state.goalies === false
  botGoalieInput.addEventListener('change', () => { state.botGoalie = botGoalieInput.checked })
  botGoalie.append(botGoalieInput, document.createTextNode(
    state.mode !== '3v3' ? 'Goalies are only in 3v3' : state.goalies === false ? 'This 3v3 has no goalies' : 'I will play goalie against the bots',
  ))
  const club = document.createElement('label')
  club.className = 'check'
  const clubInput = document.createElement('input')
  clubInput.type = 'checkbox'
  clubInput.checked = state.clubOnly && !!state.club
  clubInput.disabled = !state.club
  clubInput.addEventListener('change', () => { state.clubOnly = clubInput.checked })
  club.append(clubInput, document.createTextNode(state.club ? `Club match for ${state.club.name}` : 'Join a club to host a club match'))
  const practice = document.createElement('label')
  practice.className = 'check'
  const practiceInput = document.createElement('input')
  practiceInput.type = 'checkbox'
  practiceInput.checked = state.practice
  practiceInput.addEventListener('change', () => { state.practice = practiceInput.checked })
  practice.append(practiceInput, document.createTextNode('Fill empty spots with practice ducks (unranked)'))
  const sensLabel = document.createElement('label')
  sensLabel.textContent = `Sensitivity ${readSens().toFixed(2)} · saved on this device`
  const sens = document.createElement('input')
  sens.type = 'range'
  sens.min = '0.4'
  sens.max = '1.3'
  sens.step = '0.05'
  sens.value = String(readSens())
  sens.addEventListener('input', () => {
    localStorage.setItem('md-sensitivity', sens.value)
    sensLabel.textContent = `Sensitivity ${readSens().toFixed(2)} · saved on this device`
  })
  const gfxLabel = document.createElement('div')
  gfxLabel.className = 'muted'
  gfxLabel.textContent = 'Graphics'
  const gfx = document.createElement('div')
  gfx.className = 'modes'
  const gfxNow = localStorage.getItem('md-graphics') === 'low' || (localStorage.getItem('md-graphics') !== 'high' && graphicsIsLow())
  for (const [id, label] of [['high', 'High'], ['low', 'Low']]) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `minute${(id === 'low') === gfxNow ? ' on' : ''}`
    b.textContent = label
    b.addEventListener('click', () => {
      localStorage.setItem('md-graphics', id)
      world?.setQuality(id === 'low')
      render()
    })
    gfx.append(b)
  }
  const err = p(state.error, 'error')
  const actions = document.createElement('div')
  actions.className = 'actions'
  actions.append(
    button('Play vs bots', 'primary', () => {
      send({
        t: 'bots',
        mode: state.mode,
        minutes: state.minutes,
        difficulty: state.difficulty,
        goalie: state.botGoalie && state.mode === '3v3' && state.goalies !== false,
        goalies: state.mode === '3v3' && state.goalies !== false,
      })
    }),
    button('Quick Match', 'primary', () => {
      send({ t: 'quick', mode: state.mode, minutes: state.minutes, goalies: state.mode === '3v3' && state.goalies !== false })
    }),
    button('Queue ranked', 'ghost', () => {
      send({ t: 'queue', mode: state.mode, minutes: state.minutes, goalies: state.mode === '3v3' && state.goalies !== false })
    }),
    button('Create room', 'ghost', () => {
      send({
        t: 'host',
        mode: state.mode,
        minutes: state.minutes,
        clubOnly: state.clubOnly && !!state.club,
        practice: state.practice,
        goalies: state.mode === '3v3' && state.goalies !== false,
      })
    }),
  )
  const join = document.createElement('input')
  join.placeholder = 'Room code'
  join.maxLength = 6
  box.append(modes, h('h3', 'Length'), minutes)
  if (state.mode === '3v3') box.append(h('h3', '3v3 goalies'), keepers)
  box.append(h('h3', 'Bot difficulty'), levels, botGoalie, club, practice, sensLabel, sens, gfxLabel, gfx, err, actions, join, button('Join code', 'ghost', () => {
    send({ t: 'join', code: join.value.trim().toUpperCase() })
  }))
  return box
}

function roomCard(box) {
  const room = state.room
  const keeper = room.mode === '3v3' ? (room.goalies === false ? ' · no goalies' : ' · goalies') : ''
  box.append(h('h2', `${room.mode} · ${room.minutes} min${keeper}`))
  if (room.versus) box.append(p(`Club vs club · ${room.clubName} vs ${room.awayName}`))
  else if (room.clubName) box.append(p(`Club match · ${room.clubName}`))
  const code = document.createElement('div')
  code.className = 'code'
  code.textContent = room.code
  const mine = room.hostId === state.me.id
  const clubRoom = !!(room.clubId || room.versus)
  box.append(code, p(
    room.versus
      ? 'Both clubs ready up. The challenging owner starts when each side is full and ready.'
      : room.practice
        ? 'Practice ducks will fill empty spots. Ranked rating stays put.'
        : clubRoom
          ? 'Pick the mode and length, ready up, then the host presses Start. Empty spots fill with practice ducks.'
          : 'Teams are balanced by rating when the host starts.',
  ))
  if (clubRoom && mine && !room.versus) {
    const modes = document.createElement('div')
    modes.className = 'modes'
    for (const mode of ['1v1', '2v2', '3v3']) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `mode${room.mode === mode ? ' on' : ''}`
      b.textContent = mode
      b.addEventListener('click', () => send({ t: 'options', mode, minutes: room.minutes, goalies: mode === '3v3' && room.goalies !== false }))
      modes.append(b)
    }
    const minutes = document.createElement('div')
    minutes.className = 'modes'
    for (const value of [3, 5]) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `minute${room.minutes === value ? ' on' : ''}`
      b.textContent = `${value} min`
      b.addEventListener('click', () => send({ t: 'options', mode: room.mode, minutes: value, goalies: room.goalies !== false }))
      minutes.append(b)
    }
    box.append(modes, minutes)
    if (room.mode === '3v3') {
      const keepers = document.createElement('div')
      keepers.className = 'modes'
      for (const [on, label] of [[true, 'Goalies'], [false, 'No goalies']]) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = `minute${(room.goalies !== false) === on ? ' on' : ''}`
        b.textContent = label
        b.addEventListener('click', () => send({ t: 'options', mode: room.mode, minutes: room.minutes, goalies: on }))
        keepers.append(b)
      }
      box.append(keepers)
    }
  }
  const list = document.createElement('div')
  list.className = 'list'
  for (const player of room.players) {
    const row = document.createElement('div')
    row.className = 'member'
    const name = document.createElement('b')
    name.textContent = `${player.name}${player.id === room.hostId ? ' · host' : ''}${player.side === 'A' ? ' · home' : ''}${player.side === 'B' ? ' · away' : ''}${player.goalie ? ' · goalie' : ''}${clubRoom && player.ready ? ' · ready' : ''}`
    const meta = document.createElement('span')
    meta.className = 'muted'
    meta.textContent = `${rankFor(player.rating)} ${player.rating}`
    row.append(name, meta)
    list.append(row)
  }
  box.append(list)
  const me = room.players.find((p) => p.id === state.me.id)
  if (room.mode === '3v3' && room.goalies !== false) {
    box.append(button(me?.goalie ? 'Goalie spot claimed' : 'I will play goalie', 'ghost', () => {
      send({ t: 'goalie', on: !me?.goalie })
    }))
  }
  if (room.clubId && mine && !room.versus) box.append(invitePicker(room))
  const actions = document.createElement('div')
  actions.className = 'actions'
  if (clubRoom && !mine) {
    actions.append(button(me?.ready ? 'Not ready' : 'Ready', 'primary', () => send({ t: 'ready' })))
  }
  if (mine) actions.append(button('Start match', 'primary', () => send({ t: 'start' })))
  actions.append(button('Leave room', 'ghost', () => send({ t: 'leave' })))
  box.append(chatBox(), p(state.error, 'error'), actions)
  return box
}

function chatBox() {
  const wrap = document.createElement('div')
  wrap.className = 'chat-box'
  const log = document.createElement('div')
  log.className = 'chat-log'
  for (const line of state.room?.chat || []) {
    const row = document.createElement('div')
    const name = document.createElement('b')
    name.textContent = line.name
    row.append(name, document.createTextNode(` ${line.text}`))
    log.append(row)
  }
  if (!log.childNodes.length) log.append(p('Chat is quiet.', 'muted'))
  const inputEl = document.createElement('input')
  inputEl.maxLength = 80
  inputEl.placeholder = 'Say something'
  inputEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const text = inputEl.value.trim()
    if (!text) return
    send({ t: 'say', text })
    inputEl.value = ''
  })
  wrap.append(h('h3', 'Chat'), log, inputEl)
  return wrap
}

function invitePicker(room) {
  const wrap = document.createElement('div')
  wrap.append(h('h3', 'Invite clubmates'))
  const members = (state.club?.members || []).filter((m) => m.id !== state.me.id && !room.players.some((p) => p.id === m.id))
  if (!members.length) {
    wrap.append(p('Everyone in the club is already here, or the club is just you.', 'muted'))
    return wrap
  }
  const picked = new Set()
  for (const member of members) {
    const label = document.createElement('label')
    label.className = 'check'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.addEventListener('change', () => {
      if (box.checked) picked.add(member.id)
      else picked.delete(member.id)
    })
    label.append(box, document.createTextNode(member.username))
    wrap.append(label)
  }
  wrap.append(button('Send match invites', 'primary', () => {
    send({ t: 'invite', ids: [...picked] })
    toast('Invites sent')
  }))
  if (room.invites?.length) wrap.append(p(`Waiting on ${room.invites.map((i) => i.name).join(', ')}`, 'muted'))
  return wrap
}

function resultsCard() {
  const box = card()
  const result = state.result
  box.append(h('h2', 'Full time'))
  const score = document.createElement('p')
  score.className = 'lede'
  score.textContent = `${result.score.A} – ${result.score.B}`
  box.append(score)
  box.append(p(result.ranked
    ? 'Rating updated from the result, goals, and assists.'
    : result.difficulty
      ? `Bot match (${result.difficulty}). Rating stays the same.`
      : 'Practice match. Rating stays the same.'))
  const list = document.createElement('div')
  list.className = 'list'
  for (const player of result.players) {
    const row = document.createElement('div')
    row.className = 'member'
    const info = document.createElement('div')
    info.className = 'grow'
    const name = document.createElement('b')
    name.textContent = `${player.name}${player.goalie ? ' · GK' : ''}`
    const meta = document.createElement('div')
    meta.className = 'muted'
    const delta = player.delta > 0 ? `+${player.delta}` : String(player.delta)
    meta.textContent = `${player.team === 'A' ? 'Orange' : 'Blue'} · ${player.goals}G ${player.assists}A · ${player.result}${player.bot ? '' : ` · ${player.ratingBefore} → ${player.ratingAfter} (${delta}) ${player.rankAfter}`}`
    info.append(name, meta)
    row.append(info)
    list.append(row)
  }
  box.append(list, button('Back home', 'primary', () => { state.screen = 'home'; render() }))
  return box
}

function showMatch() {
  if (!world) return
  matchEl.classList.remove('hidden')
  matchEl.setAttribute('aria-hidden', 'false')
  document.body.classList.add('playing', 'touch-check')
  stage.className = 'stage-match'
  matchEl.prepend(stage)
  syncTouch()
  buildPad()
  buildQuickChat()
  maybeTips()
  document.getElementById('orient')?.classList.remove('hidden')
  syncOrient()
  if (state.scheme === 'phone') screen.orientation?.lock?.('landscape')?.catch(() => {})
  world.resize()
}

function hideMatch() {
  matchEl.classList.add('hidden')
  matchEl.setAttribute('aria-hidden', 'true')
  document.body.classList.remove('playing')
  screen.orientation?.unlock?.()
  world?.setDemo()
  banner.classList.add('hidden')
}

function syncOrient() {
  document.body.classList.toggle('portrait', window.innerWidth <= window.innerHeight)
}

function pushMatchChat(name, text) {
  const log = document.getElementById('match-log')
  if (!log) return
  const row = document.createElement('div')
  const who = document.createElement('b')
  who.textContent = name
  row.append(who, document.createTextNode(` ${text}`))
  log.append(row)
  while (log.children.length > 4) log.firstChild.remove()
}

function buildQuickChat() {
  let toggle = document.getElementById('chat-toggle')
  if (!toggle) {
    toggle = document.createElement('button')
    toggle.id = 'chat-toggle'
    toggle.type = 'button'
    toggle.textContent = 'Chat'
    toggle.addEventListener('click', () => {
      document.getElementById('quick-chat')?.classList.toggle('open')
    })
    matchEl.append(toggle)
  }
  let row = document.getElementById('quick-chat')
  if (!row) {
    row = document.createElement('div')
    row.id = 'quick-chat'
    const log = document.createElement('div')
    log.id = 'match-log'
    row.append(log)
    const buttons = document.createElement('div')
    buttons.className = 'quick-row'
    for (const text of ['Nice!', 'I got it', 'Pass', 'Sorry']) {
      buttons.append(button(text, 'ghost', () => send({ t: 'say', text })))
    }
    row.append(buttons)
    matchEl.append(row)
  }
}

function maybeTips() {
  if (localStorage.getItem('md-tips')) return
  const tip = document.createElement('div')
  tip.id = 'tips'
  tip.textContent = state.scheme === 'phone'
    ? 'Drag the left side to run. Shoot or Tackle, Spin, and Sprint are on the right.'
    : 'Move the mouse to turn while you run. With the ball: left click shoots, right click spins. Without it: left click tackles, hold right click to spin.'
  matchEl.append(tip)
  setTimeout(() => {
    tip.remove()
    localStorage.setItem('md-tips', '1')
  }, 7000)
}

function mergeSnap(prev, next) {
  const players = (next.players || []).map((p) => ({
    ...(prev.players.find((item) => item.id === p.id) || {}),
    ...p,
  }))
  return { ...prev, ...next, players }
}

function setLogo(id, src) {
  const img = document.getElementById(id)
  if (!img || img.dataset.src === src) return
  img.dataset.src = src
  img.src = src
}

function updateHud(snap) {
  const me = snap.players.find((p) => p.id === String(state.me.id))
  document.getElementById('home-name').textContent = snap.homeName || ''
  document.getElementById('away-name').textContent = snap.awayName || ''
  document.getElementById('home-score').textContent = String(snap.score.A)
  document.getElementById('away-score').textContent = String(snap.score.B)
  setLogo('home-logo', logoFor(snap.homeLogo, snap.homeName, '#ff7a2e'))
  setLogo('away-logo', logoFor(snap.awayLogo, snap.awayName, '#3c92ff'))
  const clock = Math.max(0, Math.ceil(snap.clock))
  document.getElementById('clock').textContent = `${Math.floor(clock / 60)}:${String(clock % 60).padStart(2, '0')}`
  const fill = document.getElementById('stamina-fill')
  const stamina = me ? me.stamina : 100
  fill.style.width = `${Math.max(0, Math.min(100, stamina))}%`
  fill.parentElement.classList.toggle('low', stamina < 20)
  const level = snap.difficulty ? snap.difficulty[0].toUpperCase() + snap.difficulty.slice(1) : ''
  document.getElementById('club-line').textContent = snap.clubName
    ? snap.clubName
    : level
      ? `Bots · ${level}`
      : (snap.ranked ? 'Ranked' : 'Practice')
  if (snap.phase === 'celebrate') {
    banner.classList.remove('hidden')
    const mine = me && me.team === snap.celebrateTeam
    banner.replaceChildren()
    const title = document.createElement('b')
    title.textContent = snap.scorerName ? `GOAL · ${snap.scorerName}` : 'GOAL'
    const sub = document.createElement('div')
    sub.textContent = mine ? `Celebrate · ${Math.ceil(snap.phaseT)}s` : `Next kickoff · ${Math.ceil(snap.phaseT)}s`
    banner.append(title, sub)
  } else if (snap.phase === 'countdown') {
    banner.classList.remove('hidden')
    banner.replaceChildren()
    const title = document.createElement('b')
    title.textContent = 'Get ready'
    banner.append(title)
  } else banner.classList.add('hidden')
  buildPad()
  paintPower()
}

function goalieCharging() {
  const snap = state.snap
  if (state.screen !== 'match' || !snap || snap.phase !== 'play') return false
  const me = snap.players?.find((p) => p.id === String(state.me?.id))
  return !!(me?.goalie && snap.ball?.owner === String(state.me.id))
}

function livePower() {
  const wave = 0.5 + 0.5 * Math.sin(performance.now() / 1000 * 2.6)
  return Math.round((0.15 + 0.85 * wave) * 100) / 100
}

function lockPowerKick() {
  input.power = livePower()
  input.kick += 1
  playKick()
  flushInput()
}

function paintPower() {
  const el = document.getElementById('power')
  if (!el) return
  const on = goalieCharging()
  el.classList.toggle('hidden', !on)
  if (!on) return
  const power = livePower()
  const fill = document.getElementById('power-fill')
  if (fill) fill.style.width = `${Math.round(power * 100)}%`
  const hint = document.getElementById('power-hint')
  if (hint) {
    const how = state.scheme === 'phone' ? 'Stop' : 'Enter'
    hint.textContent = `${Math.round(power * 100)}% · press ${how}`
  }
}

function buildPad() {
  const snap = state.snap
  const me = snap?.players?.find((p) => p.id === String(state.me?.id))
  const scoring = snap?.phase === 'celebrate' && me && me.team === snap.celebrateTeam
  const frozen = !!(snap && snap.phase !== 'play')
  const charging = goalieCharging()
  const hasBall = snap?.ball?.owner === String(state.me?.id)
  const phone = state.scheme === 'phone'
  const buttons = phone
    ? [
        ['sprint', 'Sprint', true],
        charging ? ['stop', 'Stop'] : hasBall ? ['kick', 'Shoot'] : ['slide', 'Tackle'],
        ['spin', 'Spin'],
        ...(me?.goalie && !hasBall ? [['dive', 'Dive']] : []),
        ...(scoring ? [['quack', 'Quack'], ['bob', 'Bob'], ['sit', 'Sit'], ['glide', 'Glide']] : []),
      ]
    : [
        ['sprint', 'Sprint', true],
        ['spin', 'Spin'],
        charging ? ['stop', 'Stop'] : ['kick', 'Kick'],
        ['slide', 'Slide'],
        ['pass', 'Pass'],
        ...(me?.goalie ? [['dive', 'Dive']] : []),
        ...(scoring ? [['quack', 'Quack'], ['bob', 'Bob'], ['sit', 'Sit'], ['glide', 'Glide']] : []),
      ]
  const signature = JSON.stringify([frozen, scoring, buttons.map((b) => b[0])])
  if (pad.dataset.sig === signature) return
  pad.dataset.sig = signature
  pad.replaceChildren()
  for (const [id, label, wide] of buttons) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    if (wide) button.classList.add('wide')
    button.dataset.act = id
    const celebrateAct = scoring && ['spin', 'quack', 'bob', 'sit', 'glide'].includes(id)
    button.disabled = frozen && !celebrateAct
    if (id === 'sprint') {
      const down = (e) => { e.preventDefault(); input.sprint = true; button.classList.add('held') }
      const up = () => { input.sprint = false; button.classList.remove('held') }
      button.addEventListener('pointerdown', down)
      button.addEventListener('pointerup', up)
      button.addEventListener('pointercancel', up)
      button.addEventListener('pointerleave', up)
    } else if (id === 'stop') {
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        lockPowerKick()
      })
    } else {
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        if (scoring) {
          input.emote += 1
          input.emoteName = id
          if (id === 'quack') playQuack()
        } else {
          input[id] += 1
          if (id === 'kick') playKick()
        }
        flushInput()
      })
    }
    pad.append(button)
  }
}

function currentStick() {
  const yaw = state.screen === 'match' && world ? world.aimYaw : (camYaw || 0)
  let forward = 0
  let strafe = 0
  if (keys.has('KeyW') || keys.has('ArrowUp')) forward += 1
  if (keys.has('KeyS') || keys.has('ArrowDown')) forward -= 1
  if (keys.has('KeyD') || keys.has('ArrowRight')) strafe += 1
  if (keys.has('KeyA') || keys.has('ArrowLeft')) strafe -= 1
  if (joy.active) {
    forward += -joy.y
    strafe += joy.x
  }
  const move = cameraMove(yaw, forward, strafe)
  return {
    mx: move.mx,
    mz: move.mz,
    aim: yaw,
    sprint: input.sprint || keys.has('ShiftLeft') || keys.has('ShiftRight'),
    kick: input.kick,
    pass: input.pass,
    slide: input.slide,
    spin: input.spin,
    dive: input.dive,
    spinHold: !!input.spinHold,
    emote: input.emoteName,
    emoteId: input.emote,
    sens: readSens(),
    ...(input.power == null ? {} : { power: input.power }),
  }
}

function readSens() {
  const n = Number(localStorage.getItem('md-sensitivity'))
  const phone = state.scheme === 'phone' || (state.scheme !== 'laptop' && detectedScheme() === 'phone')
  const fallback = phone ? 0.5 : 1
  return Number.isFinite(n) ? Math.min(1.3, Math.max(0.4, n)) : fallback
}

function detectedScheme() {
  return matchMedia('(pointer: coarse)').matches || window.innerWidth < 860 ? 'phone' : 'laptop'
}

function chosenScheme() {
  const saved = localStorage.getItem('md-scheme')
  return saved === 'laptop' || saved === 'phone' ? saved : detectedScheme()
}

function applyScheme(scheme) {
  state.scheme = scheme
  localStorage.setItem('md-scheme', scheme)
  const phone = scheme === 'phone'
  document.body.classList.toggle('touch', phone)
  document.body.classList.toggle('phone', phone)
}

function showSchemePicker() {
  let overlay = document.getElementById('scheme-picker')
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'scheme-picker'
    overlay.className = 'scheme-picker'
    document.body.append(overlay)
  }
  const pick = { value: chosenScheme() }
  const card = document.createElement('div')
  card.className = 'card'
  card.append(h('h2', 'How are you playing?'))
  card.append(p('Laptop uses the keyboard. Phone uses the joystick and buttons. This choice is remembered on this device.'))
  const row = document.createElement('div')
  row.className = 'modes'
  const buttons = []
  for (const [id, label] of [['laptop', 'Laptop controls'], ['phone', 'Phone controls']]) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `minute${pick.value === id ? ' on' : ''}`
    b.textContent = label
    b.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      confirmScheme(id)
    })
    buttons.push(b)
    row.append(b)
  }
  card.append(row, button('Play', 'primary', (e) => {
    e.preventDefault()
    e.stopPropagation()
    confirmScheme(pick.value)
  }))
  overlay.replaceChildren(card)
  overlay.classList.remove('hidden')
}

function confirmScheme(scheme) {
  if (state.schemeLock) return
  state.schemeLock = true
  applyScheme(scheme)
  const overlay = document.getElementById('scheme-picker')
  if (overlay) overlay.classList.add('hidden')
  const msg = state.pendingStart
  state.pendingStart = null
  if (msg && state.screen !== 'match') enterMatch(msg)
  state.schemeLock = false
}

function enterMatch(msg) {
  state.you = msg.you
  state.snap = msg.snap
  state.matchId = msg.snap?.id || state.pickerFor || ''
  state.result = null
  state.screen = 'match'
  showMatch()
  world.setMatch(msg.you.id)
  world.pushSnap(msg.snap, currentStick())
  updateHud(msg.snap)
  playWhistle()
}

function flushInput() {
  if (state.screen !== 'match') return
  const stick = currentStick()
  const body = JSON.stringify(stick)
  const now = performance.now()
  const buttons = stick.kick || stick.pass || stick.slide || stick.spin || stick.dive || stick.emoteId
  const moving = stick.mx !== 0 || stick.mz !== 0 || stick.sprint
  world?.setInput({ mx: stick.mx, mz: stick.mz, sprint: stick.sprint })
  if (body === sent && !buttons && now - (flushInput.at || 0) < (moving ? 32 : 200)) return
  sent = body
  flushInput.at = now
  const msg = { t: 'in', seq: (flushInput.seq = (flushInput.seq || 0) + 1), ...stick }
  send(msg)
}

function syncTouch() {
  const phone = state.scheme === 'phone'
  document.body.classList.toggle('touch', phone)
  document.body.classList.toggle('phone', phone)
}

function helpNode() {
  const sheet = document.createElement('div')
  sheet.className = 'sheet'
  sheet.append(h('h3', 'Controls'))
  const keysTitle = document.createElement('b')
  keysTitle.textContent = 'Keyboard'
  const keyList = document.createElement('ul')
  for (const line of [
    'Move with W A S D or the arrow keys. Move the mouse to turn while you run. The camera stays where you aim.',
    'With the ball, left click shoots and right click spins the dribble. Without the ball, left click slide tackles and holding right click spins you in place.',
    'Sprint: hold Shift. The stamina bar drains, then refills when you let go. Sprinting with the ball is slower than sprinting without it.',
    'Kick: K or Space. Pass: J. When you are the goalie and you have the ball, the power bar slides. Press Enter to lock it and shoot.',
    'Slide tackle: C or E. If you miss, you are stunned briefly and the move goes on cooldown.',
    'Dribble spin: P. During the spin, and for a moment after, nobody can take the ball. A slide into it misses and stuns. It has a cooldown.',
    'Goalie dive (3v3 only): G. Dive to catch a shot.',
    'After a goal, the scoring side celebrates for 5 seconds: 1 spin, 2 quack, 3 head bob, 4 sit and stand, 5 roller glide.',
  ]) {
    const li = document.createElement('li')
    li.textContent = line
    keyList.append(li)
  }
  const touchTitle = document.createElement('b')
  touchTitle.textContent = 'Phone and tablet'
  const touchList = document.createElement('ul')
  for (const line of [
    'Drag the left side of the screen. A joystick appears under your thumb.',
    'Hold Sprint. It uses the same stamina bar, and it is slower while you have the ball.',
    'Shoot when you have the ball, Tackle when you do not. Spin dodges. As goalie with the ball, tap Stop when the power bar is where you want it.',
    'In 3v3 the goalie gets Dive instead of an extra button piled on the screen.',
    'After a goal the pad swaps to Spin, Quack, Bob, Sit, and Glide for the scoring team. The other team waits.',
  ]) {
    const li = document.createElement('li')
    li.textContent = line
    touchList.append(li)
  }
  sheet.append(keysTitle, keyList, touchTitle, touchList, p('Matches are 3 or 5 minutes. You pick the length in the lobby before you queue or create a room.'))
  sheet.append(button('Close', 'primary', () => {
    helpEl.classList.add('hidden')
    const inline = document.getElementById('inline-help')
    if (inline) inline.remove()
  }))
  return sheet
}

function openHelp(host) {
  if (host) {
    const old = document.getElementById('inline-help')
    if (old) old.remove()
    const node = helpNode()
    node.id = 'inline-help'
    host.append(node)
    return
  }
  helpEl.classList.remove('hidden')
  helpEl.replaceChildren(helpNode())
}

function setupInput() {
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return
    keys.add(e.code)
    if (state.screen !== 'match') return
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault()
    if (e.code === 'Enter' && goalieCharging()) { e.preventDefault(); lockPowerKick() }
    if ((e.code === 'KeyK' || e.code === 'Space') && goalieCharging()) lockPowerKick()
    else if (e.code === 'KeyK' || e.code === 'Space') { input.kick += 1; playKick() }
    if (e.code === 'KeyJ') input.pass += 1
    if (e.code === 'KeyC' || e.code === 'KeyE') input.slide += 1
    if (e.code === 'KeyP') input.spin += 1
    if (e.code === 'KeyG') input.dive += 1
    const emotes = { Digit1: 'spin', Digit2: 'quack', Digit3: 'bob', Digit4: 'sit', Digit5: 'glide' }
    if (emotes[e.code]) {
      input.emote += 1
      input.emoteName = emotes[e.code]
      if (emotes[e.code] === 'quack') playQuack()
    }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') input.sprint = true
    flushInput()
  })
  window.addEventListener('keyup', (e) => {
    keys.delete(e.code)
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') input.sprint = keys.has('ShiftLeft') || keys.has('ShiftRight')
    flushInput()
  })
  const stick = document.getElementById('stick')
  const knob = document.getElementById('knob')
  const pointOf = (e) => (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e
  const beginJoy = (e) => {
    if (e.cancelable) e.preventDefault()
    e.stopPropagation()
    joy.active = true
    if (e.pointerId != null) {
      try { stick.setPointerCapture(e.pointerId) } catch { /* a touch event has no pointer to capture */ }
    }
    moveJoy(e)
    flushInput()
  }
  const dragJoy = (e) => {
    if (!joy.active) return
    if (e.cancelable) e.preventDefault()
    moveJoy(e)
    flushInput()
  }
  const placeKnob = (nx, ny, feel) => {
    const width = stick.getBoundingClientRect().width || stick.offsetWidth || 168
    const max = width / 2
    const knobSize = knob.offsetWidth || 64
    const knobR = knobSize / 2
    const reach = Math.max(0, max - knobR - 6) * feel
    knob.style.left = `${max - knobR + nx * reach}px`
    knob.style.top = `${max - knobR + ny * reach}px`
  }
  const end = () => {
    if (!joy.active) return
    joy = { x: 0, y: 0, active: false }
    placeKnob(0, 0, 0)
    flushInput()
  }
  stick.addEventListener('pointerdown', beginJoy, { passive: false })
  stick.addEventListener('touchstart', beginJoy, { passive: false })
  window.addEventListener('pointermove', dragJoy, { passive: false })
  window.addEventListener('touchmove', dragJoy, { passive: false })
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
  window.addEventListener('touchend', end)
  window.addEventListener('touchcancel', end)
  function moveJoy(e) {
    const point = pointOf(e)
    const rect = stick.getBoundingClientRect()
    if (rect.width < 2) return
    const dx = point.clientX - (rect.left + rect.width / 2)
    const dy = point.clientY - (rect.top + rect.height / 2)
    const max = rect.width / 2
    const mag = Math.hypot(dx, dy)
    const phone = state.scheme === 'phone'
    const dead = max * (phone ? 0.3 : 0.16)
    if (mag <= dead) {
      joy.x = 0
      joy.y = 0
      placeKnob(0, 0, 0)
      return
    }
    const nx = dx / mag
    const ny = dy / mag
    const strength = Math.min(1, (mag - dead) / (max - dead))
    const sens = readSens()
    const feel = phone ? strength * strength * sens : Math.pow(strength, 1.15 / sens)
    joy.x = nx * feel
    joy.y = ny * feel
    placeKnob(nx, ny, feel)
  }
  matchEl.addEventListener('mousemove', (e) => {
    if (state.screen !== 'match' || state.scheme === 'phone') return
    if (!e.movementX) return
    world?.addAim(-e.movementX * 0.0035)
  })
  matchEl.addEventListener('contextmenu', (e) => {
    if (state.screen === 'match') e.preventDefault()
  })
  matchEl.addEventListener('mousedown', (e) => {
    if (state.screen !== 'match' || state.scheme === 'phone') return
    if (e.target.closest && e.target.closest('button, input, #quick-chat, #help')) return
    const has = state.snap?.ball?.owner === String(state.me?.id)
    if (e.button === 0) {
      if (has) { input.kick += 1; playKick() } else input.slide += 1
      flushInput()
    } else if (e.button === 2) {
      if (has) input.spin += 1
      else input.spinHold = true
      flushInput()
    }
  })
  window.addEventListener('mouseup', (e) => {
    if (e.button !== 2 || !input.spinHold) return
    input.spinHold = false
    flushInput()
  })
  matchEl.addEventListener('touchstart', (e) => {
    if (state.scheme !== 'phone' || state.screen !== 'match') return
    const t = [...e.changedTouches].find((touch) => touch.clientX < window.innerWidth * 0.55)
    if (!t || (e.target.closest && e.target.closest('#pad, button, #quick-chat'))) return
    stick.style.left = `${t.clientX - 70}px`
    stick.style.top = `${t.clientY - 70}px`
  }, { passive: true })
  window.addEventListener('resize', syncOrient)
  window.addEventListener('orientationchange', () => {
    syncOrient()
    setTimeout(syncOrient, 250)
  })
  document.getElementById('orient-x')?.addEventListener('click', () => {
    document.getElementById('orient')?.classList.add('hidden')
  })
  document.getElementById('help-btn').addEventListener('click', () => openHelp(null))
  document.getElementById('leave-btn').addEventListener('click', () => {
    send({ t: 'leave' })
    hideMatch()
    state.matchId = null
    state.screen = 'home'
    render()
  })
  helpEl.addEventListener('click', (e) => { if (e.target === helpEl) helpEl.classList.add('hidden') })
  setInterval(() => { paintPower(); flushInput() }, 50)
  window.addEventListener('resize', syncTouch)
  window.addEventListener('pointerdown', () => unlockAudio(), { once: true })
}

async function logout() {
  outbox.length = 0
  await api('/api/logout', {})
  state.me = null
  state.club = null
  state.screen = 'auth'
  if (ws) ws.close()
  render()
}

async function boot() {
  setupInput()
  syncTouch()
  const canvas = document.createElement('canvas')
  canvas.id = 'view'
  stage.appendChild(canvas)
  try {
    world = await createWorld(canvas)
    world.setInputSource(() => currentStick())
  } catch (err) {
    console.error(err)
  }
  try {
    const data = await api('/api/me')
    state.me = data.user
    if (state.me) {
      await refreshMe()
      await refreshNotes()
      connect()
      state.screen = 'home'
    } else state.screen = 'auth'
  } catch {
    state.screen = 'auth'
  }
  render()
  setInterval(async () => {
    if (!state.me || state.screen === 'match') return
    const before = JSON.stringify(state.notes)
    try { await refreshNotes() } catch { return }
    if (JSON.stringify(state.notes) !== before && (state.screen === 'home' || state.screen === 'lobby')) render()
  }, 4000)
}

boot()
