import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { TrackingDTO } from '../domain/tracking.dto'
import type { ViewGeometry } from '../render/coordinates'
import type { ActiveFilters } from './types'
import { SunglassesFilter } from './SunglassesFilter'
import { SparklesFilter } from './SparklesFilter'
import { CrownFilter } from './CrownFilter'

interface Props {
  activeFilters: ActiveFilters
  width: number
  height: number
}

export interface FilterOverlayHandle {
  /**
   * Called by the parent RAF loop each processed frame. `geometry` carries the
   * mirroring and object-fit for this frame; no filter derives them itself.
   */
  tick(tracking: TrackingDTO | null, geometry: ViewGeometry): void
}

/**
 * Renders 2D/3D AR filters on top of the camera feed.
 * Driven imperatively via the `tick()` handle so rendering is always
 * synchronised with the parent tracking loop — no second RAF loop needed.
 */
export const FilterOverlay = forwardRef<FilterOverlayHandle, Props>(
  function FilterOverlay({ activeFilters, width, height }, ref) {
    const canvas2dRef    = useRef<HTMLCanvasElement>(null)
    const canvasThreeRef = useRef<HTMLCanvasElement>(null)

    const sunglassesRef = useRef<SunglassesFilter | null>(null)
    const sparklesRef   = useRef<SparklesFilter | null>(null)
    const crownRef      = useRef<CrownFilter | null>(null)

    const activeFiltersRef = useRef(activeFilters)
    useEffect(() => { activeFiltersRef.current = activeFilters }, [activeFilters])

    // The 2D filters are cheap to hold. The crown is not: constructing it builds
    // a three.js renderer and a GPU context, so it is created on first use and
    // a session that never enables it pays nothing — which is what makes the
    // per-filter measurements mean anything.
    useEffect(() => {
      sunglassesRef.current = new SunglassesFilter()
      sparklesRef.current   = new SparklesFilter()

      return () => {
        crownRef.current?.dispose()
        crownRef.current = null
        sparklesRef.current?.reset()
      }
    }, [])

    // Canvases are sized in device pixels, not CSS pixels: at a devicePixelRatio
    // of 3 a CSS-sized canvas renders at a third of the screen's resolution and
    // the filters look soft next to the native app's Skia output.
    const sizeRef = useRef({ width: 0, height: 0 })
    useEffect(() => {
      if (!width || !height) return
      sizeRef.current = { width, height }
      const dpr = window.devicePixelRatio || 1

      for (const canvas of [canvas2dRef.current, canvasThreeRef.current]) {
        if (!canvas) continue
        canvas.width  = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
      }
      crownRef.current?.resize(width, height)
    }, [width, height])

    // Expose tick() to parent — called directly from the CameraScreen RAF loop
    useImperativeHandle(ref, () => ({
      tick(tracking: TrackingDTO | null, geometry: ViewGeometry) {
        const canvas2d = canvas2dRef.current
        const ctx = canvas2d?.getContext('2d')
        const af  = activeFiltersRef.current
        const now = performance.now()

        if (!ctx || !canvas2d) return

        ctx.clearRect(0, 0, canvas2d.width, canvas2d.height)

        // Draw in device pixels; the shared projection works in CSS pixels.
        const dpr = window.devicePixelRatio || 1
        ctx.save()
        ctx.scale(dpr, dpr)

        // Sparkles keep ticking while particles are still alive, so they finish
        // their arc after the hand leaves the frame — but a session with the
        // filter off does not run the simulation at all. It used to run always,
        // which meant a disabled filter still cost CPU and skewed the per-filter
        // comparison against the native app, where nothing is even mounted.
        const sparkles = sparklesRef.current
        if (sparkles && (af.sparkles || sparkles.hasParticles())) {
          sparkles.update(
            tracking ?? { timestampMs: now, mode: 'combined' },
            geometry,
            now,
            af.sparkles,
          )
          sparkles.render(ctx)
        }

        if (tracking && af.glasses) {
          sunglassesRef.current?.render(ctx, tracking, geometry)
        }

        ctx.restore()

        if (af.crown) {
          const canvas = canvasThreeRef.current
          if (canvas && !crownRef.current) {
            crownRef.current = new CrownFilter(canvas)
            const { width: w, height: h } = sizeRef.current
            if (w && h) crownRef.current.resize(w, h)
          }
          if (tracking) crownRef.current?.render(tracking, geometry)
        }
      },
    }), [])

    const style: React.CSSProperties = {
      position: 'absolute',
      top: 0, left: 0,
      width: '100%', height: '100%',
      pointerEvents: 'none',
    }

    const canvasStyle: React.CSSProperties = {
      position: 'absolute',
      top: 0, left: 0,
      width: '100%', height: '100%',
    }

    return (
      <div style={style}>
        {/* 2D layer: sunglasses + sparkles */}
        <canvas ref={canvas2dRef} style={canvasStyle} />
        {/* Three.js layer: 3D crown */}
        <canvas ref={canvasThreeRef} style={canvasStyle} />
      </div>
    )
  }
)
