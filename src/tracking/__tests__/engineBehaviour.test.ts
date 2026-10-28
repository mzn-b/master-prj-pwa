import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { TrackingDTO } from "../../domain/tracking.dto";

/**
 * The two inference engines and what each frame offered to them turns into:
 * a result, a scheduled result, a busy drop or a skipped frame. Both must
 * report the same things for the threading comparison to mean anything. The
 * TrackingController and the worker are stand-ins; MediaPipe is not loaded.
 */
const controller = {
    detect: vi.fn(),
    close: vi.fn(),
    rawFaceCount: 1,
    rawHandCount: 2,
};
const init = vi.fn();
vi.mock("../TrackingController", () => ({
    TrackingController: { init: (...args: unknown[]) => init(...args) },
}));

import { createEngine, type EngineOptions, type EngineResult } from "../engines";

const dto = (t: number): TrackingDTO => ({ timestampMs: t, mode: "combined" });
const video = {} as HTMLVideoElement;

function options(): EngineOptions & { onResult: Mock<(result: EngineResult) => void>; onError: Mock<(message: string) => void> } {
    return {
        mode: "combined",
        maxFaces: 1,
        maxHands: 2,
        useGPU: true,
        onResult: vi.fn<(result: EngineResult) => void>(),
        onError: vi.fn<(message: string) => void>(),
    };
}

beforeEach(() => {
    controller.detect.mockReset();
    controller.close.mockReset();
    init.mockReset().mockResolvedValue({ controller, modelLoadTimeMs: 1234, gpuDelegateUsed: true });
});

describe("main-thread engine", () => {
    it("reports the model load time and the delegate that was built", async () => {
        const engine = await createEngine("main", options());
        expect(engine.threading).toBe("main");
        expect(engine.modelLoadTimeMs).toBe(1234);
        expect(engine.gpuDelegateActive).toBe(true);
    });

    it("delivers a detection with its time and the raw detector counts", async () => {
        const o = options();
        const engine = await createEngine("main", o);
        controller.detect.mockReturnValue(dto(10));

        expect(engine.submit(video, 10, "combined")).toEqual({ status: "done" });
        expect(o.onResult).toHaveBeenCalledTimes(1);
        const result = o.onResult.mock.calls[0][0];
        expect(result).toMatchObject({ dto: dto(10), rawFaceCount: 1, rawHandCount: 2 });
        expect(result.inferenceMs).toBeGreaterThanOrEqual(0);
        expect(engine.latest()).toEqual(dto(10));
    });

    it("counts a frame MediaPipe refused as skipped, without a result", async () => {
        const o = options();
        const engine = await createEngine("main", o);
        controller.detect.mockReturnValue(null);
        expect(engine.submit(video, 10, "combined")).toEqual({ status: "skipped" });
        expect(o.onResult).not.toHaveBeenCalled();
    });

    it("reports a detection error and skips the frame", async () => {
        const o = options();
        const engine = await createEngine("main", o);
        controller.detect.mockImplementation(() => {
            throw new Error("graph failed");
        });
        expect(engine.submit(video, 10, "combined")).toEqual({ status: "skipped" });
        expect(o.onError).toHaveBeenCalledWith("graph failed");
    });

    it("closes the controller", async () => {
        const engine = await createEngine("main", options());
        engine.close();
        expect(controller.close).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------

class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: { message?: string }) => void) | null = null;
    posted: Array<{ message: unknown; transfer?: unknown[] }> = [];
    terminate = vi.fn();
    constructor() {
        FakeWorker.instances.push(this);
    }
    postMessage(message: unknown, transfer?: unknown[]) {
        this.posted.push({ message, transfer });
    }
    reply(data: unknown) {
        this.onmessage?.({ data } as MessageEvent);
    }
}

const bitmap = () => ({ close: vi.fn() });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

async function workerEngine(o = options()) {
    const pending = createEngine("worker", o);
    const worker = FakeWorker.instances.at(-1) as FakeWorker;
    worker.reply({ type: "ready", modelLoadTimeMs: 2222, gpuDelegateUsed: false });
    return { engine: await pending, worker, o };
}

describe("worker engine", () => {
    beforeEach(() => {
        FakeWorker.instances = [];
        vi.stubGlobal("Worker", FakeWorker);
        vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap()));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("starts the worker with the session's settings and absolute asset URLs", async () => {
        const { engine, worker } = await workerEngine();
        const init = worker.posted[0].message as Record<string, unknown>;
        expect(init).toMatchObject({ type: "init", mode: "combined", maxFaces: 1, maxHands: 2, useGPU: true });
        expect(init.wasmBase).toBe(new URL("/mediapipe/wasm", self.location.origin).href);
        expect(init.modelBase).toBe(new URL("/mediapipe/models", self.location.origin).href);
        expect(engine).toMatchObject({ threading: "worker", modelLoadTimeMs: 2222, gpuDelegateActive: false });
    });

    it("fails to start when the worker reports an error, and stops it", async () => {
        const pending = createEngine("worker", options());
        const worker = FakeWorker.instances.at(-1) as FakeWorker;
        worker.reply({ type: "error", message: "model not found" });
        await expect(pending).rejects.toThrow("model not found");
        expect(worker.terminate).toHaveBeenCalled();
    });

    it("names the cause when the worker dies while loading", async () => {
        const pending = createEngine("worker", options());
        const worker = FakeWorker.instances.at(-1) as FakeWorker;
        worker.onerror?.({ message: "SyntaxError: Cannot use import statement" });
        await expect(pending).rejects.toThrow(
            "Tracking worker failed to start: SyntaxError: Cannot use import statement",
        );
    });

    it("sends one frame at a time and reports the rest as busy", async () => {
        const { engine, worker } = await workerEngine();
        expect(engine.submit(video, 10, "combined")).toEqual({ status: "scheduled" });
        expect(engine.submit(video, 20, "combined")).toEqual({ status: "busy" });
        await flush();
        const detect = worker.posted[1];
        expect(detect.message).toMatchObject({ type: "detect", timestampMs: 10, mode: "combined", seq: 1 });
        // The bitmap is transferred, not copied.
        expect(detect.transfer).toEqual([(detect.message as { bitmap: unknown }).bitmap]);
    });

    it("skips a frame whose timestamp has not advanced, before copying it", async () => {
        const { engine } = await workerEngine();
        engine.submit(video, 10, "combined");
        await flush();
        expect(engine.submit(video, 10, "combined")).toEqual({ status: "skipped" });
        expect(createImageBitmap).toHaveBeenCalledTimes(1);
    });

    it("delivers the worker's result with the round-trip time and frees the slot", async () => {
        const { engine, worker, o } = await workerEngine();
        engine.submit(video, 10, "combined");
        await flush();
        worker.reply({ type: "result", seq: 1, dto: dto(10), rawFaceCount: 1, rawHandCount: 0 });

        const result = o.onResult.mock.calls[0][0];
        expect(result).toMatchObject({ dto: dto(10), rawFaceCount: 1, rawHandCount: 0 });
        expect(result.inferenceMs).toBeGreaterThanOrEqual(0);
        expect(engine.latest()).toEqual(dto(10));
        expect(engine.submit(video, 20, "combined")).toEqual({ status: "scheduled" });
    });

    it("frees the slot without a result when MediaPipe refused the frame", async () => {
        const { engine, worker, o } = await workerEngine();
        engine.submit(video, 10, "combined");
        await flush();
        worker.reply({ type: "result", seq: 1, dto: null, rawFaceCount: 0, rawHandCount: 0 });
        expect(o.onResult).not.toHaveBeenCalled();
        expect(engine.submit(video, 20, "combined")).toEqual({ status: "scheduled" });
    });

    it("reports a detection error from the worker and frees the slot", async () => {
        const { engine, worker, o } = await workerEngine();
        engine.submit(video, 10, "combined");
        await flush();
        worker.reply({ type: "error", message: "Detection failed" });
        expect(o.onError).toHaveBeenCalledWith("Detection failed");
        expect(engine.submit(video, 20, "combined")).toEqual({ status: "scheduled" });
    });

    it("frees the slot when the frame cannot be captured", async () => {
        const { engine } = await workerEngine();
        vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error("video gone"));
        engine.submit(video, 10, "combined");
        await flush();
        expect(engine.submit(video, 20, "combined")).toEqual({ status: "scheduled" });
    });

    it("closes the worker, terminates it as a backstop and drops late frames", async () => {
        vi.useFakeTimers();
        const { engine, worker } = await workerEngine();
        const late = bitmap();
        vi.mocked(createImageBitmap).mockResolvedValueOnce(late as never);
        engine.submit(video, 10, "combined");
        engine.close();
        await vi.runAllTimersAsync();

        expect(worker.posted.map(p => (p.message as { type: string }).type)).toEqual(["init", "close"]);
        expect(late.close).toHaveBeenCalled(); // captured after close: released, never sent
        expect(worker.terminate).toHaveBeenCalled();
        expect(engine.submit(video, 20, "combined")).toEqual({ status: "skipped" });
    });
});
