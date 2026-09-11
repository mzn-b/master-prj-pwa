import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import type {TrackingDTO, PerformanceMetricsDTO, TrackingMode} from "../domain/tracking.dto";
import {
    createEngine,
    type EngineResult,
    type InferenceThreading,
    type TrackingEngine,
} from "../tracking/engines";
import {subscribeToVideoFrames} from "../tracking/videoFrames";
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
import {color, s} from "../ui/theme";
import {Switch} from "../ui/Switch";
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
    const [showPerformance, setShowPerformance] = useState(false);
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
    const [threading, setThreading] = useState<InferenceThreading>("main");
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
            // The renderer initialises lazily, on the first draw after start, so
            // on the very first session of a page load `capabilities` is still
            // null when the run conditions are recorded — and that session lands
            // in the database with a null renderBackend. Push it again as soon
            // as it is known; setRunConditions merges, so this only fills the
            // gap. Observed on device: the first PWA run per device recorded no
            // backend while every later run recorded "webgpu".
            performanceTrackerRef.current?.setRunConditions({
                renderBackend: capabilities.backend,
            });
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

    const status = isUploading
        ? "Sende Daten…"
        : isRunning
          ? "Tracking aktiv"
          : uploadStatus === "success"
            ? "Daten gesendet"
            : uploadStatus === "error"
              ? "Senden fehlgeschlagen"
              : uploadStatus === "skipped"
                ? "Nicht gesendet (kein mobiles Gerät)"
                : "Tracking gestoppt";

    const surveyUrl = import.meta.env.VITE_UX_SURVEY_URL
        ? `${import.meta.env.VITE_UX_SURVEY_URL}${
              import.meta.env.VITE_UX_SURVEY_URL.includes("?") ? "&" : "?"
          }platform=PWA`
        : null;

    /** One settings row: label left, switch right — SettingsSheet.tsx. */
    const toggle = (label: string, value: boolean, onChange: (next: boolean) => void, disabled = false) => (
        <label style={{...s.settingsRow, opacity: disabled ? 0.5 : 1}}>
            <span style={s.settingsLabel}>{label}</span>
            <Switch label={label} checked={value} disabled={disabled} onChange={onChange} />
        </label>
    );

    return (
        <div style={s.root}>
            <div style={s.preview}>
                {!isRunning && (
                    <div style={s.placeholder}>
                        {isCheckingDevice
                            ? "Gerät wird geprüft…"
                            : canStart
                              ? "Bereit — Start drücken"
                              : "Kamerazugriff erforderlich"}
                    </div>
                )}

                <video
                    ref={videoRef}
                    playsInline
                    muted
                    style={{
                        position: "absolute",
                        inset: 0,
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                        transform: "scaleX(-1)",
                        display: isRunning ? "block" : "none",
                    }}
                />

                {/* Landmark canvas — landmarks mode only. Deliberately NOT
                    CSS-mirrored: selfie mirroring is applied by projectNormalized,
                    the same way the filter overlays get it. */}
                <div
                    style={{
                        position: "absolute",
                        inset: 0,
                        display: isRunning && appMode === "landmarks" ? "block" : "none",
                    }}
                >
                    <canvas
                        ref={canvasRef}
                        style={{position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none"}}
                    />
                </div>

                {isRunning && appMode === "filters" && (
                    <FilterOverlay
                        ref={filterOverlayRef}
                        activeFilters={activeFilters}
                        width={overlayDims.width}
                        height={overlayDims.height}
                    />
                )}

                <div style={s.hudLayer}>
                    {isRunning && (
                        <PerformanceOverlay
                            metrics={performanceMetrics}
                            visible={showPerformance}
                            debug={showDebug}
                            tracking={latestTracking}
                            currentFrameSkip={currentFrameSkip}
                        />
                    )}
                </div>
            </div>

            <div style={s.panel}>
                <div style={s.panelContent}>
                    {/* SessionControls.tsx: one button that flips Start/Stop, then a status dot. */}
                    <div style={s.controlRow}>
                        <button
                            onClick={isRunning ? stop : start}
                            disabled={isRunning ? false : !canStart}
                            style={{
                                ...s.button,
                                background: isRunning
                                    ? color.stop
                                    : canStart
                                      ? color.primary
                                      : color.muted,
                                cursor: isRunning || canStart ? "pointer" : "default",
                            }}
                        >
                            {isRunning ? "Stop" : "Start"}
                        </button>
                        <div style={s.statusRow}>
                            <div
                                style={{
                                    ...s.dot,
                                    background: isRunning ? color.dotActive : color.dotIdle,
                                }}
                            />
                            <span style={s.status}>{status}</span>
                        </div>
                    </div>

                    {displayError && <div style={s.error}>Kamera: {displayError}</div>}
                    {warnings.map(w => (
                        <div key={w} style={s.warning}>
                            {w}
                        </div>
                    ))}

                    <div style={s.row}>
                        {(["landmarks", "filters"] as AppMode[]).map(candidate => (
                            <button
                                key={candidate}
                                onClick={() => !isRunning && setAppMode(candidate)}
                                style={{
                                    ...s.tab,
                                    ...(appMode === candidate
                                        ? {background: color.primary, fontWeight: 700}
                                        : {}),
                                }}
                            >
                                {candidate === "landmarks" ? "Landmarks" : "Filters"}
                            </button>
                        ))}
                    </div>

                    {appMode === "landmarks" ? (
                        <div style={s.row}>
                            {(["face", "hand", "combined"] as TrackingMode[]).map(candidate => (
                                <button
                                    key={candidate}
                                    disabled={isRunning}
                                    onClick={() => setMode(candidate)}
                                    style={{
                                        ...s.chip,
                                        ...(mode === candidate ? {background: color.primary} : {}),
                                        ...(isRunning ? {opacity: 0.5, cursor: "default"} : {}),
                                    }}
                                >
                                    {candidate}
                                </button>
                            ))}
                        </div>
                    ) : (
                        <div style={s.row}>
                            {FILTER_IDS.map(id => (
                                <button
                                    key={id}
                                    onClick={() => handleFilterToggle(id)}
                                    style={{
                                        ...s.filterChip,
                                        ...(activeFilters[id]
                                            ? {borderColor: color.primary, background: color.filterActive}
                                            : {}),
                                    }}
                                >
                                    {FILTER_LABELS[id]}
                                </button>
                            ))}
                        </div>
                    )}

                    {/* SettingsSheet.tsx — always visible in the panel, not behind a button. */}
                    <div style={s.settingsCard}>
                        {toggle("F9: Glättung (One Euro)", smoothingEnabled, setSmoothingEnabled)}
                        {toggle("F15: Dynamische Inferenzrate", dynamicInferenceEnabled, setDynamicInferenceEnabled)}
                        {toggle("Performance-HUD", showPerformance, setShowPerformance)}
                        {toggle("F14: Debug-HUD", showDebug, setShowDebug)}
                        {/* No native counterpart: the threading toggle exists only on
                            the web side, because only the web has two options to
                            compare. Kept last so the shared rows line up. */}
                        {toggle(
                            "Inferenz im Web Worker",
                            threading === "worker",
                            next => setThreading(next ? "worker" : "main"),
                            isRunning,
                        )}
                        {surveyUrl && (
                            <a href={surveyUrl} target="_blank" rel="noopener noreferrer" style={s.surveyButton}>
                                UX Feedback
                            </a>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
