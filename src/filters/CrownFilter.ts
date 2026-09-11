// three/webgpu, not three: the native app renders the identical scene through
// three's WebGPU backend, and comparing a WebGL crown against a WebGPU one
// measures the graphics API rather than the platform (NF4). WebGPURenderer falls
// back to a WebGL backend on its own where WebGPU is unavailable, so this still
// runs on older Safari — and the backend it actually chose is reported below and
// submitted with the session.
import * as THREE from 'three/webgpu'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { projectNormalized, type ViewGeometry } from '../render/coordinates'
import type { TrackingDTO } from '../domain/tracking.dto'

const FOREHEAD_TOP = 10
const FACE_LEFT = 234
const FACE_RIGHT = 454
const LEFT_EYE_OUTER = 33
const RIGHT_EYE_OUTER = 263
const NOSE_TIP = 1
const CHIN = 152

// Neutral ratio: nose Y is ~38% of face height below the eye midpoint when looking straight
const NEUTRAL_NOSE_RATIO = 0.38

export class CrownFilter {
  private renderer: THREE.WebGPURenderer
  private scene: THREE.Scene
  private camera: THREE.OrthographicCamera
  private crown: THREE.Object3D | null = null
  private loaded = false
  private ready = false
  private pendingSize: { width: number; height: number } | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGPURenderer({ canvas, alpha: true, antialias: true })
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 2.2

    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1000, 1000)

    // The WebGPU backend needs an async init before it can draw. Rendering is
    // skipped until it resolves rather than queued, so a slow init costs a few
    // frames of crown and nothing else.
    this.renderer.init().then(
      () => {
        this.ready = true
        if (this.pendingSize) {
          this.resize(this.pendingSize.width, this.pendingSize.height)
          this.pendingSize = null
        }
      },
      (e: unknown) => {
        console.error('[CrownFilter] renderer init failed:', e)
      },
    )

    this.scene.add(new THREE.AmbientLight(0xffffff, 5.0))
    const front = new THREE.DirectionalLight(0xfffbe8, 6.0)
    front.position.set(0, 1, 6)
    this.scene.add(front)
    const topLight = new THREE.DirectionalLight(0xffffff, 4.0)
    topLight.position.set(0, 6, 2)
    this.scene.add(topLight)
    const rimL = new THREE.DirectionalLight(0xffd700, 3.0)
    rimL.position.set(-4, 2, 3)
    this.scene.add(rimL)
    const rimR = new THREE.DirectionalLight(0xffd700, 3.0)
    rimR.position.set(4, 2, 3)
    this.scene.add(rimR)

    const loader = new GLTFLoader()
    loader.load('/filters/crown.glb', (gltf) => {
      this.crown = gltf.scene
      // Clip world Z > 0 so the back half of the crown — the part a real head
      // would hide — is invisible. three's WebGPU backend reads clipping from a
      // ClippingGroup rather than from the renderer, which is where WebGLRenderer
      // took it.
      const clipping = new THREE.ClippingGroup()
      clipping.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)]
      clipping.add(this.crown)
      this.scene.add(clipping)
      this.loaded = true
    })
  }

  /** Which backend three actually chose — submitted with the session. */
  backend(): 'webgpu' | 'webgl' | 'pending' {
    if (!this.ready) return 'pending'
    const backend = (this.renderer as unknown as { backend?: { isWebGLBackend?: boolean } }).backend
    return backend?.isWebGLBackend ? 'webgl' : 'webgpu'
  }

  resize(width: number, height: number): void {
    if (!this.ready) {
      this.pendingSize = { width, height }
      return
    }
    this.renderer.setSize(width, height, false)
    this.camera.left = 0
    this.camera.right = width
    this.camera.top = height
    this.camera.bottom = 0
    this.camera.near = -1000
    this.camera.far = 1000
    this.camera.updateProjectionMatrix()
  }

  render(tracking: TrackingDTO, geometry: ViewGeometry): void {
    if (!this.ready || !this.loaded || !this.crown) return
    const face = tracking.face?.faces[0]
    if (!face || face.landmarks.length === 0) {
      this.renderer.clear()
      return
    }

    const lms = face.landmarks
    const top  = lms[FOREHEAD_TOP]
    const fl   = lms[FACE_LEFT]
    const fr   = lms[FACE_RIGHT]
    const el   = lms[LEFT_EYE_OUTER]
    const er   = lms[RIGHT_EYE_OUTER]
    const nose = lms[NOSE_TIP]
    const chin = lms[CHIN]
    if (!top || !fl || !fr || !el || !er || !nose || !chin) return

    // Placement and size go through the shared projection, which owns mirroring
    // and object-fit. Head pose below stays in raw normalized space, where the
    // mirroring has not been applied yet — keeping the two apart is what makes
    // the rotation signs below stable.
    const pTop   = projectNormalized(top.x, top.y, geometry)
    const pLeft  = projectNormalized(fl.x, fl.y, geometry)
    const pRight = projectNormalized(fr.x, fr.y, geometry)

    const faceWidthPx = Math.hypot(pRight.x - pLeft.x, pRight.y - pLeft.y)
    const scaleFactor = (faceWidthPx / 2) * 1.2

    // ── Position ────────────────────────────────────────────────────────────
    // projectNormalized returns top-down CSS pixels; the orthographic camera is
    // Y-up, so flip Y into its space.
    const cx = pTop.x
    const foreheadY = geometry.viewHeight - pTop.y
    const cy = foreheadY + 0.34 * scaleFactor   // base ring sits at forehead landmark

    // ── Roll (Z rotation) ────────────────────────────────────────────────────
    // rawRoll < 0 when head tilts right (person's right ear down).
    // rotation.z = rawRoll → CW → display-right side of crown goes down → correct.
    // Aspect-corrected so this is a real on-screen angle rather than an angle in
    // the unit square. Raw (unmirrored) coordinates, per the note above.
    const roll = Math.atan2(
      (er.y - el.y) * geometry.frameHeight,
      (er.x - el.x) * geometry.frameWidth,
    )

    // ── Yaw (Y rotation) ─────────────────────────────────────────────────────
    // When face turns LEFT in display the nose moves RIGHT in raw-video space
    // (nose.x increases). (nose.x - faceCenterX) > 0 → positive yaw → right
    // side of crown rotates toward +Z (clipped), left side comes forward.
    const faceCenterX = (el.x + er.x) / 2
    const yaw = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2,
      (nose.x - faceCenterX) * 8
    ))

    // ── Pitch (X rotation) ────────────────────────────────────────────────────
    // Nose-below-eye ratio increases when looking down.
    // Negative pitch → crown top tilts toward camera so the crown leans forward
    // and the back spikes enter +Z where the clip plane removes them.
    const faceHeight = chin.y - top.y
    const eyeMidY = (el.y + er.y) / 2
    const noseRatio = faceHeight > 0.01
      ? (nose.y - eyeMidY) / faceHeight
      : NEUTRAL_NOSE_RATIO
    const pitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 3,
      -(noseRatio - NEUTRAL_NOSE_RATIO) * Math.PI
    ))

    // ── Apply ────────────────────────────────────────────────────────────────
    this.crown.position.set(cx, cy, 0)
    this.crown.rotation.set(pitch, yaw, roll)
    this.crown.scale.setScalar(scaleFactor)

    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.renderer.dispose()
  }
}
