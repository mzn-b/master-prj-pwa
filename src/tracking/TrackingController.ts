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
    /** Use GPU acceleration for inference. Default: true */
    useGPU?: boolean;
};

export type InitResult = {
    controller: TrackingController;
    modelLoadTimeMs: number;
};

export class TrackingController {
    private face?: FaceLandmarker;
    private hand?: HandLandmarker;
    private lastTimestamp = -1;

    private constructor(face?: FaceLandmarker, hand?: HandLandmarker) {
        this.face = face;
        this.hand = hand;
    }

    static async init(mode: TrackingMode, opts: InitOpts = {}): Promise<InitResult> {
        const startTime = performance.now();
        const useGPU = opts.useGPU ?? true;
        const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");

        const shouldFace = mode === "face" || mode === "combined";
        const shouldHand = mode === "hand" || mode === "combined";

        const baseOptions = {
            delegate: useGPU ? "GPU" as const : "CPU" as const,
        };

        const [face, hand] = await Promise.all([
            shouldFace
                ? FaceLandmarker.createFromOptions(fileset, {
                    baseOptions: {
                        ...baseOptions,
                        modelAssetPath: "/mediapipe/models/face_landmarker.task",
                    },
                    runningMode: "VIDEO",
                    numFaces: opts.maxFaces ?? 1,
                    // Disable blendshapes and face geometry for better performance
                    outputFaceBlendshapes: false,
                    outputFacialTransformationMatrixes: false,
                })
                : Promise.resolve(undefined),

            shouldHand
                ? HandLandmarker.createFromOptions(fileset, {
                    baseOptions: {
                        ...baseOptions,
                        modelAssetPath: "/mediapipe/models/hand_landmarker.task",
                    },
                    runningMode: "VIDEO",
                    numHands: opts.maxHands ?? 2,
                })
                : Promise.resolve(undefined),
        ]);

        const modelLoadTimeMs = Math.round(performance.now() - startTime);
        console.log(`[TrackingController] Initialized with ${useGPU ? "GPU" : "CPU"} delegate in ${modelLoadTimeMs}ms`);
        return {
            controller: new TrackingController(face, hand),
            modelLoadTimeMs,
        };
    }

    close(): void {
        this.face?.close();
        this.hand?.close();
        this.face = undefined;
        this.hand = undefined;
        this.lastTimestamp = -1;
    }

    detect(video: HTMLVideoElement, timestampMs: number, mode: TrackingMode): TrackingDTO {
        const dto: TrackingDTO = { timestampMs, mode };

        // MediaPipe requires strictly increasing timestamps
        // Skip if timestamp hasn't increased (can happen with high frame rates)
        if (timestampMs <= this.lastTimestamp) {
            return dto;
        }
        this.lastTimestamp = timestampMs;

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
