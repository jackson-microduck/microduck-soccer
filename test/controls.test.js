import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { cameraMove } from '../public/shared/game.js'

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
