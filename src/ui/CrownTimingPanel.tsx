// DIAGNOSTIC (branch diag/crown-timing) — lists the crown start-up timings
// recorded on this origin, with a button to copy them as JSON. See
// src/filters/crownTiming.ts.
import { useEffect, useState } from 'react'
import { clearTimings, CROWN_TIMING_EVENT, loadTimings, type CrownTiming } from '../filters/crownTiming'
import { s } from './theme'

export function CrownTimingPanel() {
  const [timings, setTimings] = useState<CrownTiming[]>(loadTimings)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    const refresh = () => setTimings(loadTimings())
    window.addEventListener(CROWN_TIMING_EVENT, refresh)
    return () => window.removeEventListener(CROWN_TIMING_EVENT, refresh)
  }, [])

  const launches = [...new Set(timings.map(t => t.launch))]
  const copy = async () => {
    const json = JSON.stringify(timings, null, 1)
    try {
      await navigator.clipboard.writeText(json)
      setCopied(`${timings.length} kopiert`)
    } catch (e) {
      setCopied(`Kopieren fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div data-testid="crown-timing" style={{ ...s.buildStamp, fontSize: 12 }}>
      <div style={{ fontWeight: 700 }}>Krone (Diagnose): {timings.length} Starts</div>
      {timings.map((t, i) => (
        <div key={i}>
          L{launches.indexOf(t.launch) + 1} S{t.start}: Renderer {t.rendererMs}, Modell {t.modelMs},
          {' '}1. Frame {t.firstFrameAtMs}, Dauer {t.firstDrawMs} ms ({t.backend})
        </div>
      ))}
      <button onClick={copy}>JSON kopieren</button>{' '}
      <button onClick={() => { if (window.confirm('Alle Messungen löschen?')) clearTimings() }}>Löschen</button>
      {copied && <div>{copied}</div>}
    </div>
  )
}
