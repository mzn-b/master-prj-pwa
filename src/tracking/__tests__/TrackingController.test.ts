import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MediaPipe's lifecycle and per-frame inference on the web side. MediaPipe is
 * replaced by stand-ins that record how the tasks are built and return chosen
 * results, so the test pins the configuration both apps must share (NF4), the
 * GPU fallback and what it reports, the DTO mapping, and the NF7 grace.
 */
const faceTask = { detectForVideo: vi.fn(), close: vi.fn() };
const handTask = { recognizeForVideo: vi.fn(), close: vi.fn() };
const createFace = vi.fn();
const createHand = vi.fn();

vi.mock("@mediapipe/tasks-vision", () => ({
    FilesetResolver: { forVisionTasks: vi.fn(async (base: string) => ({ base })) },
    FaceLandmarker: { createFromOptions: (...args: unknown[]) => createFace(...args) },
    GestureRecognizer: { createFromOptions: (...args: unknown[]) => createHand(...args) },
}));

import { TrackingController } from "../TrackingController";

const point = (x: number, y: number) => ({ x, y, z: 0 });

function withWebGL2(available: boolean) {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
        ((type: string) => (type === "webgl2" && available ? ({} as RenderingContext) : null)) as never,
    );
}

beforeEach(() => {
    createFace.mockReset().mockResolvedValue(faceTask);
    createHand.mockReset().mockResolvedValue(handTask);
    faceTask.detectForVideo.mockReset().mockReturnValue({ faceLandmarks: [], faceBlendshapes: [] });
    handTask.recognizeForVideo.mockReset().mockReturnValue({ landmarks: [], handedness: [], gestures: [] });
    faceTask.close.mockReset();
    handTask.close.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("TrackingController.init", () => {
    it("builds both tasks with the settings shared with the native app", async () => {
        withWebGL2(true);
        await TrackingController.init("combined", { maxFaces: 1, maxHands: 2 });

        const faceOptions = createFace.mock.calls[0][1];
        expect(faceOptions).toMatchObject({
            baseOptions: { delegate: "GPU", modelAssetPath: "/mediapipe/models/face_landmarker.task" },
            runningMode: "VIDEO",
            numFaces: 1,
            minFaceDetectionConfidence: 0.5,
            minFacePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
            outputFaceBlendshapes: true,
        });
        const handOptions = createHand.mock.calls[0][1];
        expect(handOptions).toMatchObject({
            baseOptions: { delegate: "GPU", modelAssetPath: "/mediapipe/models/gesture_recognizer.task" },
            runningMode: "VIDEO",
            numHands: 2,
            minHandDetectionConfidence: 0.5,
            minHandPresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
        });
    });

    it("reports the GPU delegate only when it was actually built", async () => {
        withWebGL2(true);
        const result = await TrackingController.init("combined");
        expect(result.gpuDelegateUsed).toBe(true);
        expect(result.webgl2Available).toBe(true);
        expect(result.modelLoadTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("falls back to the CPU when a task refuses the GPU, and says so", async () => {
        withWebGL2(true);
        createFace.mockRejectedValueOnce(new Error("GPU delegate unavailable"));
        const result = await TrackingController.init("combined");
        expect(createFace.mock.calls.map(c => c[1].baseOptions.delegate)).toEqual(["GPU", "CPU"]);
        expect(result.gpuDelegateUsed).toBe(false);
    });

    it("uses the CPU when the GPU is switched off", async () => {
        withWebGL2(true);
        const result = await TrackingController.init("combined", { useGPU: false });
        expect(createFace.mock.calls[0][1].baseOptions.delegate).toBe("CPU");
        expect(createHand.mock.calls[0][1].baseOptions.delegate).toBe("CPU");
        expect(result.gpuDelegateUsed).toBe(false);
    });

    it("uses the CPU when the browser has no WebGL 2", async () => {
        withWebGL2(false);
        const result = await TrackingController.init("combined", { useGPU: true });
        expect(createFace.mock.calls[0][1].baseOptions.delegate).toBe("CPU");
        expect(result).toMatchObject({ gpuDelegateUsed: false, webgl2Available: false });
    });

    it("builds only the task the mode needs", async () => {
        withWebGL2(true);
        await TrackingController.init("face");
        expect(createFace).toHaveBeenCalledTimes(1);
        expect(createHand).not.toHaveBeenCalled();
    });

    it("loads from the given absolute locations, as the worker requires", async () => {
        withWebGL2(true);
        await TrackingController.init("hand", {
            wasmBase: "https://app.example/mediapipe/wasm",
            modelBase: "https://app.example/mediapipe/models",
        });
        expect(createHand.mock.calls[0][0]).toEqual({ base: "https://app.example/mediapipe/wasm" });
        expect(createHand.mock.calls[0][1].baseOptions.modelAssetPath).toBe(
            "https://app.example/mediapipe/models/gesture_recognizer.task",
        );
    });
});

describe("TrackingController.detect", () => {
    const video = {} as never;

    async function controller(mode: "face" | "hand" | "combined" = "combined") {
        withWebGL2(true);
        return (await TrackingController.init(mode)).controller;
    }

    it("refuses a frame whose timestamp has not advanced", async () => {
        const c = await controller();
        expect(c.detect(video, 100, "combined")).not.toBeNull();
        expect(c.detect(video, 100, "combined")).toBeNull();
        expect(c.detect(video, 99, "combined")).toBeNull();
    });

    it("maps faces with their blendshapes and hands with handedness and gesture", async () => {
        const c = await controller();
        faceTask.detectForVideo.mockReturnValue({
            faceLandmarks: [[point(0.1, 0.2), point(0.3, 0.4)]],
            faceBlendshapes: [{ categories: [{ categoryName: "jawOpen", score: 0.7, index: 0, displayName: "" }] }],
        });
        handTask.recognizeForVideo.mockReturnValue({
            landmarks: [[point(0.5, 0.6)], [point(0.7, 0.8)]],
            handedness: [[{ categoryName: "Left" }], [{ categoryName: "Right" }]],
            gestures: [[{ categoryName: "Open_Palm", score: 0.9 }], []],
        });

        const dto = c.detect(video, 100, "combined");

        expect(dto?.face?.faces[0].landmarks[1]).toEqual({ x: 0.3, y: 0.4, z: 0 });
        expect(dto?.face?.faces[0].blendshapes).toEqual([{ categoryName: "jawOpen", score: 0.7 }]);
        expect(dto?.hand?.hands.map(h => h.handedness)).toEqual(["Left", "Right"]);
        expect(dto?.hand?.hands[0]).toMatchObject({ gesture: "Open_Palm", gestureScore: 0.9 });
        expect(dto?.hand?.hands[1].gesture).toBeUndefined();
        expect(c.rawFaceCount).toBe(1);
        expect(c.rawHandCount).toBe(2);
    });

    it("marks a hand of unknown handedness as such", async () => {
        const c = await controller("hand");
        handTask.recognizeForVideo.mockReturnValue({
            landmarks: [[point(0.5, 0.6)]],
            handedness: [[]],
            gestures: [],
        });
        expect(c.detect(video, 1, "hand")?.hand?.hands[0].handedness).toBe("Unknown");
    });

    it("holds the last result for 150 ms and counts the frame as raw nothing (NF7)", async () => {
        const c = await controller("face");
        faceTask.detectForVideo.mockReturnValueOnce({ faceLandmarks: [[point(0.1, 0.1)]], faceBlendshapes: [] });
        const seen = c.detect(video, 1000, "face");

        const held = c.detect(video, 1150, "face");
        expect(held?.face).toBe(seen?.face);
        expect(c.rawFaceCount).toBe(0);

        const gone = c.detect(video, 1151 + 150, "face");
        expect(gone?.face?.faces).toEqual([]);
    });

    it("runs only the tasks the frame's mode asks for", async () => {
        const c = await controller("combined");
        const dto = c.detect(video, 1, "face");
        expect(handTask.recognizeForVideo).not.toHaveBeenCalled();
        expect(dto?.hand).toBeUndefined();
    });

    it("closes both tasks and forgets everything", async () => {
        const c = await controller("combined");
        faceTask.detectForVideo.mockReturnValueOnce({ faceLandmarks: [[point(0.1, 0.1)]], faceBlendshapes: [] });
        c.detect(video, 500, "combined");
        c.close();
        expect(faceTask.close).toHaveBeenCalled();
        expect(handTask.close).toHaveBeenCalled();
        // Timestamps start over, and no task remains to run.
        const dto = c.detect(video, 1, "combined");
        expect(dto).toEqual({ timestampMs: 1, mode: "combined" });
    });
});
