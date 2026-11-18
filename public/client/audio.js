let ctx

function context() {
  if (!ctx) ctx = new AudioContext()
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

function tone(freq, dur, type, gain, slide) {
  const ac = context()
  const t = ac.currentTime
  const osc = ac.createOscillator()
  const amp = ac.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, slide), t + dur)
  amp.gain.setValueAtTime(gain, t)
  amp.gain.exponentialRampToValueAtTime(0.001, t + dur)
  osc.connect(amp)
  amp.connect(ac.destination)
  osc.start(t)
  osc.stop(t + dur + 0.02)
}

export function unlockAudio() {
  try { context() } catch { /* autoplay can wait for a tap */ }
}

export function playKick() {
  tone(180, 0.12, 'triangle', 0.08, 70)
}

export function playWhistle() {
  tone(880, 0.18, 'sine', 0.05, 990)
  setTimeout(() => tone(990, 0.22, 'sine', 0.05, 880), 180)
}

export function playGoal() {
  tone(523, 0.16, 'triangle', 0.07, 659)
  setTimeout(() => tone(659, 0.16, 'triangle', 0.07, 784), 140)
  setTimeout(() => tone(784, 0.28, 'triangle', 0.07, 1046), 280)
}

export function playQuack() {
  tone(700, 0.08, 'square', 0.03, 320)
  setTimeout(() => tone(520, 0.1, 'square', 0.03, 240), 90)
}

export function playTap() {
  tone(440, 0.05, 'sine', 0.03, 660)
}
