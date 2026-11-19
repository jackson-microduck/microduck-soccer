import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { cameraMove, integrateMover } from '../public/shared/game.js'

function cameraBasis(yaw) {
  const cam = new THREE.PerspectiveCamera(52, 1, 0.05, 40)
  cam.position.set(-Math.sin(yaw) * 1.35, 0.78, -Math.cos(yaw) * 1.35)
  cam.lookAt(Math.sin(yaw) * 0.35, 0.14, Math.cos(yaw) * 0.35)
  cam.updateMatrixWorld()
  const dir = new THREE.Vector3()
  cam.getWorldDirection(dir)
  const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0)
  return { dir, right }
}

test('W moves away from the camera and D moves to screen right', () => {
  for (const yaw of [0, Math.PI / 2, Math.PI, -1]) {
    const { dir, right } = cameraBasis(yaw)
    const forward = cameraMove(yaw, 1, 0)
    const screenRight = cameraMove(yaw, 0, 1)
    const screenLeft = cameraMove(yaw, 0, -1)
    assert.ok(forward.mx * dir.x + forward.mz * dir.z > 0.9, `forward yaw ${yaw}`)
    assert.ok(screenRight.mx * right.x + screenRight.mz * right.z > 0.9, `right yaw ${yaw}`)
    assert.ok(screenLeft.mx * right.x + screenLeft.mz * right.z < -0.9, `left yaw ${yaw}`)
  }
})

test('holding one direction runs straight instead of circling', () => {
  function run(forward, strafe) {
    const p = {
      id: '1', team: 'A', x: 0, z: 0, yaw: 0.4, vx: 0, vz: 0,
      cmd: { mx: 0, mz: 0, sprint: false, sens: 1 },
      stun: 0, slideT: 0, diving: 0, spinning: 0, spinCd: 0, slideCd: 0,
      diveCd: 0, pickupLock: 0, kickT: 0, sprinting: false, stamina: 100,
    }
    let cam = p.yaw
    const match = { phase: 'play', ball: { owner: null }, celebrateTeam: null }
    for (let i = 0; i < 180; i++) {
      const moving = Math.hypot(p.cmd.mx, p.cmd.mz) > 0.05
      if (!moving) cam = p.yaw
      const wish = cameraMove(cam, forward, strafe)
      p.cmd.mx = wish.mx
      p.cmd.mz = wish.mz
      integrateMover(p, 1 / 60, match)
    }
    return { x: p.x, z: p.z, yaw: p.yaw }
  }
  function axes(end) {
    const yaw = 0.4
    const along = end.x * Math.sin(yaw) + end.z * Math.cos(yaw)
    const side = end.x * Math.cos(yaw) - end.z * Math.sin(yaw)
    return { along, side }
  }
  const north = axes(run(1, 0))
  const south = axes(run(-1, 0))
  const east = axes(run(0, 1))
  const west = axes(run(0, -1))
  assert.ok(north.along > 2 && Math.abs(north.side) < 0.35, JSON.stringify(north))
  assert.ok(south.along < -2 && Math.abs(south.side) < 0.35, JSON.stringify(south))
  assert.ok(Math.abs(east.along) < 0.35 && east.side < -2, JSON.stringify(east))
  assert.ok(Math.abs(west.along) < 0.35 && west.side > 2, JSON.stringify(west))
})
