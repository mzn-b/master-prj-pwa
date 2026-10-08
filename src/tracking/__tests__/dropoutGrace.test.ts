import { describe, expect, it } from "vitest";
import { TrackingController } from "../TrackingController";

/**
 * NF7 — robustness to short tracking dropouts.
 *
 * The native app holds this behaviour in `dropoutGrace.ts`, a pure module with
 * its own tests. In the PWA the same logic lives inline in
 * `TrackingController.detect()`, so it had no direct coverage at all — the kind
 * of structural asymmetry that hid the F9 smoothing defect, where one platform's
 * code path simply never reached the shared logic.
 *
 * The grace window is 150 ms on both sides. A face lost for less than that keeps
 * its last good result, so a single missed frame does not make the overlay
 * flicker; past the window the loss is reported honestly.
 */

/** The constructor is private at compile time only. */
function controllerWith(face?: unknown, hand?: unknown): TrackingController {
    return Reflect.construct(TrackingController, [face, hand]) as TrackingController;
}

const POINT = { x: 0.5, y: 0.5, z: 0 };
// Derived from the method signature rather than importing the type, which
// TrackingController keeps internal.
const VIDEO = {} as Parameters<TrackingController["detect"]>[0];

/** A FaceLandmarker stub returning a face on the frames listed, nothing otherwise. */
function faceStub(framesWithFace: number[]) {
    let call = 0;
    return {
        detectForVideo() {
            const found = framesWithFace.includes(call++);
            return { faceLandmarks: found ? [[POINT]] : [], faceBlendshapes: [] };
        },
    };
}

describe("NF7 dropout grace (face)", () => {
    it("reports the face on a frame where it is detected", () => {
        const c = controllerWith(faceStub([0]));
        const dto = c.detect(VIDEO, 100, "face");
        expect(dto?.face?.faces).toHaveLength(1);
    });

    it("holds the last good result through a gap shorter than the window", () => {
        const c = controllerWith(faceStub([0])); // detected once, then lost
        c.detect(VIDEO, 100, "face");
        // 140 ms later — inside the 150 ms window.
        const dto = c.detect(VIDEO, 240, "face");
        expect(dto?.face?.faces).toHaveLength(1);
    });

    it("reports the loss once the window has passed", () => {
        const c = controllerWith(faceStub([0]));
        c.detect(VIDEO, 100, "face");
        // 151 ms later — just outside the window.
        const dto = c.detect(VIDEO, 251, "face");
        expect(dto?.face?.faces).toHaveLength(0);
    });

    it("treats the window as inclusive at exactly 150 ms", () => {
        const c = controllerWith(faceStub([0]));
        c.detect(VIDEO, 100, "face");
        const dto = c.detect(VIDEO, 250, "face");
        expect(dto?.face?.faces).toHaveLength(1);
    });

    it("restarts the window each time the face is seen again", () => {
        const c = controllerWith(faceStub([0, 1])); // seen on two frames
        c.detect(VIDEO, 100, "face");
        c.detect(VIDEO, 200, "face");
        // 140 ms after the *second* sighting, so still inside the window even
        // though 240 ms have passed since the first.
        const dto = c.detect(VIDEO, 340, "face");
        expect(dto?.face?.faces).toHaveLength(1);
    });

    it("reports an empty result when the face was never seen at all", () => {
        // Nothing cached, so there is nothing to hold — this must not be
        // confused with a dropout.
        const c = controllerWith(faceStub([]));
        const dto = c.detect(VIDEO, 100, "face");
        expect(dto?.face?.faces).toHaveLength(0);
    });
});

describe("MediaPipe VIDEO-mode timestamp contract", () => {
    it("refuses a timestamp that has not advanced", () => {
        // MediaPipe's VIDEO mode requires strictly increasing timestamps and
        // silently returns nothing otherwise, so the controller rejects the
        // frame before paying for a detection.
        const c = controllerWith(faceStub([0, 1]));
        expect(c.detect(VIDEO, 100, "face")).not.toBeNull();
        expect(c.detect(VIDEO, 100, "face")).toBeNull();
        expect(c.detect(VIDEO, 99, "face")).toBeNull();
    });
});

describe("mode gating", () => {
    it("does not touch the face detector in hand mode", () => {
        let called = 0;
        const face = {
            detectForVideo() {
                called++;
                return { faceLandmarks: [[POINT]], faceBlendshapes: [] };
            },
        };
        const c = controllerWith(face, undefined);
        const dto = c.detect(VIDEO, 100, "hand");
        expect(called).toBe(0);
        expect(dto?.face).toBeUndefined();
    });
});


/**
 * NF4 — the grace must not leak into the metrics.
 *
 * The grace exists so the *overlay* does not flicker, which means a graced
 * frame is deliberately indistinguishable from a detected one in the DTO. The
 * counters must see through that: the native app counts from raw detector
 * output in the worklet, because its grace runs downstream on the UI runtime.
 * If the PWA counted the graced DTO instead it would report fewer tracking
 * losses and a higher detection rate for identical detector behaviour — and the
 * bias would be arm-dependent, since a fixed 150 ms window covers about two
 * frames at 12 fps but seven at 45 fps.
 */
describe("raw detector counts are exposed alongside the graced DTO", () => {
    it("reports zero raw faces on a frame the grace filled in", () => {
        const c = controllerWith(faceStub([0])); // detected once, then lost
        const first = c.detect(VIDEO, 100, "face");
        expect(first?.face?.faces).toHaveLength(1);
        expect(c.rawFaceCount).toBe(1);

        // 140 ms later the detector sees nothing: inside the 150 ms window, so
        // the DTO still carries a face — but the raw count must say otherwise.
        const graced = c.detect(VIDEO, 240, "face");
        expect(graced?.face?.faces).toHaveLength(1);
        expect(c.rawFaceCount).toBe(0);
    });

    it("agrees with the DTO once the grace window has passed", () => {
        const c = controllerWith(faceStub([0]));
        c.detect(VIDEO, 100, "face");
        const lost = c.detect(VIDEO, 251, "face");
        expect(lost?.face?.faces).toHaveLength(0);
        expect(c.rawFaceCount).toBe(0);
    });

    it("counts a real re-detection as raw, not as grace", () => {
        // Frames 0 and 1 both see a face: the second is a genuine detection and
        // must not be mistaken for a held result.
        const c = controllerWith(faceStub([0, 1]));
        c.detect(VIDEO, 100, "face");
        c.detect(VIDEO, 140, "face");
        expect(c.rawFaceCount).toBe(1);
    });
});
