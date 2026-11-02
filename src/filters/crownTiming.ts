// DIAGNOSTIC (branch diag/crown-timing) — not for the study build.
//
// Re-measures the crown's start-up on the final builds (TODO item 5), with the
// same four figures the 2026-10-08 instrumentation reported (c196273, d51cb45,
// c1fa714; removed in 84a56cf): renderer init, model load and the first drawn
// frame, all in milliseconds from constructing the CrownFilter, plus how long
// that first draw took. Each start is kept in localStorage (on the preview's
// origin only) so that a whole series of cold launches can be read and copied
// at the end instead of being transcribed from the screen.

export interface CrownTiming {
  /** Wall-clock time of the first draw, ISO. */
  at: string
  /** performance.timeOrigin of the page load: one value per launch. */
  launch: number
  /** 1 for the first Start after the page loaded (cold), 2 for the next, … */
  start: number
  rendererMs: number
  modelMs: number
  firstFrameAtMs: number
  firstDrawMs: number
  backend: string
  standalone: boolean
  userAgent: string
}

const KEY = 'crownTimings'
export const CROWN_TIMING_EVENT = 'crowntiming'

let startsThisLaunch = 0

/** Called when a CrownFilter is constructed; returns its index in this launch. */
export function nextStart(): number {
  startsThisLaunch += 1
  return startsThisLaunch
}

export function loadTimings(): CrownTiming[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as CrownTiming[]
  } catch {
    return []
  }
}

export function saveTiming(timing: CrownTiming): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...loadTimings(), timing]))
  } catch {
    // Storage unavailable: the console line below is then the only record.
  }
  console.log('[CROWNTIMING]', JSON.stringify(timing))
  window.dispatchEvent(new Event(CROWN_TIMING_EVENT))
}

export function clearTimings(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // nothing to clear
  }
  window.dispatchEvent(new Event(CROWN_TIMING_EVENT))
}
