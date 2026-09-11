import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { subscribeToVideoFrames, hasVideoFrameCallback } from "../videoFrames";

/**
 * Regression: detection used to be driven by requestAnimationFrame, which ticks
 * at display rate. A 30 fps camera in a 120 Hz page was inferred on four times,
 * three of them on a frame MediaPipe had already seen. See the audit, §2.4.
 */

function fakeVideo(): HTMLVideoElement & { emitFrame(): void } {
    let cb: (() => void) | null = null;
    const video = {
        currentTime: 0,
        requestVideoFrameCallback(callback: () => void) {
            cb = callback;
            return 1;
        },
        cancelVideoFrameCallback() {
            cb = null;
        },
        emitFrame() {
            cb?.();
        },
    };
    return video as unknown as HTMLVideoElement & { emitFrame(): void };
}

describe("subscribeToVideoFrames", () => {
    it("uses requestVideoFrameCallback when the browser has it", () => {
        const video = fakeVideo();
        const onFrame = vi.fn();
        const cancel = subscribeToVideoFrames(video, onFrame);

        video.emitFrame();
        video.emitFrame();
        expect(onFrame).toHaveBeenCalledTimes(2);
        cancel();
    });

    it("stops calling back after cancel", () => {
        const video = fakeVideo();
        const onFrame = vi.fn();
        const cancel = subscribeToVideoFrames(video, onFrame);
        video.emitFrame();
        cancel();
        video.emitFrame();
        expect(onFrame).toHaveBeenCalledTimes(1);
    });
});

describe("subscribeToVideoFrames without requestVideoFrameCallback", () => {
    let rafCallbacks: FrameRequestCallback[] = [];

    beforeEach(() => {
        rafCallbacks = [];
        vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
            rafCallbacks.push(cb);
            return rafCallbacks.length;
        });
        vi.stubGlobal("cancelAnimationFrame", () => undefined);
    });
    afterEach(() => vi.unstubAllGlobals());

    const pump = () => {
        const due = rafCallbacks;
        rafCallbacks = [];
        for (const cb of due) cb(0);
    };

    it("only fires when currentTime advances, so a frame is never inferred twice", () => {
        // No requestVideoFrameCallback on this object — the Firefox path.
        const video = { currentTime: 0 } as HTMLVideoElement;
        const onFrame = vi.fn();
        subscribeToVideoFrames(video, onFrame);

        pump(); // first frame at t=0
        pump(); // same currentTime — must not re-infer
        pump();
        expect(onFrame).toHaveBeenCalledTimes(1);

        (video as { currentTime: number }).currentTime = 0.033;
        pump();
        expect(onFrame).toHaveBeenCalledTimes(2);
    });
});

describe("hasVideoFrameCallback", () => {
    it("reports what this environment supports without throwing", () => {
        expect(typeof hasVideoFrameCallback()).toBe("boolean");
    });
});
