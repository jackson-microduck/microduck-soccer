import crypto from 'crypto'

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 32).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false
  const [salt, hash] = stored.split(':')
  if (!salt || !hash || hash.length !== 64) return false
  const test = crypto.scryptSync(password, salt, 32)
  const left = Buffer.from(hash, 'hex')
  if (left.length !== test.length) return false
  return crypto.timingSafeEqual(left, test)
}

export function randomToken() {
  return crypto.randomBytes(32).toString('hex')
}

export function randomCode(len = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

const COLORS = new Set(['#ff6a1a', '#2f8cff', '#7bd15c', '#c084fc', '#ffb000', '#1c2430'])

export function cleanColor(value) {
  const color = String(value || '').toLowerCase()
  return COLORS.has(color) ? color : '#ff6a1a'
}

export function cleanUsername(value) {
  const name = String(value || '').trim()
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return null
  return name
}

// Returns the canonical data URL string, null to clear, or false when the
// upload is not a small PNG/JPEG. Never a boolean true: node:sqlite cannot bind booleans.
export function validLogo(dataUrl) {
  if (dataUrl == null || dataUrl === '') return null
  if (typeof dataUrl !== 'string') return false
  const trimmed = dataUrl.trim()
  if (trimmed.length > 1_500_000) return false
  const match = /^data:image\/(png|jpe?g)(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed)
  if (!match) return false
  const b64 = match[2].replace(/\s+/g, '')
  let buf
  try {
    buf = Buffer.from(b64, 'base64')
  } catch {
    return false
  }
  if (buf.length < 32 || buf.length > 1_000_000) return false
  const kind = match[1].toLowerCase()
  const png = kind === 'png' && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  const jpeg = kind !== 'png' && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
  if (!png && !jpeg) return false
  return `data:image/${png ? 'png' : 'jpeg'};base64,${b64}`
}
