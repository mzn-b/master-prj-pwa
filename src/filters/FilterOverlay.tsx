import { useEffect, useRef } from 'react'
import type { TrackingDTO } from '../domain/tracking.dto'
import type { ActiveFilters } from './types'
import { SunglassesFilter } from './SunglassesFilter'
import { SparklesFilter } from './SparklesFilter'
import { CrownFilter } from './CrownFilter'

interface Props {
  /** Ref pointing to the latest TrackingDTO — updated by the main RAF loop. */
  trackingRef: React.RefObject<TrackingDTO | null>
  activeFilters: ActiveFilters
  width: number
  height: number
}

/**
 * Renders 2D/3D AR filters on top of the camera feed.
 * Drives its own requestAnimationFrame loop reading from `trackingRef`
 * so the parent component is never forced to re-render at 60 fps.
 */
export function FilterOverlay({ trackingRef, activeFilters, width, height }: Props) {
  const canvas2dRef = useRef<HTMLCanvasElement>(null)
  const canvasThreeRef = useRef<HTMLCanvasElement>(null)

  const sunglassesRef = useRef<SunglassesFilter | null>(null)
  const sparklesRef = useRef<SparklesFilter | null>(null)
  const crownRef = useRef<CrownFilter | null>(null)

  // Keep a ref to activeFilters to avoid re-starting RAF on every toggle
  const activeFiltersRef = useRef(activeFilters)
  useEffect(() => { activeFiltersRef.current = activeFilters }, [activeFilters])

  // Initialise filter instances once on mount
  useEffect(() => {
    sunglassesRef.current = new SunglassesFilter()
    sparklesRef.current = new SparklesFilter()

    if (canvasThreeRef.current) {
      crownRef.current = new CrownFilter(canvasThreeRef.current)
    }

    return () => {
      crownRef.current?.dispose()
      crownRef.current = null
      sparklesRef.current?.reset()
    }
  }, [])

  // Re-size canvases when dimensions change
  useEffect(() => {
    if (!width || !height) return

    if (canvas2dRef.current) {
      canvas2dRef.current.width = width
      canvas2dRef.current.height = height
    }
    if (canvasThreeRef.current) {
      canvasThreeRef.current.width = width
      canvasThreeRef.current.height = height
    }
    crownRef.current?.resize(width, height)
  }, [width, height])

  // Self-driven RAF loop — reads trackingRef every frame, no parent re-render needed
  useEffect(() => {
    if (!width || !height) return

    let rafId: number

    const animate = () => {
      const canvas2d = canvas2dRef.current
      const ctx = canvas2d?.getContext('2d')
      const af = activeFiltersRef.current
      const tracking = trackingRef.current
      const now = performance.now()

      if (ctx && canvas2d) {
        ctx.clearRect(0, 0, canvas2d.width, canvas2d.height)

        // Sparkles always tick (so particles finish their arc even after hand leaves)
        sparklesRef.current?.update(
          tracking ?? { timestampMs: now, mode: 'combined' },
          canvas2d.width,
          canvas2d.height,
          now,
        )

        if (tracking) {
          if (af.glasses) {
            sunglassesRef.current?.render(ctx, tracking, canvas2d.width, canvas2d.height)
          }
          if (af.crown) {
            crownRef.current?.render(tracking, canvas2d.width, canvas2d.height)
          }
        }

        if (af.sparkles) {
          sparklesRef.current?.render(ctx)
        }
      }

      rafId = requestAnimationFrame(animate)
    }

    rafId = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(rafId)
  }, [width, height, trackingRef])

  const style: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
  }

  const canvasStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
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
