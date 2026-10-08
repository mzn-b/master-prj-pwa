import type { TrackingDTO } from '../domain/tracking.dto'
import { projectNormalized, type ViewGeometry } from '../render/coordinates'
import {
    particleOpacity,
    spawnParticle,
    stepParticles,
    type Particle,
} from './sparkleSystem'

const FINGERTIP_INDICES = [4, 8, 12, 16, 20]
const SPARKLE_SIZE = 18
const SPAWN_PER_TIP_PER_FRAME = 0.35
/**
 * Fixed simulation step, matching the native app's timer.
 *
 * Spawning used to happen once per *rendered* frame, so the particle count
 * scaled with display rate: roughly twice native's on a 60 Hz panel and four
 * times on a 120 Hz one. That is both a visible difference on a filter
 * participants rate and more work per second on the same nominal filter.
 * Stepping on an accumulator makes the simulation independent of frame rate,
 * which is what native gets from its interval.
 */
const TICK_MS = 33

export class SparklesFilter {
  private particles: Particle[] = []
  private img: HTMLImageElement | null = null
  private loaded = false
  private lastTime = 0
  /** Leftover time not yet consumed by a fixed step. */
  private accumulatorMs = 0

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
    const elapsed = this.lastTime === 0 ? TICK_MS : nowMs - this.lastTime
    this.lastTime = nowMs
    // Cap the catch-up so a backgrounded tab does not simulate a huge burst on
    // its first frame back.
    this.accumulatorMs = Math.min(this.accumulatorMs + elapsed, TICK_MS * 5)

    while (this.accumulatorMs >= TICK_MS) {
      this.accumulatorMs -= TICK_MS
      this.particles = stepParticles(this.particles, TICK_MS)

      // Spawn only while the filter is on; when it is off the existing
      // particles still fall and fade out.
      if (!spawning) continue
      for (const hand of tracking.hand?.hands ?? []) {
        for (const idx of FINGERTIP_INDICES) {
          const lm = hand.landmarks[idx]
          if (!lm) continue
          if (Math.random() > SPAWN_PER_TIP_PER_FRAME) continue
          // Mirroring and object-fit come from the shared projection —
          // see src/render/coordinates.ts.
          const { x, y } = projectNormalized(lm.x, lm.y, geometry)
          this.particles.push(spawnParticle(x, y))
        }
      }
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.loaded || !this.img) return

    for (const p of this.particles) {
      ctx.save()
      // Same fade curve and same fixed size as native, which draws
      // SPARKLE_SIZE square and uses particleOpacity for alpha.
      ctx.globalAlpha = particleOpacity(p)
      ctx.drawImage(
        this.img,
        p.x - SPARKLE_SIZE / 2,
        p.y - SPARKLE_SIZE / 2,
        SPARKLE_SIZE,
        SPARKLE_SIZE,
      )
      ctx.restore()
    }
  }

  reset(): void {
    this.particles = []
    this.lastTime = 0
  }
}
