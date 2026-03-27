import type { TrackingDTO } from '../domain/tracking.dto'

const FINGERTIP_INDICES = [4, 8, 12, 16, 20]
const GRAVITY = 120 // px/s²
const MAX_PARTICLES = 200
const SPAWN_CHANCE = 0.4 // per fingertip per frame

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

  update(tracking: TrackingDTO, canvasW: number, canvasH: number, nowMs: number): void {
    const dt = this.lastTime === 0 ? 0.016 : Math.min((nowMs - this.lastTime) / 1000, 0.05)
    this.lastTime = nowMs

    // Spawn new particles at each detected fingertip
    if (tracking.hand?.hands) {
      for (const hand of tracking.hand.hands) {
        for (const idx of FINGERTIP_INDICES) {
          const lm = hand.landmarks[idx]
          if (!lm) continue
          if (Math.random() > SPAWN_CHANCE) continue
          if (this.particles.length >= MAX_PARTICLES) break

          // Flip X to match CSS-mirrored video display
          const x = (1 - lm.x) * canvasW
          const y = lm.y * canvasH
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

    // Remove expired
    this.particles = this.particles.filter(p => p.life > 0)
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
