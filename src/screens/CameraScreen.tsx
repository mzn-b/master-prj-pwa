import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TrackingDTO, TrackingMode } from "../domain/tracking.dto";
import { TrackingController } from "../tracking/TrackingController";
import { OverlayCanvas } from "../ui/OverlayCanvas";

export function CameraScreen() {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const rafRef = useRef<number | null>(null);

    const [mode, setMode] = useState<TrackingMode>("combined");
    const [isRunning, setIsRunning] = useState(false);
    const [tracking, setTracking] = useState<TrackingDTO | null>(null);
    const [error, setError] = useState<string | null>(null);

    const [controller, setController] = useState<TrackingController | null>(null);

    const canStart = useMemo(() => !isRunning, [isRunning]);

    const start = useCallback(async () => {
        setError(null);

        try {
            // M1: Kamera + Live Preview
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "user" },
                audio: false,
            });
            streamRef.current = stream;

            const video = videoRef.current;
            if (!video) throw new Error("Video element fehlt.");
            video.srcObject = stream;
            await video.play();

            // Model initialisieren passend zum Modus (M2/M3)
            const c = await TrackingController.init(mode, { maxFaces: 1, maxHands: 2 });
            setController(c);

            setIsRunning(true);

            // M5: Echtzeit loop
            const loop = () => {
                const v = videoRef.current;
                if (!v || v.readyState < 2) {
                    rafRef.current = requestAnimationFrame(loop);
                    return;
                }
                const ts = performance.now();
                const dto = c.detect(v, ts, mode); // M6: einheitliches DTO
                setTracking(dto); // M4: Overlay nutzt tracking

                rafRef.current = requestAnimationFrame(loop);
            };

            rafRef.current = requestAnimationFrame(loop);
        } catch (e) {
            const msg = e instanceof Error ? e.message : "Unbekannter Fehler beim Start.";
            setError(msg);
            await stop(); // cleanup
        }
    }, [mode]);

    const stop = useCallback(async () => {
        // M7: Stop
        setIsRunning(false);

        if (rafRef.current != null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }

        controller?.close();
        setController(null);

        const stream = streamRef.current;
        if (stream) {
            for (const track of stream.getTracks()) track.stop();
            streamRef.current = null;
        }

        const video = videoRef.current;
        if (video) {
            video.pause();
            video.srcObject = null;
        }

        setTracking(null);
    }, [controller]);

    // Wenn Modus geändert wird, während läuft: neu starten
    useEffect(() => {
        if (!isRunning) return;
        (async () => {
            await stop();
            await start();
        })().catch(() => {});
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode]);

    return (
        <div style={{ padding: 16, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
            <h1 style={{ margin: 0, marginBottom: 12 }}>Tracking PWA (Face + Hand)</h1>

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                <label>
                    Modus:&nbsp;
                    <select
                        value={mode}
                        onChange={(e) => setMode(e.target.value as TrackingMode)}
                        disabled={isRunning}
                    >
                        <option value="face">Face</option>
                        <option value="hand">Hand</option>
                        <option value="combined">Combined</option>
                    </select>
                </label>

                <button onClick={start} disabled={!canStart}>
                    Start
                </button>
                <button onClick={stop} disabled={!isRunning}>
                    Stop
                </button>

                <span style={{ opacity: 0.8 }}>
          Status: {isRunning ? "läuft" : "gestoppt"}
        </span>
            </div>

            {error && (
                <div style={{ marginBottom: 12, color: "crimson" }}>
                    Fehler: {error}
                </div>
            )}

            <div
                style={{
                    position: "relative",
                    width: "100%",
                    background: "#111827",
                    borderRadius: 12,
                    overflow: "hidden",
                }}
            >
                <video
                    ref={videoRef}
                    playsInline
                    muted
                    style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                        transform: "scaleX(-1)", // Selfie mirror
                    }}
                />

                {/* M4 Overlay */}
                <div style={{ position: "absolute", inset: 0, transform: "scaleX(-1)" }}>
                    <OverlayCanvas tracking={tracking} videoEl={videoRef.current} />
                </div>
            </div>

            {/* Debug: DTO (optional anzeigen; entfernt werden wenn du es “clean” willst) */}
            <details style={{ marginTop: 12 }}>
                <summary>Letztes TrackingDTO</summary>
                <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(tracking, null, 2)}</pre>
            </details>

            <p style={{ marginTop: 12, opacity: 0.8 }}>
                Verarbeitung läuft on-device im Browser; es werden keine Bilddaten hochgeladen.
            </p>
        </div>
    );
}
