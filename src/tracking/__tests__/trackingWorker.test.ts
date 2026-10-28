import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The worker side of the threading comparison. It must run exactly what the
 * main thread runs — the same TrackingController — and must release every
 * transferred bitmap, which holds GPU memory until closed.
 */
const controller = { detect: vi.fn(), close: vi.fn(), rawFaceCount: 1, rawHandCount: 2 };
const init = vi.fn();
vi.mock("../TrackingController", () => ({
    TrackingController: { init: (...args: unknown[]) => init(...args) },
}));

type Handler = (event: { data: unknown }) => Promise<void>;
let handle: Handler;
const posted: unknown[] = [];

beforeEach(async () => {
    vi.resetModules();
    posted.length = 0;
    controller.detect.mockReset();
    controller.close.mockReset();
    init.mockReset().mockResolvedValue({ controller, modelLoadTimeMs: 900, gpuDelegateUsed: true });
    vi.spyOn(self, "postMessage").mockImplementation(((message: unknown) => {
        posted.push(message);
    }) as never);
    vi.spyOn(self, "close").mockImplementation(() => {});
    await import("../trackingWorker");
    handle = self.onmessage as unknown as Handler;
});

afterEach(() => vi.restoreAllMocks());

const initRequest = {
    type: "init",
    mode: "combined",
    maxFaces: 1,
    maxHands: 2,
    useGPU: false,
    wasmBase: "https://app.example/mediapipe/wasm",
    modelBase: "https://app.example/mediapipe/models",
};

describe("trackingWorker", () => {
    it("builds the controller with the page's settings and reports ready", async () => {
        await handle({ data: initRequest });
        expect(init).toHaveBeenCalledWith("combined", {
            maxFaces: 1,
            maxHands: 2,
            useGPU: false,
            wasmBase: "https://app.example/mediapipe/wasm",
            modelBase: "https://app.example/mediapipe/models",
        });
        expect(posted).toEqual([{ type: "ready", modelLoadTimeMs: 900, gpuDelegateUsed: true }]);
    });

    it("reports a failed start", async () => {
        init.mockRejectedValueOnce(new Error("wasm fetch failed"));
        await handle({ data: initRequest });
        expect(posted).toEqual([{ type: "error", message: "wasm fetch failed" }]);
    });

    it("detects on the transferred bitmap, answers with the raw counts and frees it", async () => {
        await handle({ data: initRequest });
        controller.detect.mockReturnValue({ timestampMs: 5, mode: "combined" });
        const bitmap = { close: vi.fn() };
        await handle({ data: { type: "detect", bitmap, timestampMs: 5, mode: "combined", seq: 3 } });
        expect(controller.detect).toHaveBeenCalledWith(bitmap, 5, "combined");
        expect(posted.at(-1)).toEqual({
            type: "result",
            seq: 3,
            dto: { timestampMs: 5, mode: "combined" },
            rawFaceCount: 1,
            rawHandCount: 2,
        });
        expect(bitmap.close).toHaveBeenCalled();
    });

    it("reports a detection error and still frees the bitmap", async () => {
        await handle({ data: initRequest });
        controller.detect.mockImplementation(() => {
            throw new Error("graph failed");
        });
        const bitmap = { close: vi.fn() };
        await handle({ data: { type: "detect", bitmap, timestampMs: 5, mode: "combined", seq: 1 } });
        expect(posted.at(-1)).toEqual({ type: "error", message: "graph failed" });
        expect(bitmap.close).toHaveBeenCalled();
    });

    it("answers a frame that arrives before start-up with nothing", async () => {
        const bitmap = { close: vi.fn() };
        await handle({ data: { type: "detect", bitmap, timestampMs: 5, mode: "combined", seq: 1 } });
        expect(posted.at(-1)).toEqual({ type: "result", seq: 1, dto: null, rawFaceCount: 0, rawHandCount: 0 });
        expect(bitmap.close).toHaveBeenCalled();
    });

    it("closes the controller and the worker", async () => {
        await handle({ data: initRequest });
        await handle({ data: { type: "close" } });
        expect(controller.close).toHaveBeenCalled();
        expect(self.close).toHaveBeenCalled();
    });
});
