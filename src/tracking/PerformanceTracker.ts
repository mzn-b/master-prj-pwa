/**
 * PerformanceTracker - Efficient circular buffer implementation
 * Collects FPS, inference time, and hardware metrics
 * Uses O(1) circular buffers instead of O(n) array.shift()
 */

import type { PerformanceMetricsDTO, TrackingDTO } from "../domain/tracking.dto";

/**
 * F11 — frames discarded before min/max fps start being recorded, so first-frame
 * model warmup and JIT do not show up as the worst measurement of the session.
 * Exported because the tests and the settings panel both need the real number
 * rather than a copy of it.
 */
export const WARMUP_FRAMES = 30;
const BUFFER_SIZE = 60;

/** MediaPipe face-mesh nose tip — the landmark used as the jitter reference. */
const NOSE_TIP_INDEX = 1;

/** Rounding helpers — undefined passes through, so a missing metric stays missing. */
const round1 = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 10) / 10);
const round3 = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 1000) / 1000);
const round5 = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 100000) / 100000);

/** O(1) circular buffer for time series data */
/**
 * Every sample of one session, for percentiles.
 *
 * The CircularBuffer below is a 60-sample rolling window, which is right for the
 * live HUD but wrong for a session summary: percentiles taken over it would
 * describe the last few seconds, not the run. This keeps the whole session.
 *
 * Cost is negligible beside the ~520 point objects MediaPipe allocates per frame:
 * a five-minute run at 30 fps is 9000 doubles, about 72 KB.
 */
class SampleSeries {
    private samples: number[] = [];

    push(value: number): void {
        this.samples.push(value);
    }

    reset(): void {
        this.samples = [];
    }

    get count(): number {
        return this.samples.length;
    }

    get mean(): number | undefined {
        if (this.samples.length === 0) return undefined;
        let total = 0;
        for (const v of this.samples) total += v;
        return total / this.samples.length;
    }

    /**
     * Nearest-rank percentile: the smallest sample at or above the given rank.
     * No interpolation, so a reported p95 is a value that actually occurred.
     * `p` is 0..1. Sorts a copy, since ordering the live array would corrupt it.
     */
    percentile(p: number): number | undefined {
        if (this.samples.length === 0) return undefined;
        const sorted = [...this.samples].sort((a, b) => a - b);
        const rank = Math.ceil(p * sorted.length);
        return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
    }
}

class CircularBuffer {
    private buffer: Float64Array;
    private index = 0;
    private count = 0;
    private sum = 0;

    constructor(size: number) {
        this.buffer = new Float64Array(size);
    }

    push(value: number): void {
        if (this.count === this.buffer.length) {
            this.sum -= this.buffer[this.index];
        } else {
            this.count++;
        }
        this.buffer[this.index] = value;
        this.sum += value;
        this.index = (this.index + 1) % this.buffer.length;
    }

    average(): number {
        return this.count > 0 ? this.sum / this.count : 0;
    }

    last(): number {
        if (this.count === 0) return 0;
        const idx = (this.index - 1 + this.buffer.length) % this.buffer.length;
        return this.buffer[idx];
    }

    reset(): void {
        this.buffer.fill(0);
        this.index = 0;
        this.count = 0;
        this.sum = 0;
    }
}


/**
 * Time from navigation start until the page became interactive.
 *
 * `domInteractive` is the closest web equivalent of "the app is usable": the
 * document is parsed and scripts have run. It includes what makes a PWA's
 * startup different from a native app's — fetching the shell over the network or
 * out of the service-worker cache, booting the JavaScript engine, and evaluating
 * the bundle — which is exactly the difference this study exists to measure and
 * which `modelLoadTimeMs` (measured after the app is already running) hides.
 *
 * Not directly comparable with the native figure, which is measured from process
 * start: the browser is already running before navigation begins. Treat it as
 * "time to interactive within the app's own lifetime" on both sides, and say so.
 */
function readAppStartupMs(): number | undefined {
    try {
        const [nav] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
        if (nav && nav.domInteractive > 0) {
            return Math.round(nav.domInteractive * 10) / 10;
        }
    } catch {
        // Not available in every context; a missing reading is a null column.
    }
    return undefined;
}

export class PerformanceTracker {
    private startTime = 0;
    private frameCount = 0;
    private droppedFrames = 0;
    private trackingLostCount = 0;
    private lastFrameTime = 0;
    private warmupComplete = false;
    private lastTrackingValid = false;

    // Session-wide series, for the percentiles submitted with the session.
    private inferenceSeries = new SampleSeries();
    private frameIntervalSeries = new SampleSeries();
    private renderSeries = new SampleSeries();
    // Detection quality, accumulated per frame.
    private gestureConfidenceSum = 0;
    private gestureConfidenceCount = 0;
    private blendshapeActivationSum = 0;
    private blendshapeActivationCount = 0;
    // F15 governor behaviour, sampled per camera frame.
    private frameSkipSum = 0;
    private frameSkipCount = 0;
    private frameSkipMax = 0;
    private droppedFramesGovernor = 0;
    private droppedFramesBusy = 0;
    private landmarkDeltaSum = 0;
    private landmarkDeltaCount = 0;
    private lastNose?: { x: number; y: number };
    /**
     * NF3 — time from the app becoming interactive to this session starting.
     *
     * Taken from the navigation timeline, so it spans the browser's own startup:
     * fetching the shell, booting the JS engine and hydrating React. The native
     * app measures the equivalent from process start. This is where the PWA and
     * native differ most and it was previously unmeasured.
     */
    private appStartupMs?: number;

    private frameTimes = new CircularBuffer(BUFFER_SIZE);
    private inferenceTimes = new CircularBuffer(BUFFER_SIZE);
    private processingTimes = new CircularBuffer(BUFFER_SIZE);

    private minFps = Infinity;
    private maxFps = 0;

    // Detection tracking
    private totalFacesDetected = 0;
    private totalHandsDetected = 0;
    private detectionFrameCount = 0;

    // Stability tracking
    private peakMemoryUsageMB = 0;
    // Session-level consumption baselines (snapshotted lazily on first getMetrics call)
    private batteryLevelStart: number | undefined;
    private memoryUsageStartMB: number | undefined;
    private errorCount = 0;
    private trackingLostTime = 0;
    private totalRecoveryTimeMs = 0;
    private recoveryCount = 0;
    private currentConsecutiveLoss = 0;
    private consecutiveTrackingLossMax = 0;

    // Model load time and GPU delegate status (set externally)
    private modelLoadTimeMs: number | undefined;
    private gpuDelegateActive: boolean | undefined;

    /** NF3 — performance.now() of the first frame that produced a detection. */
    private firstDetectionAt: number | undefined;
    /**
     * NF4 — the conditions this session ran under. Without them two rows that
     * differ only in capture resolution or threading model are indistinguishable
     * in the dataset. The native app records the same four.
     */
    private runConditions: {
        frameWidth?: number;
        frameHeight?: number;
        renderBackend?: string;
        inferenceThreading?: string;
        smoothingEnabled?: boolean;
        dynamicInferenceEnabled?: boolean;
    } = {};

    // Cached hardware info (queried once at construction)
    private batteryManager: BatteryManager | null = null;
    private cpuCores: number | undefined;
    private gpuVendor: string | undefined;
    private gpuRenderer: string | undefined;
    private totalDeviceMemoryMB: number | undefined;

    // Compute Pressure API (thermalState equivalent, Chrome 125+)
    private computePressureState: string | undefined;

    constructor() {
        this.initBattery();
        this.initHardwareInfo();
        this.initComputePressure();
    }

    private async initBattery(): Promise<void> {
        try {
            if ("getBattery" in navigator) {
                this.batteryManager = await (navigator as NavigatorWithBattery).getBattery();
            }
        } catch { /* Battery API not available */ }
    }

    private initHardwareInfo(): void {
        this.cpuCores = navigator.hardwareConcurrency;

        // Physical device RAM via Device Memory API (returns GB, rounded to nearest power of 2)
        const deviceMemoryGB = (navigator as NavigatorWithDeviceMemory).deviceMemory;
        if (deviceMemoryGB !== undefined) {
            this.totalDeviceMemoryMB = deviceMemoryGB * 1024;
        }

        // GPU info via WebGL debug extension
        try {
            const canvas = document.createElement("canvas");
            const gl = canvas.getContext("webgl");
            if (gl) {
                const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
                if (debugInfo) {
                    this.gpuVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) as string;
                    this.gpuRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string;
                }
                const ext = gl.getExtension("WEBGL_lose_context");
                ext?.loseContext();
            }
        } catch { /* WebGL not available */ }
    }

    private initComputePressure(): void {
        // Compute Pressure API — maps CPU pressure to thermalState-equivalent values.
        // Available in Chrome 125+ (behind origin trial in earlier versions).
        // States: 'nominal' | 'fair' | 'serious' | 'critical' — matches iOS thermal state naming.
        try {
            const PressureObserverCtor = (window as WindowWithPressure).PressureObserver;
            if (typeof PressureObserverCtor === "function") {
                const observer = new PressureObserverCtor((records: PressureRecord[]) => {
                    const latest = records[records.length - 1];
                    if (latest) this.computePressureState = latest.state;
                });
                // The observer is retained by the browser once observe() is called —
                // no need to hold a JS-side reference.
                observer.observe("cpu").catch(() => { /* not supported on this device */ });
            }
        } catch { /* Compute Pressure API not available */ }
    }

    start(): void {
        this.startTime = performance.now();
        this.lastFrameTime = this.startTime;
        this.frameCount = 0;
        this.droppedFrames = 0;
        this.trackingLostCount = 0;
        this.warmupComplete = false;
        this.lastTrackingValid = false;
        this.minFps = Infinity;
        this.maxFps = 0;
        this.frameTimes.reset();
        this.inferenceTimes.reset();
        this.processingTimes.reset();
        this.totalFacesDetected = 0;
        this.totalHandsDetected = 0;
        this.detectionFrameCount = 0;
        this.peakMemoryUsageMB = 0;
        this.batteryLevelStart = undefined;
        this.memoryUsageStartMB = undefined;
        this.errorCount = 0;
        this.inferenceSeries.reset();
        this.frameIntervalSeries.reset();
        this.renderSeries.reset();
        this.gestureConfidenceSum = 0;
        this.gestureConfidenceCount = 0;
        this.blendshapeActivationSum = 0;
        this.blendshapeActivationCount = 0;
        this.frameSkipSum = 0;
        this.frameSkipCount = 0;
        this.frameSkipMax = 0;
        this.droppedFramesGovernor = 0;
        this.droppedFramesBusy = 0;
        this.landmarkDeltaSum = 0;
        this.landmarkDeltaCount = 0;
        this.lastNose = undefined;
        this.appStartupMs = readAppStartupMs();
        this.trackingLostTime = 0;
        this.totalRecoveryTimeMs = 0;
        this.recoveryCount = 0;
        this.currentConsecutiveLoss = 0;
        this.consecutiveTrackingLossMax = 0;
        this.firstDetectionAt = undefined;
    }

    /**
     * Resets all counters and buffers while keeping hardware info cached.
     * Used when submitting a mid-session checkpoint (e.g. on filter toggle)
     * so that the next session starts fresh.
     */
    reset(): void {
        this.startTime = performance.now();
        this.lastFrameTime = this.startTime;
        this.frameCount = 0;
        this.droppedFrames = 0;
        this.trackingLostCount = 0;
        this.warmupComplete = false;
        this.lastTrackingValid = false;
        this.minFps = Infinity;
        this.maxFps = 0;
        this.frameTimes.reset();
        this.inferenceTimes.reset();
        this.processingTimes.reset();
        this.totalFacesDetected = 0;
        this.totalHandsDetected = 0;
        this.detectionFrameCount = 0;
        this.peakMemoryUsageMB = 0;
        this.batteryLevelStart = undefined;
        this.memoryUsageStartMB = undefined;
        this.errorCount = 0;
        this.trackingLostTime = 0;
        this.totalRecoveryTimeMs = 0;
        this.recoveryCount = 0;
        this.currentConsecutiveLoss = 0;
        this.consecutiveTrackingLossMax = 0;
        this.modelLoadTimeMs = undefined;
    }

    setModelLoadTime(timeMs: number): void {
        this.modelLoadTimeMs = timeMs;
    }

    setGpuDelegateActive(active: boolean): void {
        this.gpuDelegateActive = active;
    }

    setRunConditions(conditions: {
        frameWidth?: number;
        frameHeight?: number;
        renderBackend?: string;
        inferenceThreading?: string;
        smoothingEnabled?: boolean;
        dynamicInferenceEnabled?: boolean;
    }): void {
        this.runConditions = { ...this.runConditions, ...conditions };
    }

    recordError(): void {
        this.errorCount++;
    }

    /**
     * F15/NF-comparability: a frame the pipeline saw but did not run inference on.
     *
     * Two things produce one in the PWA: the dynamic-inference governor skipping
     * a frame (`frameCount % frameSkip !== 0`), and a frame whose video timestamp
     * had not advanced, which MediaPipe refuses. Both are genuinely dropped work.
     *
     * This used to be declared, reset and submitted but never incremented, so every
     * PWA session reported a hard 0 — not a measurement, and directly misleading
     * next to the native app's real figure. The native app counts the same two
     * events (governor skip, and the async runner reporting itself busy) so the
     * column means the same thing on both platforms.
     */
    /**
     * A camera frame that reached the pipeline and produced no inference.
     *
     * The cause is required rather than defaulted: "the governor skipped it"
     * and "the device could not keep up" are opposite findings, and a wrong
     * default would silently attribute one to the other. `droppedFrames` stays
     * the total, so the existing column keeps its meaning.
     */
    recordDroppedFrame(cause: "governor" | "busy", count = 1): void {
        this.droppedFrames += count;
        if (cause === "governor") {
            this.droppedFramesGovernor += count;
        } else {
            this.droppedFramesBusy += count;
        }
    }

    /**
     * F15 — the divider in force for this camera frame. Called once per camera
     * frame including skipped ones, so the mean is time-weighted rather than
     * weighted by completed inferences.
     */
    recordFrameSkip(skip: number): void {
        if (!Number.isFinite(skip) || skip < 1) return;
        this.frameSkipSum += skip;
        this.frameSkipCount++;
        if (skip > this.frameSkipMax) this.frameSkipMax = skip;
    }

    recordDetection(facesCount: number, handsCount: number): void {
        this.totalFacesDetected += facesCount;
        this.totalHandsDetected += handsCount;
        this.detectionFrameCount++;
    }


    /**
     * F4/F11 — time spent drawing one frame.
     *
     * Kept separate from inference because the two platforms draw with different
     * engines (Skia on native, WebGPU/WebGL here) and the cost was previously
     * invisible: frameProcessingTimeMs brackets the detect call, so every
     * comparison silently attributed the whole frame to inference.
     */
    recordRenderMs(durationMs: number): void {
        this.renderSeries.push(durationMs);
    }

    /**
     * Detection quality, from what MediaPipe itself reports.
     *
     * Called once per completed inference with the DTO that was produced. Every
     * other metric here measures speed; the iOS orientation defect degraded
     * accuracy for weeks while all of them looked healthy.
     */
    recordDetectionQuality(dto: TrackingDTO | null): void {
        if (!dto) return;

        // MediaPipe's own confidence in the gesture it classified.
        for (const hand of dto.hand?.hands ?? []) {
            if (typeof hand.gestureScore === "number") {
                this.gestureConfidenceSum += hand.gestureScore;
                this.gestureConfidenceCount++;
            }
        }

        const face = dto.face?.faces[0];
        if (face) {
            // The strongest-firing blendshape: a proxy for how decisively the
            // face model is responding rather than emitting a neutral mask.
            const shapes = face.blendshapes;
            if (shapes && shapes.length > 0) {
                let top = 0;
                for (const shape of shapes) {
                    if (shape.score > top) top = shape.score;
                }
                this.blendshapeActivationSum += top;
                this.blendshapeActivationCount++;
            }

            // Jitter: frame-to-frame movement of the nose tip while tracking
            // holds. Normalized units, so it is resolution-independent and
            // comparable across arms. Low is stable.
            const nose = face.landmarks[NOSE_TIP_INDEX];
            if (nose) {
                if (this.lastNose) {
                    const dx = nose.x - this.lastNose.x;
                    const dy = nose.y - this.lastNose.y;
                    this.landmarkDeltaSum += Math.hypot(dx, dy);
                    this.landmarkDeltaCount++;
                }
                this.lastNose = { x: nose.x, y: nose.y };
            } else {
                this.lastNose = undefined;
            }
        } else {
            // Tracking lost: the next delta would measure re-acquisition, not jitter.
            this.lastNose = undefined;
        }
    }

    recordFrameStart(): number {
        return performance.now();
    }

    /**
     * NF4 — end-to-end: frame available to landmarks ready, including the video
     * texture upload into WASM and the conversion of the raw output into points.
     * The native app brackets the same span, including its own image conversion,
     * so the two numbers describe the same work.
     */
    recordInferenceTime(startTime: number): void {
        const duration = performance.now() - startTime;
        this.inferenceTimes.push(duration);
        this.inferenceSeries.push(duration);
    }

    /**
     * Same measurement, already computed.
     *
     * The worker path times a frame across a round trip, so the caller holds the
     * duration rather than a start instant on this thread's clock.
     */
    recordInferenceMs(durationMs: number): void {
        this.inferenceTimes.push(durationMs);
        this.inferenceSeries.push(durationMs);
    }

    recordFrameEnd(frameStart: number, hasTracking: boolean): void {
        const now = performance.now();
        this.processingTimes.push(now - frameStart);
        this.frameCount++;

        // NF3 — how long the user waits for the first usable result.
        if (hasTracking && this.firstDetectionAt === undefined) {
            this.firstDetectionAt = now;
        }

        const frameTime = now - this.lastFrameTime;
        this.lastFrameTime = now;

        if (frameTime > 0) {
            this.frameTimes.push(frameTime);
            this.frameIntervalSeries.push(frameTime);

            if (this.warmupComplete) {
                const fps = 1000 / frameTime;
                if (fps < this.minFps) this.minFps = fps;
                if (fps > this.maxFps) this.maxFps = fps;
            }
        }

        // Track tracking loss events and recovery time
        if (this.lastTrackingValid && !hasTracking) {
            this.trackingLostCount++;
            this.trackingLostTime = now;
            this.currentConsecutiveLoss = 1;
        } else if (!this.lastTrackingValid && hasTracking && this.trackingLostTime > 0) {
            // Recovered from tracking loss
            const recoveryTime = now - this.trackingLostTime;
            this.totalRecoveryTimeMs += recoveryTime;
            this.recoveryCount++;
            this.trackingLostTime = 0;
            this.currentConsecutiveLoss = 0;
        } else if (!hasTracking && !this.lastTrackingValid) {
            // Still lost — increment consecutive loss counter
            this.currentConsecutiveLoss++;
            if (this.currentConsecutiveLoss > this.consecutiveTrackingLossMax) {
                this.consecutiveTrackingLossMax = this.currentConsecutiveLoss;
            }
        }
        this.lastTrackingValid = hasTracking;

        // Complete warmup
        if (!this.warmupComplete && this.frameCount >= WARMUP_FRAMES) {
            this.warmupComplete = true;
            this.minFps = Infinity;
            this.maxFps = 0;
        }
    }

    getMetrics(): PerformanceMetricsDTO {
        const now = performance.now();
        const sessionDuration = now - this.startTime;
        const avgFrameTime = this.frameTimes.average();
        const fps = avgFrameTime > 0 ? 1000 / avgFrameTime : 0;
        const avgFps = sessionDuration > 0 ? (this.frameCount * 1000) / sessionDuration : 0;

        // JS heap memory (Chrome/Edge only)
        const perfMemory = (performance as PerformanceWithMemory).memory;
        const memoryUsageMB = perfMemory ? perfMemory.usedJSHeapSize / (1024 * 1024) : undefined;
        const heapLimitMB = perfMemory ? perfMemory.jsHeapSizeLimit / (1024 * 1024) : undefined;

        // Network metrics
        const connection = (navigator as NavigatorWithConnection).connection;

        // Track peak memory
        if (memoryUsageMB && memoryUsageMB > this.peakMemoryUsageMB) {
            this.peakMemoryUsageMB = memoryUsageMB;
        }

        // Lazy-snapshot baselines on first sample where the value is available.
        // Battery: the Battery API is async-initialized in the constructor — by the
        // time the first metrics tick fires it's typically ready. iOS/desktop browsers
        // that don't expose the API will leave batteryLevelStart undefined → delta null.
        // Reported as a percentage (0..100). The Battery Status API returns a
        // 0..1 fraction; Android's BATTERY_PROPERTY_CAPACITY returns 0..100.
        // They share the `battery_level*` columns, so without this normalisation
        // an Android row reading 78 and a PWA row reading 0.78 mean the same
        // thing and any aggregate mixing platforms is wrong by 100x.
        const rawLevel = this.batteryManager?.level;
        const batteryLevel = rawLevel !== undefined ? rawLevel * 100 : undefined;
        if (this.batteryLevelStart === undefined && batteryLevel !== undefined) {
            this.batteryLevelStart = batteryLevel;
        }
        if (this.memoryUsageStartMB === undefined && memoryUsageMB !== undefined) {
            this.memoryUsageStartMB = memoryUsageMB;
        }

        // Both operands are already percentages, so this is a plain difference
        // rounded to two decimals — the same number the field carried before.
        const batteryDeltaPercent = (this.batteryLevelStart !== undefined && batteryLevel !== undefined)
            ? Math.round((this.batteryLevelStart - batteryLevel) * 100) / 100
            : undefined;
        const memoryDeltaMB = (this.memoryUsageStartMB !== undefined && memoryUsageMB !== undefined)
            ? Math.round((memoryUsageMB - this.memoryUsageStartMB) * 10) / 10
            : undefined;

        // Calculate detection averages
        const facesDetectedAvg = this.detectionFrameCount > 0
            ? Math.round((this.totalFacesDetected / this.detectionFrameCount) * 100) / 100
            : undefined;
        const handsDetectedAvg = this.detectionFrameCount > 0
            ? Math.round((this.totalHandsDetected / this.detectionFrameCount) * 100) / 100
            : undefined;
        const detectionRate = sessionDuration > 0
            ? Math.round((this.detectionFrameCount * 1000 / sessionDuration) * 10) / 10
            : undefined;

        // Calculate average recovery time
        const trackingRecoveryTimeMs = this.recoveryCount > 0
            ? Math.round(this.totalRecoveryTimeMs / this.recoveryCount)
            : undefined;

        return {
            fps: Math.round(fps * 10) / 10,
            avgFps: Math.round(avgFps * 10) / 10,
            minFps: this.minFps === Infinity ? null : Math.round(this.minFps * 10) / 10,
            maxFps: this.maxFps === 0 ? null : Math.round(this.maxFps * 10) / 10,
            inferenceTimeMs: Math.round(this.inferenceTimes.last() * 100) / 100,
            avgInferenceTimeMs: Math.round(this.inferenceTimes.average() * 100) / 100,
            frameProcessingTimeMs: Math.round(this.processingTimes.last() * 100) / 100,
            avgFrameProcessingTimeMs: Math.round(this.processingTimes.average() * 100) / 100,
            memoryUsageMB: memoryUsageMB ? Math.round(memoryUsageMB * 10) / 10 : undefined,
            // totalMemoryMB: physical device RAM via Device Memory API (same semantics as native)
            totalMemoryMB: this.totalDeviceMemoryMB,
            heapLimitMB: heapLimitMB ? Math.round(heapLimitMB * 10) / 10 : undefined,
            cpuCores: this.cpuCores,
            gpuVendor: this.gpuVendor,
            gpuRenderer: this.gpuRenderer,
            gpuDelegateActive: this.gpuDelegateActive,
            // thermalState via Compute Pressure API (Chrome 125+), same state names as iOS
            thermalState: this.computePressureState,
            batteryLevel,
            batteryCharging: this.batteryManager?.charging,
            batteryLevelStart: this.batteryLevelStart,
            batteryLevelEnd: batteryLevel,
            batteryDeltaPercent,
            networkType: connection?.effectiveType,
            networkDownlinkMbps: connection?.downlink,
            networkRttMs: connection?.rtt,
            // Detection metrics
            facesDetectedAvg,
            handsDetectedAvg,
            detectionRate,
            // Model metrics
            modelLoadTimeMs: this.modelLoadTimeMs,
            // Session metrics
            frameCount: this.frameCount,
            droppedFrames: this.droppedFrames,
            sessionDurationMs: Math.round(sessionDuration),
            warmupComplete: this.warmupComplete,
            trackingLostCount: this.trackingLostCount,
            // Stability metrics
            peakMemoryUsageMB: this.peakMemoryUsageMB > 0 ? Math.round(this.peakMemoryUsageMB * 10) / 10 : undefined,
            memoryUsageStartMB: this.memoryUsageStartMB !== undefined
                ? Math.round(this.memoryUsageStartMB * 10) / 10
                : undefined,
            memoryUsageEndMB: memoryUsageMB !== undefined
                ? Math.round(memoryUsageMB * 10) / 10
                : undefined,
            memoryDeltaMB,
            trackingRecoveryTimeMs,
            consecutiveTrackingLossMax: this.consecutiveTrackingLossMax > 0 ? this.consecutiveTrackingLossMax : undefined,
            errorCount: this.errorCount > 0 ? this.errorCount : undefined,

            // Run conditions
            frameWidth: this.runConditions.frameWidth,
            frameHeight: this.runConditions.frameHeight,
            renderBackend: this.runConditions.renderBackend,
            inferenceThreading: this.runConditions.inferenceThreading,
            smoothingEnabled: this.runConditions.smoothingEnabled,
            dynamicInferenceEnabled: this.runConditions.dynamicInferenceEnabled,
            timeToFirstDetectionMs: this.firstDetectionAt !== undefined
                ? Math.round((this.firstDetectionAt - this.startTime) * 10) / 10
                : undefined,

            // Distribution over the whole session, not the rolling window.
            inferenceTimeP50Ms: round1(this.inferenceSeries.percentile(0.5)),
            inferenceTimeP95Ms: round1(this.inferenceSeries.percentile(0.95)),
            inferenceTimeP99Ms: round1(this.inferenceSeries.percentile(0.99)),
            frameIntervalP50Ms: round1(this.frameIntervalSeries.percentile(0.5)),
            frameIntervalP95Ms: round1(this.frameIntervalSeries.percentile(0.95)),
            frameIntervalP99Ms: round1(this.frameIntervalSeries.percentile(0.99)),

            // PWA-only, and not by omission on the other side: native renders
            // declaratively through Skia with no equivalent point to time, so
            // this answers "what share of a web frame is drawing" rather than
            // "which platform draws faster". See METRICS.md.
            avgRenderTimeMs: round1(this.renderSeries.mean),
            renderTimeP95Ms: round1(this.renderSeries.percentile(0.95)),

            appStartupMs: this.appStartupMs,

            avgFrameSkip: this.frameSkipCount > 0
                ? Math.round((this.frameSkipSum / this.frameSkipCount) * 100) / 100
                : undefined,
            maxFrameSkip: this.frameSkipCount > 0 ? this.frameSkipMax : undefined,
            droppedFramesGovernor: this.droppedFramesGovernor,
            droppedFramesBusy: this.droppedFramesBusy,

            avgGestureConfidence: this.gestureConfidenceCount > 0
                ? round3(this.gestureConfidenceSum / this.gestureConfidenceCount)
                : undefined,
            avgBlendshapeActivation: this.blendshapeActivationCount > 0
                ? round3(this.blendshapeActivationSum / this.blendshapeActivationCount)
                : undefined,
            landmarkStability: this.landmarkDeltaCount > 0
                ? round5(this.landmarkDeltaSum / this.landmarkDeltaCount)
                : undefined,
        };
    }
}

// ---- Type augmentations for non-standard Web APIs ----

interface BatteryManager {
    level: number;
    charging: boolean;
}

interface NavigatorWithBattery extends Navigator {
    getBattery(): Promise<BatteryManager>;
}

interface NavigatorWithDeviceMemory extends Navigator {
    /** Total device RAM in GB, rounded to nearest power of 2 (0.25–8). */
    deviceMemory?: number;
}

interface PerformanceWithMemory extends Performance {
    memory?: {
        usedJSHeapSize: number;
        totalJSHeapSize: number;
        jsHeapSizeLimit: number;
    };
}

interface NavigatorWithConnection extends Navigator {
    connection?: {
        effectiveType?: string;
        downlink?: number;
        rtt?: number;
    };
}

interface PressureRecord {
    state: "nominal" | "fair" | "serious" | "critical";
}

interface PressureObserverInstance {
    observe(source: string): Promise<void>;
    unobserve(source: string): void;
    disconnect(): void;
}

interface WindowWithPressure extends Window {
    PressureObserver?: new (
        callback: (records: PressureRecord[]) => void
    ) => PressureObserverInstance;
}
