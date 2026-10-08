import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PerformanceTracker, WARMUP_FRAMES } from "../PerformanceTracker";

/** Drive the tracker with a controllable clock. */
function runFrames(
    tracker: PerformanceTracker,
    count: number,
    frameMs: number,
    hasTracking = true,
) {
    for (let i = 0; i < count; i++) {
        const start = tracker.recordFrameStart();
        vi.advanceTimersByTime(frameMs);
        tracker.recordFrameEnd(start, hasTracking);
    }
}

/**
 * Install a fake Battery Status API before the tracker is constructed, since it
 * snapshots the manager once. `level` is the raw 0..1 fraction the API returns —
 * the tracker is responsible for turning that into a percentage.
 */
function withBattery(level: number) {
    const manager = { level, charging: false };
    Object.defineProperty(navigator, "getBattery", {
        configurable: true,
        writable: true,
        value: () => Promise.resolve(manager),
    });
    return manager;
}

describe("PerformanceTracker", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["performance", "setTimeout", "setInterval", "Date"] });
        vi.setSystemTime(0);
    });
    afterEach(() => vi.useRealTimers());

    it("is not warmed up before the warmup window closes (F11)", () => {
        const t = new PerformanceTracker();
        t.start();
        runFrames(t, WARMUP_FRAMES - 1, 33);
        expect(t.getMetrics().warmupComplete).toBe(false);
    });

    it("completes warmup at exactly WARMUP_FRAMES frames", () => {
        const t = new PerformanceTracker();
        t.start();
        runFrames(t, WARMUP_FRAMES, 33);
        expect(t.getMetrics().warmupComplete).toBe(true);
    });

    it("does not report min/max fps measured during warmup", () => {
        const t = new PerformanceTracker();
        t.start();
        runFrames(t, WARMUP_FRAMES, 500); // deliberately terrible warmup frames
        runFrames(t, 10, 33);
        expect(t.getMetrics().minFps!).toBeGreaterThan(10);
    });

    it("reports null min/max fps until warmup completes", () => {
        const t = new PerformanceTracker();
        t.start();
        runFrames(t, 5, 33);
        const m = t.getMetrics();
        expect(m.minFps).toBeNull();
        expect(m.maxFps).toBeNull();
    });

    it("derives fps from frame time", () => {
        const t = new PerformanceTracker();
        t.start();
        runFrames(t, 10, 40); // 40 ms per frame -> 25 fps
        expect(t.getMetrics().fps).toBeCloseTo(25, 1);
    });

    it("records inference time separately from frame time", () => {
        const t = new PerformanceTracker();
        t.start();
        const started = t.recordFrameStart();
        vi.advanceTimersByTime(12);
        t.recordInferenceTime(started);
        expect(t.getMetrics().avgInferenceTimeMs).toBeCloseTo(12, 1);
    });

    it("counts a tracking loss when tracking goes valid to invalid (NF7)", () => {
        const t = new PerformanceTracker();
        t.start();
        runFrames(t, 3, 33, true);
        runFrames(t, 3, 33, false);
        expect(t.getMetrics().trackingLostCount).toBe(1);
    });

    it("records the longest consecutive loss streak", () => {
        const t = new PerformanceTracker();
        t.start();
        runFrames(t, 1, 33, true);
        runFrames(t, 5, 33, false);
        runFrames(t, 1, 33, true);
        runFrames(t, 2, 33, false);
        expect(t.getMetrics().consecutiveTrackingLossMax!).toBeGreaterThanOrEqual(4);
    });

    it("averages detections per frame", () => {
        const t = new PerformanceTracker();
        t.start();
        t.recordDetection(1, 2);
        t.recordDetection(1, 0);
        const m = t.getMetrics();
        expect(m.facesDetectedAvg).toBeCloseTo(1, 5);
        expect(m.handsDetectedAvg).toBeCloseTo(1, 5);
    });

    it("reports the model load time and GPU delegate flag it was given", () => {
        const t = new PerformanceTracker();
        t.start();
        t.setModelLoadTime(412);
        t.setGpuDelegateActive(true);
        const m = t.getMetrics();
        expect(m.modelLoadTimeMs).toBe(412);
        expect(m.gpuDelegateActive).toBe(true);
    });

    it("clears counters on reset so a filter toggle starts a fresh session", () => {
        const t = new PerformanceTracker();
        t.start();
        runFrames(t, 40, 33);
        t.reset();
        const m = t.getMetrics();
        expect(m.frameCount).toBe(0);
        expect(m.warmupComplete).toBe(false);
        expect(m.trackingLostCount).toBe(0);
    });

    it("counts errors", () => {
        const t = new PerformanceTracker();
        t.start();
        t.recordError();
        t.recordError();
        expect(t.getMetrics().errorCount).toBe(2);
    });
});

// Regression: droppedFrames was declared, reset and submitted but never
// incremented, so every session reported a hard 0. See docs/pwa-followups.md #8.
describe("PerformanceTracker dropped frames", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["performance", "setTimeout", "setInterval", "Date"] });
        vi.setSystemTime(0);
    });
    afterEach(() => vi.useRealTimers());

    it("starts at zero", () => {
        const t = new PerformanceTracker();
        t.start();
        expect(t.getMetrics().droppedFrames).toBe(0);
    });

    it("counts dropped frames separately from processed frames", () => {
        const t = new PerformanceTracker();
        t.start();
        runFrames(t, 5, 33);
        t.recordDroppedFrame("busy");
        t.recordDroppedFrame("busy");
        const m = t.getMetrics();
        expect(m.frameCount).toBe(5);
        expect(m.droppedFrames).toBe(2);
    });

    it("accepts a batch count", () => {
        const t = new PerformanceTracker();
        t.start();
        t.recordDroppedFrame("busy", 7);
        expect(t.getMetrics().droppedFrames).toBe(7);
    });

    it("clears the counter on reset", () => {
        const t = new PerformanceTracker();
        t.start();
        t.recordDroppedFrame("busy", 3);
        t.reset();
        expect(t.getMetrics().droppedFrames).toBe(0);
    });
});

// Regression: the Battery Status API returns a 0..1 fraction while Android's
// BATTERY_PROPERTY_CAPACITY returns 0..100, and both wrote to the same column.
// See docs/pwa-followups.md #6.
describe("PerformanceTracker battery units", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["performance", "setTimeout", "setInterval", "Date"] });
        vi.setSystemTime(0);
    });
    afterEach(() => {
        vi.useRealTimers();
        Reflect.deleteProperty(navigator, "getBattery");
    });

    it("reports the level as a percentage, not a fraction", async () => {
        withBattery(0.78);
        const t = new PerformanceTracker();
        await vi.waitFor(() => expect(t.getMetrics().batteryLevel).toBeDefined());
        t.start();
        expect(t.getMetrics().batteryLevel).toBeCloseTo(78, 5);
    });

    it("reports start and end on the same scale", async () => {
        const manager = withBattery(0.8);
        const t = new PerformanceTracker();
        await vi.waitFor(() => expect(t.getMetrics().batteryLevel).toBeDefined());
        t.start();
        t.getMetrics();
        manager.level = 0.74;
        const m = t.getMetrics();
        expect(m.batteryLevelStart).toBeCloseTo(80, 5);
        expect(m.batteryLevelEnd).toBeCloseTo(74, 5);
    });

    it("still reports the delta as consumption in percent (start - end)", async () => {
        const manager = withBattery(0.8);
        const t = new PerformanceTracker();
        await vi.waitFor(() => expect(t.getMetrics().batteryLevel).toBeDefined());
        t.start();
        t.getMetrics();
        manager.level = 0.74;
        expect(t.getMetrics().batteryDeltaPercent).toBeCloseTo(6, 5);
    });

    it("leaves the battery fields undefined when the API is absent", () => {
        const t = new PerformanceTracker();
        t.start();
        const m = t.getMetrics();
        expect(m.batteryLevel).toBeUndefined();
        expect(m.batteryDeltaPercent).toBeUndefined();
    });
});

/**
 * The metrics added on 2026-09-15. Rationale for each — and for the ones that
 * are deliberately one-sided — is in METRICS.md.
 */
describe("PerformanceTracker percentiles", () => {
    let t: PerformanceTracker;

    beforeEach(() => {
        vi.useFakeTimers();
        t = new PerformanceTracker();
        t.start();
    });
    afterEach(() => vi.useRealTimers());

    it("reports a value that actually occurred, not an interpolation", () => {
        // Nearest rank on ten samples of 10..100 ms: p95 must be 100, not 95.
        for (let i = 1; i <= 10; i++) t.recordInferenceMs(i * 10);
        const m = t.getMetrics();
        expect(m.inferenceTimeP95Ms).toBeCloseTo(100, 1);
        expect(m.inferenceTimeP50Ms).toBeCloseTo(50, 1);
    });

    it("keeps the whole session, not just the rolling buffer", () => {
        // Slow frames early on must still show in the p99 after hundreds of
        // fast frames have pushed them out of the circular buffer — otherwise
        // the percentile describes the buffer rather than the run.
        for (let i = 0; i < 5; i++) t.recordInferenceMs(800);
        for (let i = 0; i < 300; i++) t.recordInferenceMs(10);
        expect(t.getMetrics().inferenceTimeP99Ms!).toBeGreaterThan(100);
        expect(t.getMetrics().inferenceTimeP50Ms!).toBeLessThan(20);
    });

    it("distinguishes judder from a slow average", () => {
        // Alternating 5 ms and 60 ms frames: the interval p95 exposes the
        // stutter that avgFps averages away.
        for (let i = 0; i < 40; i++) {
            const start = t.recordFrameStart();
            vi.advanceTimersByTime(i % 2 === 0 ? 5 : 60);
            t.recordFrameEnd(start, true);
        }
        const m = t.getMetrics();
        expect(m.frameIntervalP95Ms!).toBeGreaterThan(m.frameIntervalP50Ms!);
    });

    it("omits percentiles rather than reporting zero for an empty session", () => {
        const m = t.getMetrics();
        expect(m.inferenceTimeP50Ms).toBeUndefined();
        expect(m.frameIntervalP95Ms).toBeUndefined();
    });
});

describe("PerformanceTracker detection quality", () => {
    let t: PerformanceTracker;

    beforeEach(() => {
        vi.useFakeTimers();
        t = new PerformanceTracker();
        t.start();
    });
    afterEach(() => vi.useRealTimers());

    function face(noseX: number, noseY: number, topBlendshape?: number) {
        const landmarks = Array.from({ length: 5 }, () => ({ x: 0, y: 0, z: 0 }));
        landmarks[1] = { x: noseX, y: noseY, z: 0 };
        return {
            timestampMs: 1,
            mode: "face" as const,
            face: {
                faces: [
                    {
                        landmarks,
                        blendshapes:
                            topBlendshape === undefined
                                ? undefined
                                : [
                                      { categoryName: "a", score: 0.1 },
                                      { categoryName: "b", score: topBlendshape },
                                  ],
                    },
                ],
            },
        };
    }

    it("averages MediaPipe's own gesture confidence", () => {
        for (const score of [0.9, 0.7]) {
            t.recordDetectionQuality({
                timestampMs: 1,
                mode: "hand",
                hand: {
                    hands: [{ landmarks: [], handedness: "Right", gesture: "Open_Palm", gestureScore: score }],
                },
            });
        }
        expect(t.getMetrics().avgGestureConfidence).toBeCloseTo(0.8, 3);
    });

    it("takes the strongest blendshape, not the mean of all of them", () => {
        // Averaging 52 mostly-idle coefficients would report near zero however
        // decisively the model responded.
        t.recordDetectionQuality(face(0.5, 0.5, 0.6));
        expect(t.getMetrics().avgBlendshapeActivation).toBeCloseTo(0.6, 3);
    });

    it("measures jitter as frame-to-frame nose displacement", () => {
        t.recordDetectionQuality(face(0.5, 0.5));
        t.recordDetectionQuality(face(0.53, 0.54)); // hypot(0.03, 0.04) = 0.05
        expect(t.getMetrics().landmarkStability).toBeCloseTo(0.05, 3);
    });

    it("does not count the jump across a tracking dropout as jitter", () => {
        // Losing the face and reacquiring it elsewhere is not instability; if
        // the gap were counted, every dropout would inflate the figure.
        t.recordDetectionQuality(face(0.1, 0.1));
        t.recordDetectionQuality({ timestampMs: 2, mode: "face", face: { faces: [] } });
        t.recordDetectionQuality(face(0.9, 0.9));
        expect(t.getMetrics().landmarkStability).toBeUndefined();
    });

    it("reports nothing rather than zero when no face was ever seen", () => {
        t.recordDetectionQuality({ timestampMs: 1, mode: "face", face: { faces: [] } });
        const m = t.getMetrics();
        expect(m.landmarkStability).toBeUndefined();
        expect(m.avgBlendshapeActivation).toBeUndefined();
        expect(m.avgGestureConfidence).toBeUndefined();
    });

    it("ignores a null frame", () => {
        t.recordDetectionQuality(null);
        expect(t.getMetrics().landmarkStability).toBeUndefined();
    });
});

describe("PerformanceTracker render time", () => {
    let t: PerformanceTracker;

    beforeEach(() => {
        vi.useFakeTimers();
        t = new PerformanceTracker();
        t.start();
    });
    afterEach(() => vi.useRealTimers());

    it("summarises draw cost separately from inference", () => {
        // PWA-only by measurement structure: the native app has no equivalent
        // point to time. See METRICS.md §5.
        for (const ms of [4, 6, 8, 40]) t.recordRenderMs(ms);
        const m = t.getMetrics();
        expect(m.avgRenderTimeMs).toBeCloseTo(14.5, 1);
        expect(m.renderTimeP95Ms).toBeCloseTo(40, 1);
    });

    it("is absent, not zero, when nothing was drawn", () => {
        expect(t.getMetrics().avgRenderTimeMs).toBeUndefined();
    });
});


describe("PerformanceTracker F15 governor accounting", () => {
    let t: PerformanceTracker;

    beforeEach(() => {
        vi.useFakeTimers();
        t = new PerformanceTracker();
        t.start();
    });
    afterEach(() => vi.useRealTimers());

    it("splits dropped frames by cause while keeping the total", () => {
        // At skip 5 the governor discards 80% of frames by design. Without the
        // split that reads as catastrophic failure in the droppedFrames column.
        t.recordDroppedFrame("governor", 40);
        t.recordDroppedFrame("busy", 3);
        const m = t.getMetrics();
        expect(m.droppedFrames).toBe(43);
        expect(m.droppedFramesGovernor).toBe(40);
        expect(m.droppedFramesBusy).toBe(3);
    });

    it("reports the mean and peak divider, weighted by camera frames", () => {
        // Sampled on every camera frame including skipped ones, so an arm that
        // spent most of the session at a high divider reads as such.
        for (let i = 0; i < 10; i++) t.recordFrameSkip(1);
        for (let i = 0; i < 10; i++) t.recordFrameSkip(3);
        const m = t.getMetrics();
        expect(m.avgFrameSkip).toBeCloseTo(2, 2);
        expect(m.maxFrameSkip).toBe(3);
    });

    it("rejects a nonsensical divider rather than skewing the mean", () => {
        t.recordFrameSkip(2);
        t.recordFrameSkip(0);
        t.recordFrameSkip(Number.NaN);
        expect(t.getMetrics().avgFrameSkip).toBeCloseTo(2, 2);
    });

    it("is absent, not 1, when the session recorded no frames", () => {
        const m = t.getMetrics();
        expect(m.avgFrameSkip).toBeUndefined();
        expect(m.maxFrameSkip).toBeUndefined();
    });
});
