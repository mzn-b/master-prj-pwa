import {
    FilesetResolver,
    FaceLandmarker,
    GestureRecognizer,
    type FaceLandmarkerResult,
    type GestureRecognizerResult,
    type ImageSource,
} from "@mediapipe/tasks-vision";
import type {
    FaceLandmarksDTO,
    HandLandmarksDTO,
    NormalizedPoint,
    TrackingDTO,
    TrackingMode,
} from "../domain/tracking.dto";

/**
 * NF7: hold the last good landmark set for this many milliseconds when MediaPipe
 * reports no detection. Bridges momentary occlusion (a hand briefly leaves the frame,
 * a blink, etc.) so filters don't snap off every few frames.
 */
const DROPOUT_GRACE_MS = 150;

/**
 * NF4 — stated rather than inherited.
 *
 * These are also MediaPipe's JS defaults today, so nothing changes numerically.
 * The native app sets the same five explicitly; leaving one side on defaults
 * means a library update could move the threshold on one platform only, and the
 * comparison would shift without anything in either repo changing.
 */
const MIN_DETECTION_CONFIDENCE = 0.5;
const MIN_PRESENCE_CONFIDENCE = 0.5;
const MIN_TRACKING_CONFIDENCE = 0.5;

type InitOpts = {
    maxFaces?: number;
    maxHands?: number;
    /** Use GPU acceleration for inference. Default: true */
    useGPU?: boolean;
    /**
     * Where to load the WASM bundle and the .task models from.
     *
     * Defaults to the app-relative paths. A Web Worker resolves relative URLs
     * against its own script, not the page, so the worker passes absolute ones.
     */
    wasmBase?: string;
    modelBase?: string;
};

export type InitResult = {
    controller: TrackingController;
    modelLoadTimeMs: number;
    /** Whether the GPU delegate was requested and likely active */
    gpuDelegateUsed: boolean;
};

/**
 * MediaPipe lifecycle and per-frame inference, including the NF7 dropout grace.
 *
 * Deliberately free of any DOM or threading assumptions: it takes an ImageSource,
 * not a video element, so the identical code runs on the main thread and inside
 * the Web Worker. If the two modes ran different detection logic, comparing them
 * would measure the difference in the code rather than in the threading model.
 */
export class TrackingController {
    private face?: FaceLandmarker;
    private hand?: GestureRecognizer;
    private lastTimestamp = -1;

    // NF7 — cached last successful results, per modality
    private lastFaceResult?: FaceLandmarksDTO;
    private lastFaceTimestamp = -Infinity;
    private lastHandResult?: HandLandmarksDTO;
    private lastHandTimestamp = -Infinity;

    private constructor(face?: FaceLandmarker, hand?: GestureRecognizer) {
        this.face = face;
        this.hand = hand;
    }

    static async init(mode: TrackingMode, opts: InitOpts = {}): Promise<InitResult> {
        const startTime = performance.now();
        const useGPU = opts.useGPU ?? true;
        const wasmBase = opts.wasmBase ?? "/mediapipe/wasm";
        const modelBase = opts.modelBase ?? "/mediapipe/models";
        const fileset = await FilesetResolver.forVisionTasks(wasmBase);

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
                        modelAssetPath: `${modelBase}/face_landmarker.task`,
                    },
                    runningMode: "VIDEO",
                    numFaces: opts.maxFaces ?? 1,
                    minFaceDetectionConfidence: MIN_DETECTION_CONFIDENCE,
                    minFacePresenceConfidence: MIN_PRESENCE_CONFIDENCE,
                    minTrackingConfidence: MIN_TRACKING_CONFIDENCE,
                    // F12 — emit blendshapes (~52 morph-target weights for mimicry analysis).
                    // The native plugin always emits blendshapes, so we match here for symmetry.
                    outputFaceBlendshapes: true,
                    outputFacialTransformationMatrixes: false,
                })
                : Promise.resolve(undefined),

            shouldHand
                // F13 — GestureRecognizer is a HandLandmarker superset that also classifies
                // gestures (Thumb_Up, Open_Palm, Pointing_Up, Victory, Closed_Fist, ILoveYou,
                // Thumb_Down, None). Returns the same 21 landmarks per hand.
                ? GestureRecognizer.createFromOptions(fileset, {
                    baseOptions: {
                        ...baseOptions,
                        modelAssetPath: `${modelBase}/gesture_recognizer.task`,
                    },
                    runningMode: "VIDEO",
                    numHands: opts.maxHands ?? 2,
                    minHandDetectionConfidence: MIN_DETECTION_CONFIDENCE,
                    minHandPresenceConfidence: MIN_PRESENCE_CONFIDENCE,
                    minTrackingConfidence: MIN_TRACKING_CONFIDENCE,
                })
                : Promise.resolve(undefined),
        ]);

        const modelLoadTimeMs = Math.round(performance.now() - startTime);
        console.log(`[TrackingController] Initialized with ${useGPU ? "GPU" : "CPU"} delegate in ${modelLoadTimeMs}ms`);
        return {
            controller: new TrackingController(face, hand),
            modelLoadTimeMs,
            gpuDelegateUsed: useGPU,
        };
    }

    close(): void {
        this.face?.close();
        this.hand?.close();
        this.face = undefined;
        this.hand = undefined;
        this.lastTimestamp = -1;
        this.lastFaceResult = undefined;
        this.lastFaceTimestamp = -Infinity;
        this.lastHandResult = undefined;
        this.lastHandTimestamp = -Infinity;
    }

    /**
     * Runs inference for this frame.
     *
     * Returns `null` when no inference ran because the timestamp had not advanced
     * — MediaPipe requires strictly increasing timestamps and refuses otherwise.
     * This used to return an empty DTO instead, which the caller could not tell
     * apart from "ran, saw nothing": it was recorded as a tracking-loss event and
     * blanked the overlays for that frame. `null` lets the caller count it as a
     * dropped frame and keep the previous result on screen.
     */
    detect(video: ImageSource, timestampMs: number, mode: TrackingMode): TrackingDTO | null {
        if (timestampMs <= this.lastTimestamp) {
            return null;
        }
        this.lastTimestamp = timestampMs;

        const dto: TrackingDTO = { timestampMs, mode };

        if ((mode === "face" || mode === "combined") && this.face) {
            const res: FaceLandmarkerResult = this.face.detectForVideo(video, timestampMs);
            const blendshapeCategories = res.faceBlendshapes ?? [];
            const faces = (res.faceLandmarks ?? []).map((lm, i) => ({
                landmarks: lm.map(toPoint),
                // F12 — MediaPipe returns one categories[] per face, same index
                blendshapes: blendshapeCategories[i]?.categories.map((c) => ({
                    categoryName: c.categoryName,
                    score: c.score,
                })),
            }));
            if (faces.length > 0) {
                dto.face = { faces };
                this.lastFaceResult = dto.face;
                this.lastFaceTimestamp = timestampMs;
            } else if (this.lastFaceResult && timestampMs - this.lastFaceTimestamp <= DROPOUT_GRACE_MS) {
                // NF7 — recent good result still within grace window, reuse it
                dto.face = this.lastFaceResult;
            } else {
                dto.face = { faces: [] };
            }
        }

        if ((mode === "hand" || mode === "combined") && this.hand) {
            const res: GestureRecognizerResult = this.hand.recognizeForVideo(video, timestampMs);
            const hands = (res.landmarks ?? []).map((lm, i) => {
                // F13 — pick the top gesture for this hand (gestures is parallel to landmarks)
                const topGesture = res.gestures?.[i]?.[0];
                return {
                    handedness:
                        res.handedness?.[i]?.[0]?.categoryName === "Left"
                            ? ("Left" as const)
                            : res.handedness?.[i]?.[0]?.categoryName === "Right"
                                ? ("Right" as const)
                                : ("Unknown" as const),
                    landmarks: lm.map(toPoint),
                    gesture: topGesture?.categoryName,
                    gestureScore: topGesture?.score,
                };
            });
            if (hands.length > 0) {
                dto.hand = { hands };
                this.lastHandResult = dto.hand;
                this.lastHandTimestamp = timestampMs;
            } else if (this.lastHandResult && timestampMs - this.lastHandTimestamp <= DROPOUT_GRACE_MS) {
                // NF7 — recent good result still within grace window, reuse it
                dto.hand = this.lastHandResult;
            } else {
                dto.hand = { hands: [] };
            }
        }

        return dto;
    }
}

function toPoint(p: { x: number; y: number; z?: number }): NormalizedPoint {
    return { x: p.x, y: p.y, z: p.z };
}
