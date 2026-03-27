import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import type {TrackingDTO, PerformanceMetricsDTO, TrackingMode} from "../domain/tracking.dto";
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
import type {ActiveFilters, FilterId} from "../filters/types";
import {DEFAULT_ACTIVE_FILTERS, FILTER_IDS, FILTER_LABELS} from "../filters/types";
import {FilterOverlay} from "../filters/FilterOverlay";

type AppMode = 'landmarks' | 'filters';

export function CameraScreen() {
    const rafRef = useRef<number | null>(null);

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

    const [isUploading, setIsUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState<"success" | "error" | null>(null);

    // Filter overlay dimensions (updated lazily from RAF loop)
    const [overlayDims, setOverlayDims] = useState({ width: 0, height: 0 });
    const overlayDimsRef = useRef({ width: 0, height: 0 });

    const camera = useCamera();

    const [controller, setController] = useState<TrackingController | null>(null);
    const sessionModeRef = useRef<TrackingMode>(mode);
    const performanceTrackerRef = useRef<PerformanceTracker | null>(null);
    const smootherRef = useRef<LandmarkSmoother | null>(null);
    const dynamicInferenceRef = useRef<DynamicInferenceController | null>(null);
    const metricsIntervalRef = useRef<number | null>(null);
    const frameCountRef = useRef(0);

    // Refs to avoid stale closures inside the RAF loop
    const filterTrackingRef = useRef<TrackingDTO | null>(null);
    const appModeRef = useRef<AppMode>('landmarks');
    const activeFiltersRef = useRef<ActiveFilters>(DEFAULT_ACTIVE_FILTERS);

    useEffect(() => { appModeRef.current = appMode; }, [appMode]);
    useEffect(() => { activeFiltersRef.current = activeFilters; }, [activeFilters]);

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
            const caps = await checkDeviceCapabilities();
            setDeviceCapabilities(caps);
            setWarnings(caps.warnings);
            if (caps.errors.length > 0) setError(caps.errors.join(" "));
            setIsCheckingDevice(false);
        })();
    }, []);

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
        const finalMetrics = performanceTrackerRef.current?.getMetrics();
        const sessionMode = sessionModeRef.current;
        const currentlyActive = (Object.keys(activeFiltersRef.current) as FilterId[])
            .filter(k => activeFiltersRef.current[k]);

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
        filterTrackingRef.current = null;

        controller?.close();
        setController(null);
        camera.stop();
        setPerformanceMetrics(null);
        frameCountRef.current = 0;

        if (finalMetrics && finalMetrics.frameCount > 0) {
            setIsUploading(true);
            setUploadStatus(null);
            try {
                const response = await submitTrackingSession(sessionMode, finalMetrics, currentlyActive);
                setUploadStatus(response ? "success" : "error");
            } catch {
                setUploadStatus("error");
            } finally {
                setIsUploading(false);
                setTimeout(() => setUploadStatus(null), 3000);
            }
        }
    }, [controller, camera]);

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

            const video = camera.videoRef.current;
            if (!video) throw new Error("Video element fehlt.");

            const { controller: c, modelLoadTimeMs } = await TrackingController.init(effectiveMode, {maxFaces: 1, maxHands: 2});
            setController(c);

            const perfTracker = new PerformanceTracker();
            perfTracker.setModelLoadTime(modelLoadTimeMs);
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

            // Initialize overlay dimensions immediately
            const initW = video.clientWidth || 0;
            const initH = video.clientHeight || 0;
            overlayDimsRef.current = { width: initW, height: initH };
            setOverlayDims({ width: initW, height: initH });

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

            let cachedWidth = initW;
            let cachedHeight = initH;
            let dimCheckCounter = 0;

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

                dimCheckCounter++;
                if (dimCheckCounter >= 60) {
                    dimCheckCounter = 0;
                    const newW = v.clientWidth;
                    const newH = v.clientHeight;
                    if (newW !== cachedWidth || newH !== cachedHeight) {
                        cachedWidth = newW;
                        cachedHeight = newH;
                        overlayDimsRef.current = { width: newW, height: newH };
                        setOverlayDims({ width: newW, height: newH });
                    }
                }

                const frameStart = pt?.recordFrameStart() ?? 0;
                const ts = performance.now();

                const inferenceStart = performance.now();
                let dto = c.detect(v, ts, effectiveMode);
                pt?.recordInferenceTime(inferenceStart);

                if (sm) dto = sm.smooth(dto);

                const facesCount = dto.face?.faces?.length ?? 0;
                const handsCount = dto.hand?.hands?.length ?? 0;
                pt?.recordDetection(facesCount, handsCount);
                pt?.recordFrameEnd(frameStart, facesCount > 0 || handsCount > 0);

                if (appModeRef.current === 'landmarks') {
                    renderOverlay(dto, cachedWidth, cachedHeight);
                } else {
                    // FilterOverlay drives its own RAF, reading this ref each frame
                    filterTrackingRef.current = dto;
                }

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

    // Restart tracking when mode or appMode changes while running
    const prevModeRef = useRef(mode);
    const prevAppModeRef = useRef<AppMode>('landmarks');
    useEffect(() => {
        if (!isRunning) return;
        if (prevModeRef.current === mode && prevAppModeRef.current === appMode) return;
        prevModeRef.current = mode;
        prevAppModeRef.current = appMode;
        (async () => {
            await stop();
            await start();
        })().catch(() => {});
    }, [isRunning, mode, appMode, start, stop]);

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

                <span style={{opacity: 0.8}}>
                    Status: {isRunning ? "läuft" : "gestoppt"}
                    {isRunning && !performanceMetrics?.warmupComplete && " (Warmup...)"}
                    {isUploading && " | Sende Daten..."}
                    {uploadStatus === "success" && " | Daten gesendet ✓"}
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
                    <div style={{fontSize: 12, color: "#9ca3af"}}>
                        F11: Warmup-Phase: {performanceMetrics?.warmupComplete ? "Abgeschlossen" : "Läuft (30 Frames)"}
                    </div>
                </div>
            )}

            {error && (
                <div style={{marginBottom: 12, color: "crimson"}}>Fehler: {error}</div>
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
                    ref={camera.videoRef}
                    playsInline
                    muted
                    style={{
                        width: "100%", height: "100%",
                        objectFit: "cover",
                        transform: "scaleX(-1)",
                        display: isRunning ? "block" : "none",
                    }}
                />

                {/* Landmark canvas — landmarks mode only */}
                <div style={{
                    position: "absolute", inset: 0,
                    transform: "scaleX(-1)",
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
                        trackingRef={filterTrackingRef}
                        activeFilters={activeFilters}
                        width={overlayDims.width}
                        height={overlayDims.height}
                    />
                )}

                {isRunning && (
                    <PerformanceOverlay metrics={performanceMetrics} visible={showPerformance}/>
                )}
            </div>
        </div>
    );
}
