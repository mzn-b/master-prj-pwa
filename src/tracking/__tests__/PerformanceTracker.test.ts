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
        t.recordDroppedFrame();
        t.recordDroppedFrame();
        const m = t.getMetrics();
        expect(m.frameCount).toBe(5);
        expect(m.droppedFrames).toBe(2);
    });

    it("accepts a batch count", () => {
        const t = new PerformanceTracker();
        t.start();
        t.recordDroppedFrame(7);
        expect(t.getMetrics().droppedFrames).toBe(7);
    });

    it("clears the counter on reset", () => {
        const t = new PerformanceTracker();
        t.start();
        t.recordDroppedFrame(3);
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
