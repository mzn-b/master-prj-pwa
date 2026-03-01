import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import type {PerformanceMetricsDTO, TrackingMode} from "../domain/tracking.dto";
import {TrackingController} from "../tracking/TrackingController";
import {PerformanceTracker} from "../tracking/PerformanceTracker";
import {DEFAULT_SMOOTHING_CONFIG, LandmarkSmoother} from "../tracking/LandmarkSmoother";
import {
    canStartTracking,
    checkDeviceCapabilities,
    DEFAULT_DYNAMIC_INFERENCE_CONFIG,
    type DeviceCapabilities,
    DynamicInferenceController,
} from "../tracking/TrackingConfig";
import {PerformanceOverlay} from "../ui/PerformanceOverlay";
import {submitTrackingSession} from "../api/trackingApi";
import {useRenderer} from "../rendering";
import {useCamera} from "../hooks";

export function CameraScreen() {
    const rafRef = useRef<number | null>(null);

    const [mode, setMode] = useState<TrackingMode>("combined");
    const [isTrackingActive, setIsTrackingActive] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [warnings, setWarnings] = useState<string[]>([]);
    const [showPerformance, setShowPerformance] = useState(true);
    const [showSettings, setShowSettings] = useState(false);
    const [performanceMetrics, setPerformanceMetrics] = useState<PerformanceMetricsDTO | null>(null);
    const [deviceCapabilities, setDeviceCapabilities] = useState<DeviceCapabilities | null>(null);
    const [isCheckingDevice, setIsCheckingDevice] = useState(true);

    const [smoothingEnabled, setSmoothingEnabled] = useState(DEFAULT_SMOOTHING_CONFIG.enabled);
    const [dynamicInferenceEnabled, setDynamicInferenceEnabled] = useState(DEFAULT_DYNAMIC_INFERENCE_CONFIG.enabled);
    const [currentFrameSkip, setCurrentFrameSkip] = useState(1);

    const [isUploading, setIsUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState<"success" | "error" | null>(null);

    // Use camera hook for stream management
    const camera = useCamera();

    const [controller, setController] = useState<TrackingController | null>(null);
    const sessionModeRef = useRef<TrackingMode>(mode);
    const performanceTrackerRef = useRef<PerformanceTracker | null>(null);
    const smootherRef = useRef<LandmarkSmoother | null>(null);
    const dynamicInferenceRef = useRef<DynamicInferenceController | null>(null);
    const metricsIntervalRef = useRef<number | null>(null);
    const frameCountRef = useRef(0);

    // Initialize renderer with auto backend (WebGPU preferred, WebGL fallback)
    const { canvasRef, render: renderOverlay, capabilities } = useRenderer({
        preferredBackend: "auto",
        autoAddLandmarkOverlay: true,
    });

    useEffect(() => {
        if (capabilities) {
            console.log(`[CameraScreen] Renderer backend: ${capabilities.backend}`);
        }
    }, [capabilities]);

    useEffect(() => {
        (async () => {
            setIsCheckingDevice(true);
            const capabilities = await checkDeviceCapabilities();
            setDeviceCapabilities(capabilities);
            setWarnings(capabilities.warnings);
            if (capabilities.errors.length > 0) {
                setError(capabilities.errors.join(" "));
            }
            setIsCheckingDevice(false);
        })();
    }, []);

    // Combine camera error with local error
    useEffect(() => {
        if (camera.error) setError(camera.error);
    }, [camera.error]);

    const isRunning = camera.isActive && isTrackingActive;

    const canStart = useMemo(() => {
        if (isRunning || isCheckingDevice) return false;
        if (!deviceCapabilities) return false;
        return canStartTracking(deviceCapabilities);
    }, [isRunning, isCheckingDevice, deviceCapabilities]);

    const stop = useCallback(async () => {
        // Capture final metrics before cleanup
        const finalMetrics = performanceTrackerRef.current?.getMetrics();
        const sessionMode = sessionModeRef.current;

        setIsTrackingActive(false);

        if (rafRef.current != null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }

        if (metricsIntervalRef.current != null) {
            clearInterval(metricsIntervalRef.current);
            metricsIntervalRef.current = null;
        }

        performanceTrackerRef.current = null;
        smootherRef.current?.reset();
        smootherRef.current = null;
        dynamicInferenceRef.current?.reset();
        dynamicInferenceRef.current = null;

        controller?.close();
        setController(null);

        // Stop camera using hook
        camera.stop();

        setPerformanceMetrics(null);
        frameCountRef.current = 0;

        // Submit metrics to backend
        if (finalMetrics && finalMetrics.frameCount > 0) {
            setIsUploading(true);
            setUploadStatus(null);
            try {
                const response = await submitTrackingSession(sessionMode, finalMetrics);
                setUploadStatus(response ? "success" : "error");
            } catch {
                setUploadStatus("error");
            } finally {
                setIsUploading(false);
                setTimeout(() => setUploadStatus(null), 3000);
            }
        }
    }, [controller, camera]);


    const start = useCallback(async () => {
        setError(null);
        setUploadStatus(null);
        frameCountRef.current = 0;
        sessionModeRef.current = mode;

        try {
            // Start camera using hook
            const cameraStarted = await camera.start();
            if (!cameraStarted) return;

            const video = camera.videoRef.current;
            if (!video) throw new Error("Video element fehlt.");

            const c = await TrackingController.init(mode, {maxFaces: 1, maxHands: 2});
            setController(c);

            const perfTracker = new PerformanceTracker();
            perfTracker.start();
            performanceTrackerRef.current = perfTracker;

            smootherRef.current = new LandmarkSmoother({
                ...DEFAULT_SMOOTHING_CONFIG,
                enabled: smoothingEnabled,
            });

            dynamicInferenceRef.current = new DynamicInferenceController({
                ...DEFAULT_DYNAMIC_INFERENCE_CONFIG,
                enabled: dynamicInferenceEnabled,
            });

            setIsTrackingActive(true);

            metricsIntervalRef.current = window.setInterval(() => {
                if (performanceTrackerRef.current) {
                    const metrics = performanceTrackerRef.current.getMetrics();
                    setPerformanceMetrics(metrics);

                    if (dynamicInferenceRef.current && metrics.avgInferenceTimeMs > 0) {
                        dynamicInferenceRef.current.recordInferenceTime(metrics.avgInferenceTimeMs);
                        setCurrentFrameSkip(dynamicInferenceRef.current.getCurrentFrameSkip());
                    }
                }
            }, 500);

            // Cache video dimensions to avoid layout thrashing
            let cachedWidth = video.clientWidth;
            let cachedHeight = video.clientHeight;
            let dimensionCheckCounter = 0;

            const loop = () => {
                const v = camera.videoRef.current;
                const pt = performanceTrackerRef.current;
                const sm = smootherRef.current;
                const di = dynamicInferenceRef.current;

                if (!v || v.readyState < 2) {
                    rafRef.current = requestAnimationFrame(loop);
                    return;
                }

                frameCountRef.current++;

                const frameSkip = di?.getCurrentFrameSkip() ?? 1;
                if (frameCountRef.current % frameSkip !== 0) {
                    rafRef.current = requestAnimationFrame(loop);
                    return;
                }

                // Update cached dimensions every 60 frames
                dimensionCheckCounter++;
                if (dimensionCheckCounter >= 60) {
                    dimensionCheckCounter = 0;
                    cachedWidth = v.clientWidth;
                    cachedHeight = v.clientHeight;
                }

                const frameStart = pt?.recordFrameStart() ?? 0;
                const ts = performance.now();

                const inferenceStart = performance.now();
                let dto = c.detect(v, ts, mode);
                pt?.recordInferenceTime(inferenceStart);

                if (sm) dto = sm.smooth(dto);

                const facesCount = dto.face?.faces?.length ?? 0;
                const handsCount = dto.hand?.hands?.length ?? 0;
                const hasTracking = facesCount > 0 || handsCount > 0;
                pt?.recordDetection(facesCount, handsCount);
                pt?.recordFrameEnd(frameStart, hasTracking);

                renderOverlay(dto, cachedWidth, cachedHeight);
                rafRef.current = requestAnimationFrame(loop);
            };

            rafRef.current = requestAnimationFrame(loop);
        } catch (e) {
            const msg = e instanceof Error ? e.message : "Unbekannter Fehler beim Start.";
            setError(msg);
            await stop();
        }
    }, [mode, smoothingEnabled, dynamicInferenceEnabled, stop, renderOverlay, camera]);


    useEffect(() => {
        if (smootherRef.current) {
            smootherRef.current.setConfig({...DEFAULT_SMOOTHING_CONFIG, enabled: smoothingEnabled});
        }
    }, [smoothingEnabled]);


    useEffect(() => {
        if (dynamicInferenceRef.current) {
            dynamicInferenceRef.current.setConfig({enabled: dynamicInferenceEnabled});
        }
    }, [dynamicInferenceEnabled]);

    const prevModeRef = useRef(mode);
    useEffect(() => {
        if (!isRunning) return;
        if (prevModeRef.current === mode) return;
        prevModeRef.current = mode;
        (async () => {
            await stop();
            await start();
        })().catch(() => {
        });
    }, [isRunning, mode, start, stop]);

    return (
        <div style={{padding: 16, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"}}>
            <h1 style={{margin: 0, marginBottom: 12}}>Tracking PWA (Face + Hand)</h1>

            {warnings.length > 0 && (
                <div style={{marginBottom: 12, padding: 8, background: "#fef3c7", borderRadius: 8, color: "#92400e"}}>
                    {warnings.map((w, i) => (
                        <div key={i}>Hinweis: {w}</div>
                    ))}
                </div>
            )}

            <div style={{display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap"}}>
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
                    {isCheckingDevice ? "Prüfe..." : "Start"}
                </button>
                <button onClick={stop} disabled={!isRunning}>
                    Stop
                </button>

                <button onClick={() => setShowPerformance((p) => !p)} style={{marginLeft: 8}}>
                    {showPerformance ? "Hide Metrics" : "Show Metrics"}
                </button>

                <button onClick={() => setShowSettings((s) => !s)}>
                    Settings
                </button>

                <span style={{opacity: 0.8}}>
                    Status: {isRunning ? "läuft" : "gestoppt"}
                    {isRunning && !performanceMetrics?.warmupComplete && " (Warmup...)"}
                    {isUploading && " | Sende Daten..."}
                    {uploadStatus === "success" && " | Daten gesendet"}
                    {uploadStatus === "error" && " | Fehler beim Senden"}
                </span>
            </div>

            {showSettings && (
                <div style={{marginBottom: 12, padding: 12, background: "#1f2937", borderRadius: 8, color: "#e5e7eb"}}>
                    <h3 style={{margin: "0 0 8px 0", fontSize: 14}}>Einstellungen (NF4: Identisch für PWA & Native)</h3>

                    <div style={{marginBottom: 8}}>
                        <label style={{display: "flex", alignItems: "center", gap: 8}}>
                            <input
                                type="checkbox"
                                checked={smoothingEnabled}
                                onChange={(e) => setSmoothingEnabled(e.target.checked)}
                            />
                            F9: Landmark-Glättung (reduziert Jitter)
                        </label>
                    </div>

                    <div style={{marginBottom: 8}}>
                        <label style={{display: "flex", alignItems: "center", gap: 8}}>
                            <input
                                type="checkbox"
                                checked={dynamicInferenceEnabled}
                                onChange={(e) => setDynamicInferenceEnabled(e.target.checked)}
                            />
                            F15: Dynamische Inferenzrate (passt sich an Geräteleistung an)
                        </label>
                        {dynamicInferenceEnabled && (
                            <div style={{marginLeft: 24, marginTop: 4, fontSize: 12, color: "#9ca3af"}}>
                                Aktueller Frame-Skip: {currentFrameSkip} (verarbeitet jeden {currentFrameSkip}. Frame)
                            </div>
                        )}
                    </div>

                    <div style={{fontSize: 12, color: "#9ca3af"}}>
                        F11: Warmup-Phase: {performanceMetrics?.warmupComplete ? "Abgeschlossen" : "Läuft (30 Frames)"}
                    </div>
                </div>
            )}

            {error && (
                <div style={{marginBottom: 12, color: "crimson"}}>
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
                {!isRunning && (
                    <div
                        style={{
                            position: "absolute",
                            inset: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "#6b7280",
                            flexDirection: "column",
                            gap: 8,
                        }}
                    >
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="1.5">
                            <path
                                d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z"/>
                        </svg>
                        <span>Drücke Start um die Kamera zu aktivieren</span>
                    </div>
                )}
                <video
                    ref={camera.videoRef}
                    playsInline
                    muted
                    style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                        transform: "scaleX(-1)",
                        display: isRunning ? "block" : "none",
                    }}
                />

                <div style={{
                    position: "absolute",
                    inset: 0,
                    transform: "scaleX(-1)",
                    display: isRunning ? "block" : "none",
                }}>
                    <canvas
                        ref={canvasRef}
                        style={{
                            position: "absolute",
                            inset: 0,
                            width: "100%",
                            height: "100%",
                            pointerEvents: "none",
                        }}
                    />
                </div>

                {isRunning && (
                    <PerformanceOverlay metrics={performanceMetrics} visible={showPerformance}/>
                )}
            </div>
        </div>
    );
}
