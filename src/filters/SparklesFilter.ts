import type { TrackingDTO } from '../domain/tracking.dto'
import { projectNormalized, type ViewGeometry } from '../render/coordinates'

const FINGERTIP_INDICES = [4, 8, 12, 16, 20]
const GRAVITY = 120 // px/s²
const MAX_PARTICLES = 150
const SPAWN_CHANCE = 0.35 // per fingertip per frame

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  size: number
}

export class SparklesFilter {
  private particles: Particle[] = []
  private img: HTMLImageElement | null = null
  private loaded = false
  private lastTime = 0

  constructor() {
    this.img = new Image()
    this.img.onload = () => { this.loaded = true }
    this.img.src = '/filters/sparkle.png'
  }

  /** Whether any particle is still alive — the reason to keep ticking when off. */
  hasParticles(): boolean {
    return this.particles.length > 0
  }

  update(tracking: TrackingDTO, geometry: ViewGeometry, nowMs: number, spawning = true): void {
    const dt = this.lastTime === 0 ? 0.016 : Math.min((nowMs - this.lastTime) / 1000, 0.05)
    this.lastTime = nowMs

    // Spawn new particles at each detected fingertip — only while the filter is
    // on. When it is off the existing particles still fall and fade out.
    if (spawning && tracking.hand?.hands) {
      for (const hand of tracking.hand.hands) {
        for (const idx of FINGERTIP_INDICES) {
          const lm = hand.landmarks[idx]
          if (!lm) continue
          if (Math.random() > SPAWN_CHANCE) continue
          if (this.particles.length >= MAX_PARTICLES) break

          // Mirroring and object-fit come from the shared projection —
          // see src/render/coordinates.ts.
          const { x, y } = projectNormalized(lm.x, lm.y, geometry)
          const maxLife = 0.6 + Math.random() * 0.6
          this.particles.push({
            x,
            y,
            vx: (Math.random() - 0.5) * 60,
            vy: -(20 + Math.random() * 40), // initial upward burst
            life: maxLife,
            maxLife,
            size: 12 + Math.random() * 12,
          })
        }
      }
    }

    // Tick existing particles
    for (const p of this.particles) {
      p.vy += GRAVITY * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.life -= dt
    }

    // Remove expired — compact in-place to avoid per-frame array allocation
    let writeIdx = 0;
    for (let i = 0; i < this.particles.length; i++) {
      if (this.particles[i].life > 0) {
        if (writeIdx !== i) this.particles[writeIdx] = this.particles[i];
        writeIdx++;
      }
    }
    this.particles.length = writeIdx;
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.loaded || !this.img) return

    for (const p of this.particles) {
      const alpha = Math.max(0, p.life / p.maxLife)
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.drawImage(this.img, p.x - p.size / 2, p.y - p.size / 2, p.size, p.size)
      ctx.restore()
    }
  }

  reset(): void {
    this.particles = []
    this.lastTime = 0
  }
}
