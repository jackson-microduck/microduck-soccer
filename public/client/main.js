import { createWorld } from './world.js'
import { badgeDataUrl, mountLogoStudio, safeLogo } from './logo.js'
import { playGoal, playKick, playQuack, playWhistle, unlockAudio } from './audio.js'
import { rankFor } from '/shared/game.js'

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

function hexOk(value) {
  return /^#[0-9a-f]{6}$/i.test(value || '')
}

async function api(url, body, method) {
  const res = await fetch(url, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Something went wrong.')
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
  ws = new WebSocket(`${proto}://${location.host}`)
  ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    onNet(msg)
  })
  ws.addEventListener('close', () => {
    if (state.me) setTimeout(connect, 1200)
  })
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg))
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
    if (state.screen === 'lobby') render()
    return
  }
  if (msg.t === 'room') {
    state.room = msg
    state.queue = null
    state.screen = 'lobby'
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
    state.you = msg.you
    state.snap = msg.snap
    state.result = null
    state.screen = 'match'
    showMatch()
    world.setMatch(msg.you.id)
    world.pushSnap(msg.snap, currentStick())
    updateHud(msg.snap)
    playWhistle()
    return
  }
  if (msg.t === 'snap') {
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

async function refreshMe() {
  const data = await api('/api/me')
  state.me = data.user
  if (state.me?.club) {
    const club = await api('/api/clubs/mine')
    state.club = club.club
  } else state.club = null
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
  else if (state.screen === 'club') root.append(clubCard())
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
  hero.append(p('Queue a ranked match, or open a private room for your club. The ball sticks when you take it. Slide to steal it. Spin to slip a tackle.'))
  const slot = document.createElement('div')
  slot.id = 'hero-slot'
  const actions = document.createElement('div')
  actions.className = 'actions'
  actions.append(
    button('Play', 'primary', () => { state.screen = 'lobby'; state.error = ''; render() }),
    button('Club', 'ghost', () => { state.screen = 'club'; render() }),
    button('Find friends', 'ghost', () => { state.screen = 'directory'; loadDirectory(); render() }),
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
  if (note.kind === 'match_invite') {
    state.pendingNote = note
    state.screen = 'lobby'
    render()
    send({ t: 'join', code: note.payload.roomCode })
    return
  }
  try {
    const data = await api(`/api/notifications/${note.id}/respond`, { action: 'accept' })
    state.me = data.user
    state.club = data.club
    await refreshNotes()
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
  } else if (state.club && player.id !== state.me.id) {
    box.append(button('Invite to my club', 'primary', async () => {
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

function clubCard() {
  const box = card()
  if (!state.club) {
    box.append(h('h2', 'Start a club'))
    box.append(p('A club is your friend group. Share the code, or invite someone from the directory and let them accept.'))
    const name = document.createElement('input')
    name.maxLength = 24
    name.placeholder = 'Pond United'
    const code = document.createElement('input')
    code.maxLength = 8
    code.placeholder = 'Join with a code'
    const err = p(state.error, 'error')
    box.append(name, button('Create club', 'primary', async () => {
      try {
        const data = await api('/api/clubs', { name: name.value })
        state.club = data.club
        await refreshMe()
        state.error = ''
        render()
      } catch (err) { state.error = err.message; render() }
    }), code, button('Join with code', 'ghost', async () => {
      try {
        const data = await api('/api/clubs/join', { code: code.value })
        state.club = data.club
        await refreshMe()
        state.error = ''
        render()
      } catch (err) { state.error = err.message; render() }
    }), err)
    return box
  }
  const head = document.createElement('div')
  head.className = 'member'
  head.append(logoImg(state.club.logo, state.club.name, '#ff6a1a'))
  const text = document.createElement('div')
  const title = document.createElement('h2')
  title.textContent = state.club.name
  text.append(title, p(`Code ${state.club.code} · led by ${state.club.owner}`))
  head.append(text)
  box.append(head)
  const totals = document.createElement('div')
  totals.className = 'stats'
  totals.append(stat(state.club.totals.goals, 'Goals'), stat(state.club.totals.assists, 'Assists'), stat(state.club.totals.wins, 'Wins'))
  box.append(totals, h('h3', 'Leaderboard'))
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
  box.append(button('Leave club', 'danger', async () => {
    await api('/api/clubs/leave', {})
    state.club = null
    await refreshMe()
    render()
  }))
  return box
}

function lobbyCard() {
  const box = card()
  box.append(h('h2', 'Match'))
  if (state.queue) {
    box.append(p(`Looking for a ${state.queue.mode} · ${state.queue.minutes} min. ${state.queue.count}/${state.queue.need} ducks in the queue.`))
    box.append(button('Leave queue', 'ghost', () => send({ t: 'leave-queue' })))
    return box
  }
  if (state.room) return roomCard(box)
  box.append(p('Ranked queue matches players by rating and balances the teams. A private room can be a club match with invites.'))
  box.append(h('h3', 'Mode'))
  const modes = document.createElement('div')
  modes.className = 'modes'
  for (const mode of ['1v1', '2v2', '3v3']) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `mode${state.mode === mode ? ' on' : ''}`
    b.textContent = mode === '3v3' ? '3v3 + GK' : mode
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
  const err = p(state.error, 'error')
  const actions = document.createElement('div')
  actions.className = 'actions'
  actions.append(
    button('Queue ranked', 'primary', () => {
      send({ t: 'queue', mode: state.mode, minutes: state.minutes })
    }),
    button('Create room', 'ghost', () => {
      send({ t: 'host', mode: state.mode, minutes: state.minutes, clubOnly: state.clubOnly && !!state.club, practice: state.practice })
    }),
  )
  const join = document.createElement('input')
  join.placeholder = 'Room code'
  join.maxLength = 6
  box.append(modes, h('h3', 'Length'), minutes, club, practice, err, actions, join, button('Join code', 'ghost', () => {
    send({ t: 'join', code: join.value.trim().toUpperCase() })
  }))
  return box
}

function roomCard(box) {
  const room = state.room
  box.append(h('h2', `${room.mode} · ${room.minutes} min`))
  if (room.clubName) box.append(p(`Club match · ${room.clubName}`))
  const code = document.createElement('div')
  code.className = 'code'
  code.textContent = room.code
  box.append(code, p(room.practice ? 'Practice ducks will fill empty spots. Ranked rating stays put.' : 'Teams are balanced by rating when the host starts.'))
  const list = document.createElement('div')
  list.className = 'list'
  for (const player of room.players) {
    const row = document.createElement('div')
    row.className = 'member'
    const name = document.createElement('b')
    name.textContent = `${player.name}${player.id === room.hostId ? ' · host' : ''}${player.goalie ? ' · goalie' : ''}`
    const meta = document.createElement('span')
    meta.className = 'muted'
    meta.textContent = `${rankFor(player.rating)} ${player.rating}`
    row.append(name, meta)
    list.append(row)
  }
  box.append(list)
  if (room.mode === '3v3') {
    const me = room.players.find((p) => p.id === state.me.id)
    box.append(button(me?.goalie ? 'Goalie spot claimed' : 'I will play goalie', 'ghost', () => {
      send({ t: 'goalie', on: !me?.goalie })
    }))
  }
  if (room.clubId && room.hostId === state.me.id) box.append(invitePicker(room))
  const actions = document.createElement('div')
  actions.className = 'actions'
  if (room.hostId === state.me.id) actions.append(button('Start match', 'primary', () => send({ t: 'start' })))
  actions.append(button('Leave room', 'ghost', () => send({ t: 'leave' })))
  box.append(p(state.error, 'error'), actions)
  return box
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
  box.append(p(result.ranked ? 'Rating updated from the result, goals, and assists.' : 'Practice match. Rating stays the same.'))
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
  world.resize()
}

function hideMatch() {
  matchEl.classList.add('hidden')
  matchEl.setAttribute('aria-hidden', 'true')
  document.body.classList.remove('playing')
  world?.setDemo()
  banner.classList.add('hidden')
}

function updateHud(snap) {
  const me = snap.players.find((p) => p.id === String(state.me.id))
  document.getElementById('home-name').textContent = snap.homeName
  document.getElementById('away-name').textContent = snap.awayName
  document.getElementById('home-score').textContent = String(snap.score.A)
  document.getElementById('away-score').textContent = String(snap.score.B)
  document.getElementById('home-logo').src = logoFor(snap.homeLogo, snap.homeName, '#ff7a2e')
  document.getElementById('away-logo').src = logoFor(snap.awayLogo, snap.awayName, '#3c92ff')
  const clock = Math.max(0, Math.ceil(snap.clock))
  document.getElementById('clock').textContent = `${Math.floor(clock / 60)}:${String(clock % 60).padStart(2, '0')}`
  const fill = document.getElementById('stamina-fill')
  const stamina = me ? me.stamina : 100
  fill.style.width = `${Math.max(0, Math.min(100, stamina))}%`
  fill.parentElement.classList.toggle('low', stamina < 20)
  document.getElementById('club-line').textContent = snap.clubName ? snap.clubName : (snap.ranked ? 'Ranked' : 'Practice')
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
}

function buildPad() {
  const snap = state.snap
  const me = snap?.players?.find((p) => p.id === String(state.me?.id))
  const celebrate = snap?.phase === 'celebrate' && me && me.team === snap.celebrateTeam
  const waiting = snap?.phase === 'celebrate' && me && me.team !== snap.celebrateTeam
  const buttons = celebrate
    ? [['spin', 'Spin'], ['quack', 'Quack'], ['bob', 'Bob'], ['sit', 'Sit'], ['glide', 'Glide']]
    : waiting
      ? []
      : [
          ['sprint', 'Sprint', true],
          ['spin', 'Spin'],
          ['kick', 'Kick'],
          ['slide', 'Slide'],
          ['pass', 'Pass'],
          ...(me?.goalie ? [['dive', 'Dive']] : []),
        ]
  const signature = JSON.stringify(buttons.map((b) => b[0]))
  if (pad.dataset.sig === signature) return
  pad.dataset.sig = signature
  pad.replaceChildren()
  for (const [id, label, wide] of buttons) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    if (wide) button.classList.add('wide')
    button.dataset.act = id
    if (id === 'sprint') {
      const down = (e) => { e.preventDefault(); input.sprint = true; button.classList.add('held') }
      const up = () => { input.sprint = false; button.classList.remove('held') }
      button.addEventListener('pointerdown', down)
      button.addEventListener('pointerup', up)
      button.addEventListener('pointercancel', up)
      button.addEventListener('pointerleave', up)
    } else {
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        if (celebrate) {
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
  let mx = 0
  let mz = 0
  const yaw = camYaw || 0
  const fX = Math.sin(yaw)
  const fZ = Math.cos(yaw)
  const rX = Math.cos(yaw)
  const rZ = -Math.sin(yaw)
  if (keys.has('KeyW') || keys.has('ArrowUp')) { mx += fX; mz += fZ }
  if (keys.has('KeyS') || keys.has('ArrowDown')) { mx -= fX; mz -= fZ }
  if (keys.has('KeyD') || keys.has('ArrowRight')) { mx += rX; mz += rZ }
  if (keys.has('KeyA') || keys.has('ArrowLeft')) { mx -= rX; mz -= rZ }
  if (joy.active) {
    mx += fX * -joy.y + rX * joy.x
    mz += fZ * -joy.y + rZ * joy.x
  }
  const mag = Math.hypot(mx, mz)
  if (mag > 1) { mx /= mag; mz /= mag }
  return {
    mx, mz,
    sprint: input.sprint || keys.has('ShiftLeft') || keys.has('ShiftRight'),
    kick: input.kick,
    pass: input.pass,
    slide: input.slide,
    spin: input.spin,
    dive: input.dive,
    emote: input.emoteName,
    emoteId: input.emote,
  }
}

function flushInput() {
  if (state.screen !== 'match') return
  const msg = { t: 'in', seq: (flushInput.seq = (flushInput.seq || 0) + 1), ...currentStick() }
  const key = JSON.stringify(msg)
  if (key === sent && !msg.kick && !msg.pass && !msg.slide && !msg.spin && !msg.dive && !msg.emoteId) return
  sent = key
  world?.setInput({ mx: msg.mx, mz: msg.mz, sprint: msg.sprint })
  send(msg)
}

function syncTouch() {
  const coarse = matchMedia('(pointer: coarse)').matches || window.innerWidth < 860
  document.body.classList.toggle('touch', coarse)
}

function helpNode() {
  const sheet = document.createElement('div')
  sheet.className = 'sheet'
  sheet.append(h('h3', 'Controls'))
  const keysTitle = document.createElement('b')
  keysTitle.textContent = 'Keyboard'
  const keyList = document.createElement('ul')
  for (const line of [
    'Move with W A S D or the arrow keys. The camera stays behind your duck.',
    'Sprint: hold Shift. The stamina bar drains, then refills when you let go. Sprinting with the ball is slower than sprinting without it.',
    'Kick: K or Space. Pass: J.',
    'Slide tackle: C. If you miss, you are stunned briefly and the move goes on cooldown.',
    'Dribble spin: Q. A quick Microduck spin that dodges a slide tackle if you time it. It has its own cooldown.',
    'Goalie dive (3v3 only): G. Dive to catch a shot.',
    'After a goal, the scoring side celebrates for 8 seconds: 1 spin, 2 quack, 3 head bob, 4 sit and stand, 5 roller glide.',
  ]) {
    const li = document.createElement('li')
    li.textContent = line
    keyList.append(li)
  }
  const touchTitle = document.createElement('b')
  touchTitle.textContent = 'Phone and tablet'
  const touchList = document.createElement('ul')
  for (const line of [
    'Drag the joystick to move.',
    'Hold Sprint. It uses the same stamina bar, and it is slower while you have the ball.',
    'Tap Kick, Pass, Slide, or Spin. Spin is the dribble dodge.',
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
    if (e.code === 'KeyK' || e.code === 'Space') { input.kick += 1; playKick() }
    if (e.code === 'KeyJ') input.pass += 1
    if (e.code === 'KeyC') input.slide += 1
    if (e.code === 'KeyQ') input.spin += 1
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
  stick.addEventListener('pointerdown', (e) => {
    joy.active = true
    stick.setPointerCapture(e.pointerId)
    moveJoy(e)
  })
  stick.addEventListener('pointermove', (e) => { if (joy.active) moveJoy(e) })
  const end = () => {
    joy = { x: 0, y: 0, active: false }
    knob.style.left = '32px'
    knob.style.top = '32px'
  }
  stick.addEventListener('pointerup', end)
  stick.addEventListener('pointercancel', end)
  function moveJoy(e) {
    const rect = stick.getBoundingClientRect()
    const dx = e.clientX - (rect.left + rect.width / 2)
    const dy = e.clientY - (rect.top + rect.height / 2)
    const max = rect.width / 2
    const mag = Math.hypot(dx, dy) || 1
    const clamped = Math.min(max - 16, mag)
    const nx = dx / mag
    const ny = dy / mag
    joy.x = (dx / mag) * (clamped / max)
    joy.y = (dy / mag) * (clamped / max)
    knob.style.left = `${32 + nx * clamped * 0.55}px`
    knob.style.top = `${32 + ny * clamped * 0.55}px`
  }
  document.getElementById('help-btn').addEventListener('click', () => openHelp(null))
  document.getElementById('leave-btn').addEventListener('click', () => {
    send({ t: 'leave' })
    hideMatch()
    state.screen = 'home'
    render()
  })
  helpEl.addEventListener('click', (e) => { if (e.target === helpEl) helpEl.classList.add('hidden') })
  setInterval(flushInput, 50)
  window.addEventListener('resize', syncTouch)
  window.addEventListener('pointerdown', () => unlockAudio(), { once: true })
}

async function logout() {
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
