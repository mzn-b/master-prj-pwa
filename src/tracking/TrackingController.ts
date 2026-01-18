import {
    FilesetResolver,
    FaceLandmarker,
    HandLandmarker,
    type FaceLandmarkerResult,
    type HandLandmarkerResult,
} from "@mediapipe/tasks-vision";
import type { TrackingDTO, TrackingMode, NormalizedPoint } from "../domain/tracking.dto";

type InitOpts = {
    maxFaces?: number;
    maxHands?: number;
};

export class TrackingController {
    private face?: FaceLandmarker;
    private hand?: HandLandmarker;

    private constructor(face?: FaceLandmarker, hand?: HandLandmarker) {
        this.face = face;
        this.hand = hand;
    }

    static async init(mode: TrackingMode, opts: InitOpts = {}): Promise<TrackingController> {
        const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");

        const shouldFace = mode === "face" || mode === "combined";
        const shouldHand = mode === "hand" || mode === "combined";

        const [face, hand] = await Promise.all([
            shouldFace
                ? FaceLandmarker.createFromOptions(fileset, {
                    baseOptions: {
                        modelAssetPath: "/mediapipe/models/face_landmarker.task",
                    },
                    runningMode: "VIDEO",
                    numFaces: opts.maxFaces ?? 1,
                })
                : Promise.resolve(undefined),

            shouldHand
                ? HandLandmarker.createFromOptions(fileset, {
                    baseOptions: {
                        modelAssetPath: "/mediapipe/models/hand_landmarker.task",
                    },
                    runningMode: "VIDEO",
                    numHands: opts.maxHands ?? 1,
                })
                : Promise.resolve(undefined),
        ]);

        return new TrackingController(face, hand);
    }

    close(): void {
        this.face?.close();
        this.hand?.close();
        this.face = undefined;
        this.hand = undefined;
    }

    detect(video: HTMLVideoElement, timestampMs: number, mode: TrackingMode): TrackingDTO {
        const dto: TrackingDTO = { timestampMs, mode };

        if ((mode === "face" || mode === "combined") && this.face) {
            const res: FaceLandmarkerResult = this.face.detectForVideo(video, timestampMs);
            dto.face = { faces: (res.faceLandmarks ?? []).map((lm) => ({ landmarks: lm.map(toPoint) })) };
        }

        if ((mode === "hand" || mode === "combined") && this.hand) {
            const res: HandLandmarkerResult = this.hand.detectForVideo(video, timestampMs);
            dto.hand = {
                hands: (res.landmarks ?? []).map((lm, i) => ({
                    handedness:
                        res.handedness?.[i]?.[0]?.categoryName === "Left"
                            ? "Left"
                            : res.handedness?.[i]?.[0]?.categoryName === "Right"
                                ? "Right"
                                : "Unknown",
                    landmarks: lm.map(toPoint),
                })),
            };
        }

        return dto;
    }
}

function toPoint(p: { x: number; y: number; z?: number }): NormalizedPoint {
    return { x: p.x, y: p.y, z: p.z };
}
