const COLORS = ['#ff6a1a', '#2f8cff', '#22a06b', '#8b5cf6', '#f5b942', '#ef4444', '#1c2430', '#fff7ef']
const badgeCache = new Map()

export function safeLogo(src) {
  return typeof src === 'string' && /^data:image\/(png|jpeg);base64,[a-z0-9+/=]+$/i.test(src) ? src : ''
}

export function badgeDataUrl(letter, color) {
  const key = `${letter}:${color}`
  if (badgeCache.has(key)) return badgeCache.get(key)
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const g = canvas.getContext('2d')
  g.fillStyle = color || '#ff6a1a'
  shield(g, 8, 6, 112, 116)
  g.fill()
  g.fillStyle = '#fff7ef'
  g.font = '800 64px Nunito, Trebuchet MS, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(String(letter || 'M').slice(0, 1).toUpperCase(), 64, 58)
  const url = canvas.toDataURL('image/png')
  badgeCache.set(key, url)
  return url
}

function shield(g, x, y, w, h) {
  g.beginPath()
  g.moveTo(x + w * 0.5, y + h)
  g.lineTo(x + w, y + h * 0.62)
  g.lineTo(x + w, y + 18)
  g.quadraticCurveTo(x + w, y, x + w - 18, y)
  g.lineTo(x + 18, y)
  g.quadraticCurveTo(x, y, x, y + 18)
  g.lineTo(x, y + h * 0.62)
  g.closePath()
}

export function emblemFromWords(prompt) {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const g = canvas.getContext('2d')
  const words = String(prompt || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const palette = {
    orange: '#ff6a1a', blue: '#2f8cff', red: '#ef4444', green: '#22a06b',
    purple: '#8b5cf6', gold: '#e6a21a', pink: '#ec4899', black: '#1c2430',
    white: '#f4efe6', teal: '#0f9d8a', yellow: '#f5b942',
  }
  const icons = ['ball', 'star', 'bolt', 'duck', 'crown', 'shield', 'flame', 'heart', 'moon']
  let bg = '#ff6a1a'
  let icon = 'duck'
  for (const word of words) {
    if (palette[word]) bg = palette[word]
    if (icons.includes(word)) icon = word
  }
  const skip = new Set([...Object.keys(palette), ...icons, 'club', 'logo', 'the', 'a', 'an', 'with', 'and', 'for'])
  const textWord = words.find((word) => !skip.has(word)) || 'ducks'
  const label = textWord.slice(0, 8).toUpperCase()
  const ink = bg === '#f4efe6' || bg === '#f5b942' ? '#1c2430' : '#fff8f2'
  g.clearRect(0, 0, 256, 256)
  g.fillStyle = bg
  shield(g, 28, 16, 200, 224)
  g.fill()
  g.save()
  g.translate(128, 108)
  g.fillStyle = ink
  g.strokeStyle = ink
  g.lineWidth = 8
  g.lineCap = 'round'
  g.lineJoin = 'round'
  drawIcon(g, icon)
  g.restore()
  g.fillStyle = ink
  g.font = '800 34px Nunito, Trebuchet MS, sans-serif'
  g.textAlign = 'center'
  g.fillText(label, 128, 214)
  return canvas.toDataURL('image/png')
}

function drawIcon(g, icon) {
  if (icon === 'star') {
    g.beginPath()
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + i * Math.PI * 2 / 5
      const b = a + Math.PI / 5
      g.lineTo(Math.cos(a) * 42, Math.sin(a) * 42)
      g.lineTo(Math.cos(b) * 18, Math.sin(b) * 18)
    }
    g.closePath()
    g.fill()
    return
  }
  if (icon === 'bolt') {
    g.beginPath()
    g.moveTo(8, -40)
    g.lineTo(-18, 4)
    g.lineTo(2, 4)
    g.lineTo(-10, 42)
    g.lineTo(22, -8)
    g.lineTo(0, -8)
    g.closePath()
    g.fill()
    return
  }
  if (icon === 'ball') {
    g.beginPath()
    g.arc(0, 0, 36, 0, Math.PI * 2)
    g.stroke()
    g.beginPath()
    g.arc(0, 0, 10, 0, Math.PI * 2)
    g.stroke()
    return
  }
  if (icon === 'crown') {
    g.beginPath()
    g.moveTo(-40, 18)
    g.lineTo(-28, -20)
    g.lineTo(0, 8)
    g.lineTo(28, -24)
    g.lineTo(40, 18)
    g.closePath()
    g.fill()
    return
  }
  if (icon === 'heart') {
    g.beginPath()
    g.arc(-16, -8, 16, Math.PI, 0)
    g.arc(16, -8, 16, Math.PI, 0)
    g.lineTo(0, 32)
    g.fill()
    return
  }
  if (icon === 'flame') {
    g.beginPath()
    g.moveTo(0, -40)
    g.bezierCurveTo(28, -10, 26, 10, 0, 36)
    g.bezierCurveTo(-26, 10, -28, -10, 0, -40)
    g.fill()
    return
  }
  if (icon === 'moon') {
    g.beginPath()
    g.arc(-4, 0, 32, -1.2, 1.2)
    g.arc(10, 0, 24, 1.1, -1.1, true)
    g.fill()
    return
  }
  if (icon === 'shield') {
    shield(g, -32, -36, 64, 74)
    g.stroke()
    return
  }
  g.beginPath()
  g.ellipse(0, -6, 34, 22, 0, 0, Math.PI * 2)
  g.fill()
  g.beginPath()
  g.ellipse(30, 0, 22, 8, 0.2, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = '#1c2430'
  g.beginPath()
  g.arc(-8, -10, 3.5, 0, Math.PI * 2)
  g.fill()
}

export function mountLogoStudio(parent, { initial, onSave }) {
  parent.replaceChildren()
  const tabs = ['Draw', 'Upload', 'Maker']
  let tab = 'Draw'
  const bar = document.createElement('div')
  bar.className = 'tabbar'
  const stage = document.createElement('div')
  parent.append(bar, stage)
  function paintTabs() {
    bar.replaceChildren()
    for (const name of tabs) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = name
      button.className = name === tab ? 'on' : ''
      button.addEventListener('click', () => {
        tab = name
        paintTabs()
        paint()
      })
      bar.append(button)
    }
  }
  function paint() {
    stage.replaceChildren()
    if (tab === 'Draw') stage.append(drawPanel(onSave, initial))
    else if (tab === 'Upload') stage.append(uploadPanel(onSave))
    else stage.append(makerPanel(onSave))
  }
  paintTabs()
  paint()
}

function drawPanel(onSave, initial) {
  const wrap = document.createElement('div')
  wrap.className = 'draw-studio'
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  canvas.className = 'logo-canvas'
  const g = canvas.getContext('2d')
  g.fillStyle = '#fff7ef'
  g.fillRect(0, 0, 256, 256)
  if (safeLogo(initial)) {
    const img = new Image()
    img.onload = () => g.drawImage(img, 0, 0, 256, 256)
    img.src = initial
  }
  let tool = 'brush'
  let color = '#ff6a1a'
  let size = 8
  let drawing = false
  let last = null
  const undo = []
  function snapshot() {
    undo.push(g.getImageData(0, 0, 256, 256))
    if (undo.length > 12) undo.shift()
  }
  canvas.addEventListener('pointerdown', (e) => {
    snapshot()
    drawing = true
    canvas.setPointerCapture(e.pointerId)
    last = pos(e)
    stamp(last)
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return
    const p = pos(e)
    if (tool === 'line' || tool === 'rect' || tool === 'circle') return
    stroke(last, p)
    last = p
  })
  canvas.addEventListener('pointerup', (e) => {
    if (!drawing) return
    const p = pos(e)
    if (tool === 'line') {
      g.strokeStyle = color
      g.lineWidth = size
      g.beginPath()
      g.moveTo(last.x, last.y)
      g.lineTo(p.x, p.y)
      g.stroke()
    } else if (tool === 'rect') {
      g.strokeStyle = color
      g.lineWidth = size
      g.strokeRect(last.x, last.y, p.x - last.x, p.y - last.y)
    } else if (tool === 'circle') {
      g.strokeStyle = color
      g.lineWidth = size
      g.beginPath()
      g.arc(last.x, last.y, Math.hypot(p.x - last.x, p.y - last.y), 0, Math.PI * 2)
      g.stroke()
    }
    drawing = false
  })
  function pos(e) {
    const r = canvas.getBoundingClientRect()
    return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height }
  }
  function stamp(p) {
    g.fillStyle = tool === 'eraser' ? '#fff7ef' : color
    g.beginPath()
    g.arc(p.x, p.y, size / 2, 0, Math.PI * 2)
    g.fill()
  }
  function stroke(a, b) {
    g.strokeStyle = tool === 'eraser' ? '#fff7ef' : color
    g.lineWidth = size
    g.lineCap = 'round'
    g.beginPath()
    g.moveTo(a.x, a.y)
    g.lineTo(b.x, b.y)
    g.stroke()
  }
  const tools = document.createElement('div')
  tools.className = 'tool-row'
  for (const [id, label] of [['brush', 'Brush'], ['eraser', 'Eraser'], ['line', 'Line'], ['rect', 'Square'], ['circle', 'Circle']]) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.addEventListener('click', () => { tool = id })
    tools.append(b)
  }
  const colors = document.createElement('div')
  colors.className = 'swatches'
  for (const c of COLORS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'swatch'
    b.style.background = c
    b.addEventListener('click', () => { color = c })
    colors.append(b)
  }
  const sizeInput = document.createElement('input')
  sizeInput.type = 'range'
  sizeInput.min = '2'
  sizeInput.max = '28'
  sizeInput.value = '8'
  sizeInput.addEventListener('input', () => { size = Number(sizeInput.value) })
  const actions = document.createElement('div')
  actions.className = 'row-actions'
  const undoBtn = document.createElement('button')
  undoBtn.type = 'button'
  undoBtn.textContent = 'Undo'
  undoBtn.addEventListener('click', () => {
    const prev = undo.pop()
    if (prev) g.putImageData(prev, 0, 0)
  })
  const clear = document.createElement('button')
  clear.type = 'button'
  clear.textContent = 'Clear'
  clear.addEventListener('click', () => {
    snapshot()
    g.fillStyle = '#fff7ef'
    g.fillRect(0, 0, 256, 256)
  })
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'primary'
  save.textContent = 'Use this logo'
  save.addEventListener('click', () => onSave(canvas.toDataURL('image/png')))
  actions.append(undoBtn, clear, save)
  wrap.append(canvas, tools, colors, sizeInput, actions)
  return wrap
}

function uploadPanel(onSave) {
  const wrap = document.createElement('div')
  wrap.className = 'stack'
  const hint = document.createElement('p')
  hint.textContent = 'PNG, JPEG, WEBP, or GIF under 5 MB. It is resized on this device before it is saved.'
  const file = document.createElement('input')
  file.type = 'file'
  file.accept = 'image/png,image/jpeg,image/webp,image/gif'
  const preview = document.createElement('canvas')
  preview.width = 256
  preview.height = 256
  preview.className = 'logo-canvas'
  const note = document.createElement('p')
  note.className = 'error'
  file.addEventListener('change', () => {
    note.textContent = ''
    const item = file.files && file.files[0]
    if (!item) return
    if (!/^image\/(png|jpeg|webp|gif)$/.test(item.type)) {
      note.textContent = 'Use a PNG, JPEG, WEBP, or GIF.'
      return
    }
    if (item.size > 5 * 1024 * 1024) {
      note.textContent = 'That file is over 5 MB.'
      return
    }
    const url = URL.createObjectURL(item)
    const img = new Image()
    img.onload = () => {
      const g = preview.getContext('2d')
      g.fillStyle = '#fff7ef'
      g.fillRect(0, 0, 256, 256)
      const scale = Math.max(256 / img.width, 256 / img.height)
      const w = img.width * scale
      const h = img.height * scale
      g.drawImage(img, (256 - w) / 2, (256 - h) / 2, w, h)
      URL.revokeObjectURL(url)
    }
    img.onerror = () => { note.textContent = 'Could not read that image.' }
    img.src = url
  })
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'primary'
  save.textContent = 'Use this photo'
  save.addEventListener('click', () => onSave(preview.toDataURL('image/jpeg', 0.82)))
  wrap.append(hint, file, preview, note, save)
  return wrap
}

function makerPanel(onSave) {
  const wrap = document.createElement('div')
  wrap.className = 'stack'
  const hint = document.createElement('p')
  hint.textContent = 'Describe it in a few words. Try “orange bolt ducks” or “blue star pond”. Shapes, colors, and a short name are picked from the words. No image service is called.'
  const input = document.createElement('input')
  input.maxLength = 48
  input.placeholder = 'orange bolt ducks'
  input.value = 'orange duck'
  const preview = document.createElement('img')
  preview.className = 'logo-preview'
  preview.alt = 'Logo preview'
  function refresh() {
    preview.src = emblemFromWords(input.value)
  }
  input.addEventListener('input', refresh)
  refresh()
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'primary'
  save.textContent = 'Use this emblem'
  save.addEventListener('click', () => onSave(preview.src))
  wrap.append(hint, input, preview, save)
  return wrap
}
