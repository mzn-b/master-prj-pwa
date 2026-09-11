import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { PerformanceMetricsDTO, TrackingDTO } from "../tracking.dto";

const here = path.dirname(fileURLToPath(import.meta.url));
const nativeDto = path.resolve(here, "../../../../master-prj-native-2/src/domain/tracking.dto.ts");

describe("tracking DTO contract (F7)", () => {
    // The native app has the mirror of this test. Both apps post to the same
    // backend columns, so a change to one DTO that is not made to the other
    // silently splits the dataset in two.
    it("is byte-identical to the native-2 copy", () => {
        if (!fs.existsSync(nativeDto)) {
            // The two repos are siblings under FH/. If the native app is not
            // checked out next to this one there is nothing to compare against;
            // skipping is better than failing on someone else's directory layout.
            return;
        }
        const ours = fs.readFileSync(path.resolve(here, "../tracking.dto.ts"), "utf8");
        expect(ours).toBe(fs.readFileSync(nativeDto, "utf8"));
    });

    it("accepts the tracking shape both apps produce", () => {
        const dto: TrackingDTO = {
            timestampMs: 1000,
            mode: "combined",
            face: {
                faces: [
                    {
                        landmarks: [{ x: 0.5, y: 0.5, z: 0 }],
                        blendshapes: [{ categoryName: "jawOpen", score: 0.2 }],
                    },
                ],
            },
            hand: {
                hands: [
                    {
                        handedness: "Left",
                        landmarks: [{ x: 0.1, y: 0.2 }],
                        gesture: "Victory",
                        gestureScore: 0.9,
                    },
                ],
            },
        };
        expect(dto.face?.faces[0].blendshapes?.[0].categoryName).toBe("jawOpen");
        expect(dto.hand?.hands[0].gesture).toBe("Victory");
    });

    it("requires the metric fields the backend persists as non-null", () => {
        const metrics: PerformanceMetricsDTO = {
            fps: 30,
            avgFps: 29,
            minFps: 20,
            maxFps: 31,
            inferenceTimeMs: 12,
            avgInferenceTimeMs: 13,
            frameProcessingTimeMs: 20,
            avgFrameProcessingTimeMs: 21,
            frameCount: 100,
            droppedFrames: 2,
            sessionDurationMs: 3400,
            warmupComplete: true,
            trackingLostCount: 1,
        };
        expect(metrics.warmupComplete).toBe(true);
    });
});
