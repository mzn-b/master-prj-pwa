import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PerformanceOverlay } from "../PerformanceOverlay";
import type { PerformanceMetricsDTO, TrackingDTO } from "../../domain/tracking.dto";

afterEach(cleanup);

/**
 * F8 + F14 — the metrics and debug cards.
 *
 * The native app tests its `PerformanceHud` and `DebugHud`; this is the PWA's
 * counterpart. What matters here is not layout but that an **absent** metric
 * reads as absent: several are structurally unavailable in a browser (CPU on
 * both engines, memory and battery in Safari), and rendering a missing value as
 * `0` would put a fabricated measurement in front of a participant and into
 * screenshots.
 */
function metrics(overrides: Partial<PerformanceMetricsDTO> = {}): PerformanceMetricsDTO {
    return {
        fps: 12.34,
        avgFps: 11.5,
        inferenceTimeMs: 40,
        avgInferenceTimeMs: 38.25,
        frameProcessingTimeMs: 42,
        avgFrameProcessingTimeMs: 41.75,
        frameCount: 120,
        droppedFrames: 30,
        sessionDurationMs: 10_000,
        warmupComplete: true,
        trackingLostCount: 0,
        ...overrides,
    } as PerformanceMetricsDTO;
}

describe("PerformanceOverlay — metrics card", () => {
    it("renders nothing when hidden", () => {
        const { container } = render(
            <PerformanceOverlay
                metrics={metrics()}
                visible={false}
                debug={false}
                tracking={null}
                currentFrameSkip={1}
            />,
        );
        expect(container.textContent).toBe("");
    });

    it("shows instantaneous and average fps together", () => {
        render(
            <PerformanceOverlay
                metrics={metrics()}
                visible
                debug={false}
                tracking={null}
                currentFrameSkip={1}
            />,
        );
        expect(screen.getByText("12.3 (Ø 11.5)")).toBeTruthy();
    });

    it("shows frames processed alongside frames dropped", () => {
        // droppedFrames can legitimately exceed frameCount at a high frame-skip,
        // so the two are always shown together rather than as a ratio.
        render(
            <PerformanceOverlay
                metrics={metrics()}
                visible
                debug={false}
                tracking={null}
                currentFrameSkip={4}
            />,
        );
        expect(screen.getByText("120 (30 verworfen)")).toBeTruthy();
        expect(screen.getByText("4")).toBeTruthy();
    });

    it("renders an em dash for metrics the platform cannot supply", () => {
        render(
            <PerformanceOverlay
                metrics={metrics({
                    memoryUsageMB: undefined,
                    cpuUsagePercent: undefined,
                    batteryLevel: undefined,
                    thermalState: undefined,
                })}
                visible
                debug={false}
                tracking={null}
                currentFrameSkip={1}
            />,
        );
        // Four unavailable metrics — none of them may render as a number.
        expect(screen.getAllByText("—")).toHaveLength(4);
    });

    it("distinguishes a real zero from a missing reading", () => {
        render(
            <PerformanceOverlay
                metrics={metrics({ cpuUsagePercent: 0, batteryLevel: undefined })}
                visible
                debug={false}
                tracking={null}
                currentFrameSkip={1}
            />,
        );
        expect(screen.getByText("0 %")).toBeTruthy();
        expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    });

    it("reports the warm-up state, which gates whether a session is usable", () => {
        const { rerender } = render(
            <PerformanceOverlay
                metrics={metrics({ warmupComplete: false })}
                visible
                debug={false}
                tracking={null}
                currentFrameSkip={1}
            />,
        );
        expect(screen.getByText("läuft")).toBeTruthy();
        rerender(
            <PerformanceOverlay
                metrics={metrics({ warmupComplete: true })}
                visible
                debug={false}
                tracking={null}
                currentFrameSkip={1}
            />,
        );
        expect(screen.getByText("fertig")).toBeTruthy();
    });
});

describe("PerformanceOverlay — debug card (F14)", () => {
    const tracking: TrackingDTO = {
        timestampMs: 1,
        mode: "combined",
        face: { faces: [{ landmarks: [{ x: 0.1, y: 0.2, z: 0 }, { x: 0.25, y: 0.5, z: 0 }] }] },
        hand: {
            hands: [
                {
                    landmarks: [{ x: 0.4, y: 0.6, z: 0 }],
                    handedness: "Right",
                    gesture: "Open_Palm",
                    gestureScore: 0.91,
                },
            ],
        },
    };

    it("stays hidden unless debug is on", () => {
        render(
            <PerformanceOverlay
                metrics={metrics()}
                visible={false}
                debug={false}
                tracking={tracking}
                currentFrameSkip={1}
            />,
        );
        expect(screen.queryByText("Debug")).toBeNull();
    });

    it("reports face detection, coordinates and the recognised gesture", () => {
        render(
            <PerformanceOverlay
                metrics={metrics()}
                visible={false}
                debug
                tracking={tracking}
                currentFrameSkip={1}
            />,
        );
        expect(screen.getByText(/Gesicht: erkannt/)).toBeTruthy();
        expect(screen.getByText(/Hände: 1/)).toBeTruthy();
        expect(screen.getByText(/Open_Palm/)).toBeTruthy();
        expect(screen.getByText(/91%/)).toBeTruthy();
    });

    it("says so plainly when no face is tracked", () => {
        render(
            <PerformanceOverlay
                metrics={metrics()}
                visible={false}
                debug
                tracking={{ timestampMs: 1, mode: "face", face: { faces: [] } }}
                currentFrameSkip={1}
            />,
        );
        expect(screen.getByText(/Gesicht: nicht erkannt/)).toBeTruthy();
    });
});
