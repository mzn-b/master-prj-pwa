import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import type {TrackingDTO, PerformanceMetricsDTO, TrackingMode} from "../domain/tracking.dto";
import {
    createEngine,
    type EngineResult,
    type InferenceThreading,
    type TrackingEngine,
} from "../tracking/engines";
import {subscribeToVideoFrames} from "../tracking/videoFrames";
import {PerformanceTracker, WARMUP_FRAMES} from "../tracking/PerformanceTracker";
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
import {viewGeometryFromVideo} from "../render/coordinates";
import type {ActiveFilters, FilterId} from "../filters/types";
import {DEFAULT_ACTIVE_FILTERS, FILTER_IDS, FILTER_LABELS} from "../filters/types";
import {FilterOverlay, type FilterOverlayHandle} from "../filters/FilterOverlay";

type AppMode = 'landmarks' | 'filters';

export function CameraScreen() {
    const rafRef = useRef<number | null>(null);
    const filterOverlayRef = useRef<FilterOverlayHandle>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);

    const [mode, setMode] = useState<TrackingMode>("combined");
    const [appMode, setAppMode] = useState<AppMode>('landmarks');
    const [activeFilters, setActiveFilters] = useState<ActiveFilters>(DEFAULT_ACTIVE_FILTERS);

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
    const [showDebug, setShowDebug] = useState(false);
    /**
     * §3a — where MediaPipe runs. A runtime toggle rather than a build flag so a
     * single build can measure both, and every session records which mode it used.
     */
    const [threading, setThreading] = useState<InferenceThreading>("worker");
    const [latestTracking, setLatestTracking] = useState<TrackingDTO | null>(null);

    const [isUploading, setIsUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState<"success" | "skipped" | "error" | null>(null);

    // Filter overlay dimensions (updated lazily from RAF loop)
    const [overlayDims, setOverlayDims] = useState({ width: 0, height: 0 });
    const overlayDimsRef = useRef({ width: 0, height: 0 });

    // The screen owns the video element ref and lends it to useCamera — see the
    // note in useCamera.ts for why the hook does not hand one back.
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const camera = useCamera(videoRef);

    const engineRef = useRef<TrackingEngine | null>(null);
    const sessionModeRef = useRef<TrackingMode>(mode);
    const performanceTrackerRef = useRef<PerformanceTracker | null>(null);
    const smootherRef = useRef<LandmarkSmoother | null>(null);
    const dynamicInferenceRef = useRef<DynamicInferenceController | null>(null);
    const metricsIntervalRef = useRef<number | null>(null);
    const frameCountRef = useRef(0);
    /** Cancels the camera-frame callback, whichever mechanism provided it. */
    const frameCallbackRef = useRef<(() => void) | null>(null);
    /** Latest smoothed detection, drawn by the render loop. */
    const latestSmoothedRef = useRef<TrackingDTO | null>(null);

    // Refs to avoid stale closures inside the RAF loop
    const appModeRef = useRef<AppMode>('landmarks');
    const activeFiltersRef = useRef<ActiveFilters>(DEFAULT_ACTIVE_FILTERS);
    // F14 — latest tracking sample fed to the debug HUD (updated by the metrics interval)
    const latestTrackingRef = useRef<TrackingDTO | null>(null);
    const showDebugRef = useRef(false);
    useEffect(() => { showDebugRef.current = showDebug; }, [showDebug]);

    useEffect(() => { appModeRef.current = appMode; }, [appMode]);
    useEffect(() => { activeFiltersRef.current = activeFilters; }, [activeFilters]);

    const { canvasRef, render: renderOverlay, capabilities } = useRenderer({
        preferredBackend: "auto",
        autoAddLandmarkOverlay: true,
    });

    // §2.10 — the chosen backend is device-dependent (WebGPU where available,
    // WebGL otherwise), so it is submitted with the session. Two PWA rows are
    // not comparable if one was drawn by WebGPU and the other by WebGL.
    const capabilitiesRef = useRef(capabilities);
    useEffect(() => {
        capabilitiesRef.current = capabilities;
        if (capabilities) {
            console.log(`[CameraScreen] Renderer backend: ${capabilities.backend}`);
        }
    }, [capabilities]);

    useEffect(() => {
        (async () => {
            setIsCheckingDevice(true);
            const caps = await checkDeviceCapabilities();
            setDeviceCapabilities(caps);
            setWarnings(caps.warnings);
            if (caps.errors.length > 0) setError(caps.errors.join(" "));
            setIsCheckingDevice(false);
        })();
    }, []);

    // Derived, not copied into state by an effect: mirroring one piece of state
    // into another schedules a second render for every camera error.
    const displayError = error ?? camera.error;

    const isRunning = camera.isActive && isTrackingActive;

    const canStart = useMemo(() => {
        if (isRunning || isCheckingDevice) return false;
        if (!deviceCapabilities) return false;
        return canStartTracking(deviceCapabilities);
    }, [isRunning, isCheckingDevice, deviceCapabilities]);

    const stop = useCallback(async () => {
        const finalMetrics = performanceTrackerRef.current?.getMetrics();
        const sessionMode = sessionModeRef.current;
        const currentlyActive = (Object.keys(activeFiltersRef.current) as FilterId[])
            .filter(k => activeFiltersRef.current[k]);

        setIsTrackingActive(false);

        if (rafRef.current != null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        frameCallbackRef.current?.();
        frameCallbackRef.current = null;
        if (metricsIntervalRef.current != null) {
            clearInterval(metricsIntervalRef.current);
            metricsIntervalRef.current = null;
        }
        resizeObserverRef.current?.disconnect();
        resizeObserverRef.current = null;

        performanceTrackerRef.current = null;
        smootherRef.current?.reset();
        smootherRef.current = null;
        dynamicInferenceRef.current?.reset();
        dynamicInferenceRef.current = null;

        engineRef.current?.close();
        engineRef.current = null;
        latestSmoothedRef.current = null;
        camera.stop();
        setPerformanceMetrics(null);
        frameCountRef.current = 0;

        if (finalMetrics && finalMetrics.frameCount > 0) {
            setIsUploading(true);
            setUploadStatus(null);
            try {
                const result = await submitTrackingSession(sessionMode, finalMetrics, currentlyActive);
                setUploadStatus(result.status === "ok" ? "success" : result.status);
            } catch {
                setUploadStatus("error");
            } finally {
                setIsUploading(false);
                setTimeout(() => setUploadStatus(null), 3000);
            }
        }
    }, [camera]);

    /**
     * Submit current session metrics and reset the tracker, then toggle the filter.
     * This creates a new session boundary for each filter state change.
     */
    const handleFilterToggle = useCallback(async (id: FilterId) => {
        if (isRunning && performanceTrackerRef.current) {
            const metrics = performanceTrackerRef.current.getMetrics();
            if (metrics.frameCount > 0) {
                const currentlyActive = (Object.keys(activeFiltersRef.current) as FilterId[])
                    .filter(k => activeFiltersRef.current[k]);
                try {
                    await submitTrackingSession('combined', metrics, currentlyActive);
                } catch { /* tracking continues regardless */ }
                performanceTrackerRef.current.reset();
            }
        }
        setActiveFilters(prev => ({ ...prev, [id]: !prev[id] }));
    }, [isRunning]);

    const start = useCallback(async () => {
        setError(null);
        setUploadStatus(null);
        frameCountRef.current = 0;

        // Filter mode always uses combined so all filters are available without restart
        const effectiveMode: TrackingMode = appModeRef.current === 'filters' ? 'combined' : mode;
        sessionModeRef.current = effectiveMode;

        try {
            const cameraStarted = await camera.start();
            if (!cameraStarted) return;

            const video = videoRef.current;
            if (!video) throw new Error("Video element fehlt.");

            const perfTracker = new PerformanceTracker();
            performanceTrackerRef.current = perfTracker;

            smootherRef.current = new LandmarkSmoother({
                ...DEFAULT_SMOOTHING_CONFIG,
                enabled: smoothingEnabled,
            });
            dynamicInferenceRef.current = new DynamicInferenceController({
                ...DEFAULT_DYNAMIC_INFERENCE_CONFIG,
                enabled: dynamicInferenceEnabled,
            });

            /**
             * Called once per completed detection — synchronously on the main
             * thread, or from the worker's message handler. Everything that must
             * happen exactly once per inference lives here rather than in the
             * frame loop, so both threading modes account identically.
             */
            const onResult = ({ dto, inferenceMs }: EngineResult) => {
                const pt = performanceTrackerRef.current;
                const sm = smootherRef.current;
                if (!pt) return;

                pt.recordInferenceMs(inferenceMs);
                const smoothed = sm ? sm.smooth(dto) : dto;
                latestSmoothedRef.current = smoothed;
                latestTrackingRef.current = smoothed;

                const facesCount = smoothed.face?.faces?.length ?? 0;
                const handsCount = smoothed.hand?.hands?.length ?? 0;
                pt.recordDetection(facesCount, handsCount);
                // Frame processing = inference plus the smoothing just done, so
                // back-date the start by the inference we were handed.
                pt.recordFrameEnd(performance.now() - inferenceMs, facesCount > 0 || handsCount > 0);
            };

            const engine = await createEngine(threading, {
                mode: effectiveMode,
                maxFaces: 1,
                maxHands: 2,
                useGPU: true,
                onResult,
                onError: message => {
                    performanceTrackerRef.current?.recordError();
                    console.error("[CameraScreen] engine error:", message);
                },
            });
            engineRef.current = engine;

            perfTracker.setModelLoadTime(engine.modelLoadTimeMs);
            perfTracker.setGpuDelegateActive(engine.gpuDelegateActive);
            perfTracker.setRunConditions({
                inferenceThreading: engine.threading,
                renderBackend: capabilitiesRef.current?.backend,
                frameWidth: video.videoWidth || undefined,
                frameHeight: video.videoHeight || undefined,
            });
            perfTracker.start();

            setIsTrackingActive(true);

            // Initialize overlay dimensions and keep them current via ResizeObserver
            const initW = video.clientWidth || 0;
            const initH = video.clientHeight || 0;
            overlayDimsRef.current = { width: initW, height: initH };
            setOverlayDims({ width: initW, height: initH });

            const ro = new ResizeObserver(entries => {
                const entry = entries[0];
                if (!entry) return;
                const { width, height } = entry.contentRect;
                if (width && height) {
                    overlayDimsRef.current = { width, height };
                    setOverlayDims({ width, height });
                }
            });
            ro.observe(video);
            resizeObserverRef.current = ro;

            metricsIntervalRef.current = window.setInterval(() => {
                if (performanceTrackerRef.current) {
                    // videoWidth is 0 until the first frame decodes, so the real
                    // capture size is only knowable a moment after start.
                    const v = videoRef.current;
                    if (v?.videoWidth) {
                        performanceTrackerRef.current.setRunConditions({
                            frameWidth: v.videoWidth,
                            frameHeight: v.videoHeight,
                        });
                    }
                    const metrics = performanceTrackerRef.current.getMetrics();
                    setPerformanceMetrics(metrics);
                    if (dynamicInferenceRef.current && metrics.avgInferenceTimeMs > 0) {
                        dynamicInferenceRef.current.recordInferenceTime(metrics.avgInferenceTimeMs);
                        setCurrentFrameSkip(dynamicInferenceRef.current.getCurrentFrameSkip());
                    }
                }
                // F14 — only re-render the debug section when it's actually showing
                if (showDebugRef.current) {
                    setLatestTracking(latestTrackingRef.current);
                }
            }, 500);

            /**
             * Detection is driven by camera frames, not by requestAnimationFrame.
             *
             * RAF ticks at display rate — 60 Hz, 120 on a ProMotion panel — while
             * the camera delivers about 30 fps. Driving detection from RAF meant
             * MediaPipe re-ran on frames it had already seen, wasting roughly half
             * the inferences on a fast device and inflating every measurement. The
             * native app gets exactly one callback per camera frame; this is the
             * browser's equivalent.
             */
            const onCameraFrame = () => {
                const v = videoRef.current;
                const pt = performanceTrackerRef.current;
                const di = dynamicInferenceRef.current;
                const eng = engineRef.current;
                if (!v || !eng || v.readyState < 2) return;

                frameCountRef.current++;

                const frameSkip = di?.getCurrentFrameSkip() ?? 1;
                if (frameCountRef.current % frameSkip !== 0) {
                    // F15 governor deliberately skipped this frame. It reached the
                    // pipeline and produced no inference, which is what the
                    // droppedFrames column measures — the native app counts the
                    // same event.
                    pt?.recordDroppedFrame();
                    return;
                }

                const outcome = eng.submit(v, performance.now(), effectiveMode);
                if (outcome.status === "busy" || outcome.status === "skipped") {
                    // Busy: inference is behind, so the frame is discarded rather
                    // than queued. Skipped: the timestamp had not advanced, so
                    // MediaPipe ran nothing. Both are dropped frames, and the
                    // native app counts the same two events.
                    pt?.recordDroppedFrame();
                }
                // "done" and "scheduled" are accounted for by onResult.
            };

            frameCallbackRef.current = subscribeToVideoFrames(video, onCameraFrame);

            /**
             * Drawing runs on its own RAF loop, reading whatever the last
             * completed detection was. Detection and drawing are decoupled for the
             * same reason they are on native: a slow inference should degrade the
             * tracking rate, not freeze the overlay, and the particle filter needs
             * a steady tick regardless of detections.
             */
            const drawLoop = () => {
                const v = videoRef.current;
                if (v && v.readyState >= 2) {
                    const { width, height } = overlayDimsRef.current;
                    // One geometry per frame, shared by every overlay — see
                    // src/render/coordinates.ts.
                    const geometry = viewGeometryFromVideo(v, width, height);
                    const dto = latestSmoothedRef.current;

                    if (appModeRef.current === 'landmarks') {
                        renderOverlay(dto, geometry);
                    } else {
                        filterOverlayRef.current?.tick(dto, geometry);
                    }
                }
                rafRef.current = requestAnimationFrame(drawLoop);
            };

            rafRef.current = requestAnimationFrame(drawLoop);
        } catch (e) {
            const msg = e instanceof Error ? e.message : "Unbekannter Fehler beim Start.";
            setError(msg);
            await stop();
        }
    }, [mode, smoothingEnabled, dynamicInferenceEnabled, threading, stop, renderOverlay, camera]);

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

    // Restart tracking when mode or appMode changes while running
    const prevModeRef = useRef(mode);
    const prevAppModeRef = useRef<AppMode>('landmarks');
    const prevThreadingRef = useRef<InferenceThreading>(threading);
    useEffect(() => {
        if (!isRunning) return;
        if (
            prevModeRef.current === mode &&
            prevAppModeRef.current === appMode &&
            prevThreadingRef.current === threading
        ) return;
        prevModeRef.current = mode;
        prevAppModeRef.current = appMode;
        prevThreadingRef.current = threading;
        (async () => {
            await stop();
            await start();
        })().catch(() => {});
    }, [isRunning, mode, appMode, threading, start, stop]);

    return (
        <div style={{padding: 16, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"}}>
            <h1 style={{margin: 0, marginBottom: 12}}>Tracking PWA (Face + Hand)</h1>

            {/* App mode toggle */}
            <div style={{display: "flex", gap: 4, marginBottom: 12}}>
                {(['landmarks', 'filters'] as AppMode[]).map(m => (
                    <button
                        key={m}
                        disabled={isRunning}
                        onClick={() => setAppMode(m)}
                        style={{
                            padding: "6px 16px",
                            borderRadius: 6,
                            border: "none",
                            cursor: isRunning ? "default" : "pointer",
                            background: appMode === m ? "#4f46e5" : "#374151",
                            color: "#fff",
                            fontWeight: appMode === m ? "bold" : "normal",
                        }}
                    >
                        {m === 'landmarks' ? 'Landmarks' : 'Filters'}
                    </button>
                ))}
            </div>

            {warnings.length > 0 && (
                <div style={{marginBottom: 12, padding: 8, background: "#fef3c7", borderRadius: 8, color: "#92400e"}}>
                    {warnings.map((w, i) => <div key={i}>Hinweis: {w}</div>)}
                </div>
            )}

            <div style={{display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap"}}>
                {appMode === 'landmarks' && (
                    <div style={{display: "flex", gap: 4}}>
                        {(["face", "hand", "combined"] as TrackingMode[]).map(m => (
                            <button
                                key={m}
                                disabled={isRunning}
                                onClick={() => setMode(m)}
                                style={{
                                    padding: "6px 16px",
                                    borderRadius: 6,
                                    border: "none",
                                    cursor: isRunning ? "default" : "pointer",
                                    background: mode === m ? "#4f46e5" : "#374151",
                                    color: "#fff",
                                    fontWeight: mode === m ? "bold" : "normal",
                                    textTransform: "capitalize",
                                }}
                            >
                                {m}
                            </button>
                        ))}
                    </div>
                )}

                {appMode === 'filters' && (
                    <div style={{display: "flex", gap: 6, alignItems: "center"}}>
                        <span style={{color: "#9ca3af", fontSize: 13}}>Filters:</span>
                        {FILTER_IDS.map(id => (
                            <button
                                key={id}
                                onClick={() => handleFilterToggle(id)}
                                style={{
                                    padding: "4px 12px",
                                    borderRadius: 6,
                                    border: "2px solid",
                                    borderColor: activeFilters[id] ? "#10b981" : "#4b5563",
                                    cursor: "pointer",
                                    background: activeFilters[id] ? "#064e3b" : "#1f2937",
                                    color: activeFilters[id] ? "#10b981" : "#9ca3af",
                                    fontWeight: activeFilters[id] ? "bold" : "normal",
                                    fontSize: 13,
                                }}
                            >
                                {FILTER_LABELS[id]}
                            </button>
                        ))}
                    </div>
                )}

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

                {import.meta.env.VITE_UX_SURVEY_URL && (
                    <a
                        href={`${import.meta.env.VITE_UX_SURVEY_URL}${import.meta.env.VITE_UX_SURVEY_URL.includes('?') ? '&' : '?'}platform=PWA`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                            padding: "6px 12px",
                            borderRadius: 6,
                            background: "#0ea5e9",
                            color: "#fff",
                            textDecoration: "none",
                            fontSize: 13,
                        }}
                    >
                        UX Feedback
                    </a>
                )}

                <span style={{opacity: 0.8}}>
                    Status: {isRunning ? "läuft" : "gestoppt"}
                    {isRunning && !performanceMetrics?.warmupComplete && " (Warmup...)"}
                    {isUploading && " | Sende Daten..."}
                    {uploadStatus === "success" && " | Daten gesendet ✓"}
                    {uploadStatus === "skipped" && " | Nicht gesendet (kein mobiles Gerät)"}
                    {uploadStatus === "error" && " | Fehler beim Senden"}
                </span>
            </div>

            {showSettings && (
                <div style={{marginBottom: 12, padding: 12, background: "#1f2937", borderRadius: 8, color: "#e5e7eb"}}>
                    <h3 style={{margin: "0 0 8px 0", fontSize: 14}}>Einstellungen</h3>
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
                    <div style={{marginBottom: 8}}>
                        <label style={{display: "flex", alignItems: "center", gap: 8}}>
                            <input
                                type="checkbox"
                                checked={showDebug}
                                onChange={(e) => setShowDebug(e.target.checked)}
                            />
                            F14: Debug-HUD (Koordinaten + Tracking-Status)
                        </label>
                    </div>
                    <div style={{marginBottom: 8}}>
                        <label style={{display: "flex", alignItems: "center", gap: 8}}>
                            <input
                                type="checkbox"
                                disabled={isRunning}
                                checked={threading === "worker"}
                                onChange={(e) => setThreading(e.target.checked ? "worker" : "main")}
                            />
                            Inferenz im Web Worker (statt im Main-Thread)
                        </label>
                        <div style={{marginLeft: 24, marginTop: 4, fontSize: 12, color: "#9ca3af"}}>
                            Der Worker entspricht dem Async-Runner der Native-App. Wird pro
                            Messung als <code>inferenceThreading</code> mitgesendet.
                            {isRunning && " Nur zwischen Sessions umschaltbar."}
                        </div>
                    </div>
                    <div style={{fontSize: 12, color: "#9ca3af"}}>
                        F11: Warmup-Phase: {performanceMetrics?.warmupComplete
                            ? "Abgeschlossen"
                            : `Läuft (${WARMUP_FRAMES} Frames)`}
                    </div>
                </div>
            )}

            {displayError && (
                <div style={{marginBottom: 12, color: "crimson"}}>Fehler: {displayError}</div>
            )}

            <div style={{position: "relative", width: "100%", background: "#111827", borderRadius: 12, overflow: "hidden"}}>
                {!isRunning && (
                    <div style={{
                        position: "absolute", inset: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        color: "#6b7280", flexDirection: "column", gap: 8,
                    }}>
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z"/>
                        </svg>
                        <span>Drücke Start um die Kamera zu aktivieren</span>
                    </div>
                )}

                <video
                    ref={videoRef}
                    playsInline
                    muted
                    style={{
                        width: "100%", height: "100%",
                        objectFit: "cover",
                        transform: "scaleX(-1)",
                        display: isRunning ? "block" : "none",
                    }}
                />

                {/* Landmark canvas — landmarks mode only.
                    Deliberately NOT CSS-mirrored: selfie mirroring is applied by
                    projectNormalized, the same way the filter overlays get it. */}
                <div style={{
                    position: "absolute", inset: 0,
                    display: isRunning && appMode === 'landmarks' ? "block" : "none",
                }}>
                    <canvas
                        ref={canvasRef}
                        style={{position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none"}}
                    />
                </div>

                {/* AR filter overlay — filter mode only */}
                {isRunning && appMode === 'filters' && (
                    <FilterOverlay
                        ref={filterOverlayRef}
                        activeFilters={activeFilters}
                        width={overlayDims.width}
                        height={overlayDims.height}
                    />
                )}

                {isRunning && (
                    <PerformanceOverlay
                        metrics={performanceMetrics}
                        visible={showPerformance}
                        debug={showDebug}
                        tracking={latestTracking}
                    />
                )}
            </div>
        </div>
    );
}
