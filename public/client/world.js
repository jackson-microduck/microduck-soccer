import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { DRIBBLE, integrateMover } from '/shared/game.js'

const SPIN_Q = new THREE.Quaternion()
const BAKE_Q = new THREE.Quaternion()
const AXIS_Z = new THREE.Vector3(0, 0, 1)
const MATS = new Map()

const OMIT = /pcb|bearing|banana|motor_support|speaker|elec_rpi/
const ACCENT = /foot_|ankle_|sole_|bottom_head|jaw|soft_mouth/

let rigPromise

function loadRig() {
  if (!rigPromise) {
    rigPromise = Promise.all([
      new GLTFLoader().loadAsync('/assets/microduck.glb'),
      fetch('/assets/kinematics.json').then((r) => r.json()),
    ]).then(([gltf, kin]) => {
      const geoms = new Map()
      gltf.scene.traverse((obj) => {
        if (obj.isMesh && obj.geometry) {
          obj.geometry.computeVertexNormals()
          geoms.set(obj.name.replace(/\./g, '').toLowerCase(), obj.geometry)
        }
      })
      return { geoms, kin }
    })
  }
  return rigPromise
}

function surface(color, rough, simple) {
  const key = `${simple ? 'L' : 'S'}|${rough}|${color}`
  let mat = MATS.get(key)
  if (mat) return mat
  mat = simple
    ? new THREE.MeshLambertMaterial({ color })
    : new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.06 })
  MATS.set(key, mat)
  return mat
}

function sameLayout(list) {
  const names = Object.keys(list[0].attributes).sort().join(',')
  const indexed = list[0].index != null
  return list.every((geo) => (geo.index != null) === indexed && Object.keys(geo.attributes).sort().join(',') === names)
}

function colorFor(mesh, accent) {
  if (ACCENT.test(mesh)) return accent
  if (/noenoeil/.test(mesh)) return '#ffb000'
  if (/lens|np_f970|power_support/.test(mesh)) return '#14161c'
  if (/xl330|yaw|hip_l|neck|face_part/.test(mesh)) return '#3c404a'
  return '#f6f3ec'
}

function pose(anim, t) {
  const a = {
    left_hip_pitch: 0,
    right_hip_pitch: 0,
    left_knee: 0.12,
    right_knee: 0.12,
    left_ankle: -0.08,
    right_ankle: -0.08,
    left_hip_roll: 0,
    right_hip_roll: 0,
    left_hip_yaw: 0,
    right_hip_yaw: 0,
    neck_pitch: 0.08,
    head_pitch: -0.06,
    head_yaw: 0,
    head_roll: 0,
  }
  const body = { pitch: 0, roll: 0, drop: 0, extraYaw: 0 }
  const s = Math.sin(t * (anim === 'sprint' ? 12 : 8))
  if (anim === 'walk' || anim === 'sprint') {
    const amp = anim === 'sprint' ? 0.7 : 0.48
    a.left_hip_pitch = amp * s
    a.right_hip_pitch = -amp * s
    a.left_knee = 0.15 + Math.max(0, -s) * 0.85
    a.right_knee = 0.15 + Math.max(0, s) * 0.85
    a.left_ankle = -0.12 - a.left_knee * 0.25
    a.right_ankle = -0.12 - a.right_knee * 0.25
    a.neck_pitch = 0.12
    body.roll = s * 0.04
  } else if (anim === 'kick') {
    const u = Math.sin(Math.min(1, t / 0.36) * Math.PI)
    a.right_hip_pitch = -1.05 * u
    a.right_knee = 0.15 + 0.35 * (1 - u)
    a.left_knee = 0.35
    a.left_hip_pitch = 0.25
    a.neck_pitch = -0.1
  } else if (anim === 'slide') {
    body.pitch = 1.05
    body.drop = -0.04
    a.left_knee = 0.9
    a.right_knee = 0.7
    a.left_hip_pitch = -0.5
    a.right_hip_pitch = -0.2
    a.head_pitch = 0.3
  } else if (anim === 'dive') {
    body.roll = 1.15
    body.pitch = 0.45
    body.drop = -0.05
    a.left_knee = 0.4
    a.right_knee = 0.5
  } else if (anim === 'fall') {
    const u = Math.min(1, t / 0.28)
    body.pitch = 1.25 * u
    body.drop = -0.06 * u
    a.left_knee = 1.1 * u
    a.right_knee = 1.1 * u
    a.left_hip_pitch = -0.6 * u
    a.right_hip_pitch = -0.6 * u
  } else if (anim === 'getup') {
    const u = Math.max(0, 1 - t / 0.4)
    body.pitch = 1.1 * u
    body.drop = -0.05 * u
    a.left_knee = 0.9 * u + 0.12
    a.right_knee = 0.9 * u + 0.12
  } else if (anim === 'spin') {
    a.head_roll = Math.sin(t * 30) * 0.2
    a.neck_pitch = -0.15
    body.extraYaw = 0
  } else if (anim === 'quack') {
    a.head_pitch = 0.15 + Math.abs(Math.sin(t * 16)) * 0.55
    a.head_yaw = Math.sin(t * 8) * 0.35
    a.neck_pitch = -0.15 + Math.sin(t * 8) * 0.15
    body.drop = Math.abs(Math.sin(t * 8)) * -0.02
  } else if (anim === 'bob') {
    a.neck_pitch = Math.sin(t * 7) * 0.45
    a.head_pitch = Math.sin(t * 7 + 0.4) * 0.25
  } else if (anim === 'sit') {
    const k = 0.5 - 0.5 * Math.cos(Math.min(t, 1.2) * 4)
    a.left_knee = 1.25 * k
    a.right_knee = 1.25 * k
    a.left_hip_pitch = -0.85 * k
    a.right_hip_pitch = -0.85 * k
    a.left_ankle = 0.4 * k
    a.right_ankle = 0.4 * k
    body.drop = -0.055 * k
    a.neck_pitch = 0.2 * k
  } else if (anim === 'glide') {
    body.roll = Math.sin(t * 4) * 0.35
    a.left_hip_roll = 0.2
    a.right_hip_roll = -0.2
    a.left_knee = 0.25
    a.right_knee = 0.25
    a.neck_pitch = -0.1
  } else {
    a.neck_pitch = 0.06 + Math.sin(t * 2) * 0.04
    a.head_yaw = Math.sin(t * 0.8) * 0.12
  }
  return { joints: a, body }
}

function buildDuck(geoms, kin, accent, team, name, goalie, simple) {
  const root = new THREE.Group()
  const tilt = new THREE.Group()
  root.add(tilt)
  const native = new THREE.Group()
  native.rotation.x = -Math.PI / 2
  tilt.add(native)
  const groups = new Map()
  const joints = new Map()
  for (const body of kin.bodies) {
    const g = new THREE.Group()
    g.position.set(body.pos[0], body.pos[1], body.pos[2])
    const [w, x, y, z] = body.quat
    g.userData.base = new THREE.Quaternion(x, y, z, w)
    g.quaternion.copy(g.userData.base)
    groups.set(body.name, g)
    if (body.joint) joints.set(body.joint.name, g)
    const buckets = new Map()
    for (const geom of body.geoms || []) {
      if (OMIT.test(geom.mesh)) continue
      const src = geoms.get(geom.mesh.replace(/\./g, '').toLowerCase())
      if (!src) continue
      const mat = surface(colorFor(geom.mesh, accent), 0.58, simple)
      const baked = src.clone()
      const [gw, gx, gy, gz] = geom.quat
      BAKE_Q.set(gx, gy, gz, gw)
      baked.applyQuaternion(BAKE_Q)
      baked.translate(geom.pos[0], geom.pos[1], geom.pos[2])
      const list = buckets.get(mat)
      if (list) list.push(baked)
      else buckets.set(mat, [baked])
    }
    for (const [mat, list] of buckets) {
      if (list.length === 1) {
        g.add(new THREE.Mesh(list[0], mat))
        continue
      }
      const merged = sameLayout(list) ? mergeGeometries(list, false) : null
      if (!merged) {
        for (const one of list) g.add(new THREE.Mesh(one, mat))
      } else {
        g.add(new THREE.Mesh(merged, mat))
      }
    }
  }
  for (const body of kin.bodies) {
    const g = groups.get(body.name)
    if (body.parent && groups.get(body.parent)) groups.get(body.parent).add(g)
    else native.add(g)
  }
  const sash = new THREE.Mesh(
    new THREE.CylinderGeometry(0.042, 0.046, 0.03, 14),
    surface(team === 'A' ? '#ff7a2e' : '#3c92ff', 0.45, simple),
  )
  sash.position.y = 0.145
  tilt.add(sash)
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.16, 20),
    new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.18 }),
  )
  shadow.rotation.x = -Math.PI / 2
  shadow.position.y = 0.012
  root.add(shadow)
  root.add(makeLabel(name, team, goalie))
  return {
    root,
    tilt,
    joints,
    apply(anim, time, yaw) {
      const posed = pose(anim, time)
      for (const [name, group] of joints) {
        const angle = posed.joints[name] || 0
        SPIN_Q.setFromAxisAngle(AXIS_Z, angle)
        group.quaternion.copy(group.userData.base).multiply(SPIN_Q)
      }
      tilt.rotation.x = posed.body.pitch
      tilt.rotation.z = posed.body.roll
      tilt.position.y = posed.body.drop
      root.rotation.y = yaw - Math.PI / 2 + posed.body.extraYaw
    },
  }
}

function makeLabel(name, team, goalie) {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const g = canvas.getContext('2d')
  g.fillStyle = team === 'A' ? '#ff7a2e' : '#3c92ff'
  roundRect(g, 16, 10, 224, 44, 16)
  g.fill()
  g.fillStyle = '#fff'
  g.font = '700 26px Nunito, Trebuchet MS, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  const text = `${goalie ? 'GK ' : ''}${name}`.slice(0, 14)
  g.fillText(text, 128, 32)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }))
  sprite.position.y = 0.36
  sprite.scale.set(0.3, 0.075, 1)
  return sprite
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath()
  g.moveTo(x + r, y)
  g.arcTo(x + w, y, x + w, y + h, r)
  g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r)
  g.arcTo(x, y, x + w, y, r)
  g.closePath()
}

function grassTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const g = canvas.getContext('2d')
  g.fillStyle = '#3c9a45'
  g.fillRect(0, 0, 128, 128)
  for (let y = 0; y < 8; y++) {
    g.fillStyle = y % 2 ? '#348a3d' : '#46a84f'
    g.fillRect(0, y * 16, 128, 16)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function ballTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const g = canvas.getContext('2d')
  g.fillStyle = '#f7f7f7'
  g.fillRect(0, 0, 128, 128)
  g.fillStyle = '#1a1a1a'
  for (const [x, y] of [[64, 28], [28, 64], [100, 64], [46, 100], [82, 100]]) {
    g.beginPath()
    g.moveTo(x, y - 12)
    g.lineTo(x + 11, y - 4)
    g.lineTo(x + 7, y + 10)
    g.lineTo(x - 7, y + 10)
    g.lineTo(x - 11, y - 4)
    g.closePath()
    g.fill()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function buildField(length, width, goalW, goalH, simple) {
  const group = new THREE.Group()
  const tex = grassTexture()
  tex.repeat.set(width / 0.9, length / 0.9)
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(width, length),
    simple
      ? new THREE.MeshLambertMaterial({ map: tex })
      : new THREE.MeshStandardMaterial({ map: tex, roughness: 0.86 }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.receiveShadow = true
  group.add(floor)
  const lineMat = new THREE.MeshBasicMaterial({ color: '#fffaf3' })
  const line = (w, h, x, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), lineMat)
    m.rotation.x = -Math.PI / 2
    m.position.set(x, 0.008, z)
    group.add(m)
  }
  line(width - 0.2, 0.025, 0, 0)
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.48, 40), lineMat)
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.008
  group.add(ring)
  const boxD = 0.85
  const boxW = Math.min(width - 0.6, goalW + 0.9)
  for (const sign of [-1, 1]) {
    const z = sign * (length / 2 - boxD / 2 - 0.02)
    line(boxW, 0.025, 0, sign * (length / 2 - boxD))
    line(0.025, boxD, -boxW / 2, z)
    line(0.025, boxD, boxW / 2, z)
  }
  const wallMat = surface('#f7f4ee', 0.9, simple)
  const wallH = 0.55
  const thick = 0.08
  const hl = length / 2
  const hw = width / 2
  const addWall = (w, h, d, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat)
    m.position.set(x, y, z)
    group.add(m)
  }
  addWall(thick, wallH, length, -hw - thick / 2, wallH / 2, 0)
  addWall(thick, wallH, length, hw + thick / 2, wallH / 2, 0)
  const gap = goalW + 0.06
  const span = (width + thick * 2 - gap) / 2
  for (const sign of [-1, 1]) {
    const zWall = sign * (hl + thick / 2)
    addWall(span, wallH, thick, -(width / 2) + span / 2, wallH / 2, zWall)
    addWall(span, wallH, thick, width / 2 - span / 2, wallH / 2, zWall)
    const lintel = wallH - goalH
    if (lintel > 0.02) addWall(gap, lintel, thick, 0, goalH + lintel / 2, zWall)
    group.add(buildGoal(sign * hl, goalW, goalH, sign, simple))
  }
  return group
}

function buildGoal(z, goalW, goalH, sign, simple) {
  const g = new THREE.Group()
  const white = surface('#f4f7fb', 0.35, simple)
  const post = (x) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.03, goalH, 0.03), white)
    m.position.set(x, goalH / 2, z)
    return m
  }
  g.add(post(-goalW / 2), post(goalW / 2))
  const bar = new THREE.Mesh(new THREE.BoxGeometry(goalW + 0.03, 0.03, 0.03), white)
  bar.position.set(0, goalH, z)
  g.add(bar)
  const depth = 0.34
  const backZ = z + sign * depth
  const solid = surface('#e8eef5', 0.55, simple)
  const back = new THREE.Mesh(new THREE.BoxGeometry(goalW, goalH, 0.03), solid)
  back.position.set(0, goalH / 2, backZ)
  g.add(back)
  for (const x of [-goalW / 2, goalW / 2]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.03, goalH, depth), solid)
    side.position.set(x, goalH / 2, z + sign * depth / 2)
    g.add(side)
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(goalW, 0.03, depth), solid)
  roof.position.set(0, goalH, z + sign * depth / 2)
  g.add(roof)
  return g
}

export function graphicsIsLow() {
  const saved = localStorage.getItem('md-graphics')
  if (saved === 'low') return true
  if (saved === 'high') return false
  const coarse = matchMedia('(pointer: coarse)').matches
  const small = Math.min(window.innerWidth || 1200, window.innerHeight || 800) < 700
  return coarse && small
}

function phoneScreen() {
  return matchMedia('(pointer: coarse)').matches && Math.min(window.innerWidth || 1200, window.innerHeight || 800) < 900
}

function pixelCap(low) {
  return low || phoneScreen() ? 1 : Math.min(window.devicePixelRatio || 1, 2)
}

function makeRenderer(canvas, low) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !low,
    alpha: true,
    powerPreference: low ? 'low-power' : 'high-performance',
  })
  renderer.setPixelRatio(pixelCap(low))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  return renderer
}

function retint(root, low) {
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material || obj.material.isMeshBasicMaterial) return
    const prev = obj.material
    if (low && prev.isMeshLambertMaterial) return
    if (!low && prev.isMeshStandardMaterial) return
    obj.material = low
      ? new THREE.MeshLambertMaterial({
        color: prev.color.clone(),
        map: prev.map,
        transparent: prev.transparent,
        opacity: prev.opacity,
        side: prev.side,
      })
      : new THREE.MeshStandardMaterial({
        color: prev.color.clone(),
        map: prev.map,
        roughness: 0.58,
        metalness: 0.06,
        transparent: prev.transparent,
        opacity: prev.opacity,
        side: prev.side,
      })
  })
}

export async function createWorld(canvas) {
  let simple = graphicsIsLow()
  let renderer = makeRenderer(canvas, simple)
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#d7ecff')
  scene.fog = new THREE.Fog('#d7ecff', 8, 18)
  const camera = new THREE.PerspectiveCamera(52, 1, 0.05, 40)
  scene.add(new THREE.HemisphereLight('#fff6ea', '#d7b48a', 1.15))
  const sun = new THREE.DirectionalLight('#fff', 1.25)
  sun.position.set(3, 6, 2)
  scene.add(sun)
  const { geoms, kin } = await loadRig()
  let field = null
  let fieldKey = ''
  const ducks = new Map()
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.078, simple ? 12 : 20, simple ? 10 : 14),
    new THREE.MeshStandardMaterial({ map: ballTexture(), roughness: 0.45 }),
  )
  scene.add(ball)
  const ballShadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.09, 16),
    new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.16 }),
  )
  ballShadow.rotation.x = -Math.PI / 2
  scene.add(ballShadow)
  const sparks = []
  const sparkGeo = new THREE.SphereGeometry(0.03, 8, 8)
  let mode = 'demo'
  let snap = null
  let meId = null
  let orbit = 0
  let camYaw = 0
  let aimHold = 0
  const trails = new Map()
  let ballTrail = null
  let dragging = false
  let lastX = 0
  let demoT = 0
  const shown = new Map()
  let ballShown = { x: 0.35, y: 0.078, z: 0.2 }
  let pred = null
  let inputSource = null
  let aimYaw = 0
  let running = true
  let last = performance.now()

  function resize() {
    const w = canvas.clientWidth || 1
    const h = canvas.clientHeight || 1
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }

  function ensureField(spec) {
    const key = `${spec.length}:${spec.width}:${spec.goalW}:${spec.goalH}`
    if (key === fieldKey) return
    if (field) scene.remove(field)
    field = buildField(spec.length, spec.width, spec.goalW, spec.goalH, simple)
    scene.add(field)
    fieldKey = key
  }

  function ensureDuck(p) {
    let duck = ducks.get(p.id)
    if (!duck) {
      duck = buildDuck(geoms, kin, p.color || '#ff6a1a', p.team || 'A', p.name || 'Duck', !!p.goalie, simple)
      ducks.set(p.id, duck)
      scene.add(duck.root)
      shown.set(p.id, { x: p.x, z: p.z, yaw: p.yaw })
    }
    return duck
  }

  function damp(a, b, lambda, dt) {
    return a + (b - a) * (1 - Math.exp(-lambda * dt))
  }

  function dampAngle(a, b, lambda, dt) {
    let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI
    if (d < -Math.PI) d += Math.PI * 2
    return a + d * (1 - Math.exp(-lambda * dt))
  }

  function frame(now) {
    if (!running) return
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    demoT += dt
    if (mode === 'demo') {
      ensureField({ length: 7, width: 4.2, goalW: 0.42, goalH: 0.26 })
      const duck = ensureDuck({ id: 'demo', name: 'Microduck', team: 'A', color: '#ff6a1a', x: 0, z: 0, yaw: 0 })
      const anims = ['idle', 'walk', 'kick', 'spin', 'quack', 'bob', 'sit', 'glide']
      const anim = anims[Math.floor(demoT / 2.2) % anims.length]
      const yaw = demoT * 0.25
      duck.apply(anim, demoT, yaw)
      duck.root.position.set(0, 0, 0)
      ball.position.set(Math.sin(demoT) * 0.35, 0.078 + Math.abs(Math.sin(demoT * 2)) * 0.05, 0.45)
      ballShadow.position.set(ball.position.x, 0.01, ball.position.z)
      const dist = 1.05
      camera.position.set(Math.sin(yaw) * -dist, 0.62, Math.cos(yaw) * -dist)
      camera.lookAt(0.05, 0.14, 0.12)
    } else if (snap) {
      ensureField(snap.field)
      const ids = new Set(snap.players.map((p) => p.id))
      for (const [id, duck] of ducks) {
        if (!ids.has(id)) {
          scene.remove(duck.root)
          ducks.delete(id)
          shown.delete(id)
        }
      }
      const me = snap.players.find((p) => p.id === meId)
      if (me && pred) {
        if (inputSource && snap.phase === 'play') {
          const stick = inputSource()
          pred.cmd.mx = stick.mx
          pred.cmd.mz = stick.mz
          pred.cmd.sprint = !!stick.sprint
          if (Number.isFinite(stick.sens)) pred.cmd.sens = stick.sens
          if (stick.spinHold && snap.ball.owner !== meId) pred.yaw += dt * 7
        }
        pred.team = me.team
        if (snap.phase === 'countdown' || snap.phase === 'fulltime') {
          pred.x = me.x
          pred.z = me.z
          pred.yaw = me.yaw
          pred.vx = 0
          pred.vz = 0
          pred.cmd.mx = 0
          pred.cmd.mz = 0
        } else if (['idle', 'walk', 'sprint'].includes(me.anim) && snap.phase === 'play') {
          integrateMover(pred, dt, { phase: 'play', celebrateTeam: null, ball: { owner: snap.ball.owner } })
        } else {
          pred.x = me.x
          pred.z = me.z
          pred.yaw = me.yaw
          pred.vx = 0
          pred.vz = 0
        }
      }
      for (const p of snap.players) {
        const duck = ensureDuck(p)
        const view = shown.get(p.id)
        const mine = p.id === meId
        const usePred = mine && pred && snap.phase === 'play' && ['idle', 'walk', 'sprint'].includes(p.anim)
        if (usePred) {
          view.x = pred.x
          view.z = pred.z
          view.yaw = pred.yaw
        } else if (mine) {
          view.x = p.x
          view.z = p.z
          view.yaw = p.yaw
        } else if (snap.phase === 'countdown' || snap.phase === 'fulltime') {
          view.x = p.x
          view.z = p.z
          view.yaw = p.yaw
        } else {
          const tr = trails.get(p.id)
          if (tr && tr.bt > tr.at) {
            const u = Math.min(1, Math.max(0, (now - 50 - tr.at) / (tr.bt - tr.at)))
            view.x = tr.ax + (tr.bx - tr.ax) * u
            view.z = tr.az + (tr.bz - tr.az) * u
            view.yaw = dampAngle(tr.ay, tr.by, 8, u)
          } else {
            view.x = damp(view.x, p.x, 18, dt)
            view.z = damp(view.z, p.z, 18, dt)
            view.yaw = dampAngle(view.yaw, p.yaw, 16, dt)
          }
        }
        duck.root.position.set(view.x, 0, view.z)
        duck.apply(p.anim || 'idle', p.animT || demoT, view.yaw)
      }
      let bx = snap.ball.x
      let by = snap.ball.y
      let bz = snap.ball.z
      const ownBall = me && snap.ball.owner === meId && pred
      if (ownBall) {
        const hold = aimYaw
        bx = pred.x + Math.sin(hold) * DRIBBLE
        bz = pred.z + Math.cos(hold) * DRIBBLE
        by = 0.078
        ballShown.x = bx
        ballShown.y = by
        ballShown.z = bz
      } else if ((snap.phase === 'countdown' || snap.phase === 'fulltime') || !ballTrail) {
        ballShown.x = bx
        ballShown.y = by
        ballShown.z = bz
      } else if (ballTrail.bt > ballTrail.at) {
        const u = Math.min(1, Math.max(0, (now - 50 - ballTrail.at) / (ballTrail.bt - ballTrail.at)))
        ballShown.x = ballTrail.ax + (ballTrail.bx - ballTrail.ax) * u
        ballShown.y = ballTrail.ay + (ballTrail.by - ballTrail.ay) * u
        ballShown.z = ballTrail.az + (ballTrail.bz - ballTrail.az) * u
      } else {
        ballShown.x = damp(ballShown.x, bx, 22, dt)
        ballShown.y = damp(ballShown.y, by, 22, dt)
        ballShown.z = damp(ballShown.z, bz, 22, dt)
      }
      ball.position.set(ballShown.x, Math.max(0.078, ballShown.y), ballShown.z)
      ballShadow.position.set(ball.position.x, 0.01, ball.position.z)
      const follow = me ? shown.get(me.id) : null
      const face = follow ? follow.yaw : camYaw
      const moving = pred && Math.hypot(pred.cmd.mx || 0, pred.cmd.mz || 0) > 0.05
      if (!moving && performance.now() - aimHold > 600) camYaw = dampAngle(camYaw, face, 10, dt)
      aimYaw = camYaw
      const dist = 1.35
      const focus = follow || { x: snap.ball.x, z: snap.ball.z }
      camera.position.set(focus.x - Math.sin(camYaw) * dist, 0.78, focus.z - Math.cos(camYaw) * dist)
      camera.lookAt(focus.x + Math.sin(camYaw) * 0.35, 0.14, focus.z + Math.cos(camYaw) * 0.35)
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i]
      s.userData.v.y -= 4 * dt
      s.position.addScaledVector(s.userData.v, dt)
      s.userData.life -= dt
      if (s.userData.life <= 0 || s.position.y < 0.02) {
        scene.remove(s)
        sparks.splice(i, 1)
      }
    }
    renderer.render(scene, camera)
    requestAnimationFrame(frame)
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.target !== canvas || mode === 'match') return
    dragging = true
    lastX = e.clientX
  })
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return
    orbit -= (e.clientX - lastX) * 0.005
    lastX = e.clientX
  })
  window.addEventListener('pointerup', () => { dragging = false })
  window.addEventListener('resize', resize)
  resize()
  requestAnimationFrame(frame)

  return {
    get aimYaw() { return aimYaw },
    resize,
    setDemo() {
      mode = 'demo'
      snap = null
      pred = null
      for (const [id, duck] of ducks) {
        if (id === 'demo') continue
        scene.remove(duck.root)
        ducks.delete(id)
        shown.delete(id)
      }
    },
    setMatch(nextId) {
      mode = 'match'
      meId = String(nextId)
      pred = null
      orbit = 0
      camYaw = 0
    },
    pushSnap(next, input) {
      const prevBall = snap && snap.ball
      snap = next
      const nowT = performance.now()
      for (const p of next.players) {
        if (String(p.id) === meId) continue
        const prev = trails.get(p.id)
        trails.set(p.id, prev
          ? { ax: prev.bx, az: prev.bz, ay: prev.by, at: prev.bt, bx: p.x, bz: p.z, by: p.yaw, bt: nowT }
          : { ax: p.x, az: p.z, ay: p.yaw, at: nowT, bx: p.x, bz: p.z, by: p.yaw, bt: nowT })
      }
      if (next.ball) {
        const released = prevBall && prevBall.owner && !next.ball.owner
        ballTrail = !ballTrail || released
          ? { ax: next.ball.x, ay: next.ball.y, az: next.ball.z, at: nowT, bx: next.ball.x, by: next.ball.y, bz: next.ball.z, bt: nowT }
          : { ax: ballTrail.bx, ay: ballTrail.by, az: ballTrail.bz, at: ballTrail.bt, bx: next.ball.x, by: next.ball.y, bz: next.ball.z, bt: nowT }
        if (released) {
          ballShown.x = next.ball.x
          ballShown.y = next.ball.y
          ballShown.z = next.ball.z
        }
      }
      const me = next.players.find((p) => p.id === meId)
      if (!me) return
      if (!pred) {
        pred = {
          x: me.x,
          z: me.z,
          yaw: me.yaw,
          vx: me.vx,
          vz: me.vz,
          stamina: me.stamina,
          cmd: input || { mx: 0, mz: 0, sprint: false },
          stun: 0,
          slideT: 0,
          slideCd: 0,
          spinning: 0,
          spinCd: 0,
          diving: 0,
          diveCd: 0,
          pickupLock: 0,
          kickT: 0,
          sprinting: false,
          team: me.team,
          id: me.id,
        }
        camYaw = me.yaw
      }
      if (input) pred.cmd = input
      const err = Math.hypot(pred.x - me.x, pred.z - me.z)
      if (err > 0.6 || !['idle', 'walk', 'sprint'].includes(me.anim)) {
        pred.x = me.x
        pred.z = me.z
        pred.yaw = me.yaw
        pred.vx = me.vx
        pred.vz = me.vz
      }
      pred.team = me.team
      pred.stamina = me.stamina
    },
    setInput(input) {
      if (pred) pred.cmd = input
    },
    setInputSource(fn) { inputSource = fn },
    addAim(delta) { camYaw += delta; aimHold = performance.now() },
    celebrate(at) {
      const count = phoneScreen() ? 6 : 16
      for (let i = 0; i < count; i++) {
        const m = new THREE.Mesh(
          sparkGeo,
          new THREE.MeshStandardMaterial({ color: i % 2 ? '#ff6a1a' : '#ffd166', roughness: 0.4 }),
        )
        m.position.set(at?.x || 0, 0.3, at?.z || 0)
        m.userData.v = new THREE.Vector3((Math.random() - 0.5) * 1.6, 1.2 + Math.random(), (Math.random() - 0.5) * 1.6)
        m.userData.life = 1.3
        scene.add(m)
        sparks.push(m)
      }
    },
    stop() { running = false },
    setQuality(low) {
      simple = !!low
      const alias = renderer.getContext().getContextAttributes()?.antialias
      if (!!alias === simple) {
        renderer.dispose()
        renderer = makeRenderer(canvas, simple)
      } else {
        renderer.setPixelRatio(pixelCap(simple))
      }
      retint(scene, simple)
      resize()
    },
  }
}
