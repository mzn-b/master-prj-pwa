import type { TrackingDTO, TrackingMode } from "../domain/tracking.dto";
import { TrackingController } from "./TrackingController";
import type { WorkerRequest, WorkerResponse } from "./trackingWorker";

/**
 * Where inference runs relative to the UI.
 *
 * The native app detects on the async runner's own thread, so a slow frame never
 * blocks rendering. A browser can do the same with a Web Worker — it just is not
 * the default, and the PWA originally did everything on one thread. Measuring
 * both modes is what separates "web vs native" from "single-threaded vs
 * multi-threaded", which are otherwise confounded.
 *
 * Both modes run the identical `TrackingController`, so the only difference
 * between them is the thread the work happens on.
 */
export type InferenceThreading = "main" | "worker";

/** What happened to a frame the loop offered to the engine. */
export type SubmitOutcome =
    /** Inference ran and finished; `onResult` has already been called. */
    | { status: "done" }
    /** Inference was started elsewhere; `onResult` will be called when it lands. */
    | { status: "scheduled" }
    /** The engine was still busy with an earlier frame — a genuine dropped frame. */
    | { status: "busy" }
    /** No inference ran: the timestamp had not advanced. Also a dropped frame. */
    | { status: "skipped" };

export interface EngineResult {
    dto: TrackingDTO;
    /** End-to-end: frame available to landmarks ready. See NF4 in the audit. */
    inferenceMs: number;
}

export interface TrackingEngine {
    readonly threading: InferenceThreading;
    readonly modelLoadTimeMs: number;
    readonly gpuDelegateActive: boolean;
    /** Offer a frame for inference. Never throws; failures surface as outcomes. */
    submit(video: HTMLVideoElement, timestampMs: number, mode: TrackingMode): SubmitOutcome;
    /** Most recent successful detection, for rendering. */
    latest(): TrackingDTO | null;
    close(): void;
}

export interface EngineOptions {
    mode: TrackingMode;
    maxFaces: number;
    maxHands: number;
    useGPU: boolean;
    onResult: (result: EngineResult) => void;
    onError: (message: string) => void;
}

// ---------------------------------------------------------------------------

class MainThreadEngine implements TrackingEngine {
    readonly threading = "main" as const;
    readonly modelLoadTimeMs: number;
    readonly gpuDelegateActive: boolean;

    private readonly controller: TrackingController;
    private readonly options: EngineOptions;
    private lastDto: TrackingDTO | null = null;

    constructor(
        controller: TrackingController,
        modelLoadTimeMs: number,
        gpuDelegateActive: boolean,
        options: EngineOptions,
    ) {
        this.controller = controller;
        this.modelLoadTimeMs = modelLoadTimeMs;
        this.gpuDelegateActive = gpuDelegateActive;
        this.options = options;
    }

    submit(video: HTMLVideoElement, timestampMs: number, mode: TrackingMode): SubmitOutcome {
        const startedAt = performance.now();
        let dto: TrackingDTO | null;
        try {
            dto = this.controller.detect(video, timestampMs, mode);
        } catch (e) {
            this.options.onError(e instanceof Error ? e.message : "Detection failed");
            return { status: "skipped" };
        }
        if (dto === null) return { status: "skipped" };

        this.lastDto = dto;
        this.options.onResult({ dto, inferenceMs: performance.now() - startedAt });
        return { status: "done" };
    }

    latest(): TrackingDTO | null {
        return this.lastDto;
    }

    close(): void {
        this.controller.close();
    }
}

// ---------------------------------------------------------------------------

class WorkerEngine implements TrackingEngine {
    readonly threading = "worker" as const;
    readonly modelLoadTimeMs: number;
    readonly gpuDelegateActive: boolean;

    private readonly worker: Worker;
    private readonly options: EngineOptions;
    private lastDto: TrackingDTO | null = null;
    private inFlight = false;
    private seq = 0;
    /** performance.now() when the in-flight frame was offered. */
    private startedAt = 0;
    private lastTimestamp = -1;
    private closed = false;

    constructor(
        worker: Worker,
        modelLoadTimeMs: number,
        gpuDelegateActive: boolean,
        options: EngineOptions,
    ) {
        this.worker = worker;
        this.modelLoadTimeMs = modelLoadTimeMs;
        this.gpuDelegateActive = gpuDelegateActive;
        this.options = options;

        worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
            const message = event.data;
            if (message.type === "error") {
                this.inFlight = false;
                this.options.onError(message.message);
                return;
            }
            if (message.type !== "result") return;

            this.inFlight = false;
            if (message.dto === null) return;

            this.lastDto = message.dto;
            // End-to-end, measured on the thread that asked for it: bitmap
            // capture, transfer, inference, and the result coming back. The
            // native app's number spans the equivalent bridge crossing.
            this.options.onResult({
                dto: message.dto,
                inferenceMs: performance.now() - this.startedAt,
            });
        };
    }

    submit(video: HTMLVideoElement, timestampMs: number, mode: TrackingMode): SubmitOutcome {
        if (this.closed) return { status: "skipped" };

        // MediaPipe's VIDEO mode needs strictly increasing timestamps. The check
        // lives here rather than in the worker so a rejected frame is not paid
        // for with a bitmap copy and a round trip.
        if (timestampMs <= this.lastTimestamp) return { status: "skipped" };

        // One frame at a time. Queueing work the device cannot keep up with adds
        // latency without adding throughput — the native app's async runner
        // refuses for the same reason, and reports the frame as dropped.
        if (this.inFlight) return { status: "busy" };

        this.lastTimestamp = timestampMs;
        this.inFlight = true;
        this.startedAt = performance.now();
        const seq = ++this.seq;

        // createImageBitmap is async, so the frame is captured off the critical
        // path; this is the browser's analogue of Android's ImageProxy -> Bitmap
        // conversion, and it is inside the measured span for the same reason.
        createImageBitmap(video).then(
            bitmap => {
                if (this.closed) {
                    bitmap.close();
                    return;
                }
                const request: WorkerRequest = {
                    type: "detect",
                    bitmap,
                    timestampMs,
                    mode,
                    seq,
                };
                this.worker.postMessage(request, [bitmap]);
            },
            () => {
                // A frame that cannot be captured (the video was torn down
                // mid-flight) is simply skipped; the loop counts it as dropped.
                this.inFlight = false;
            },
        );

        return { status: "scheduled" };
    }

    latest(): TrackingDTO | null {
        return this.lastDto;
    }

    close(): void {
        this.closed = true;
        const request: WorkerRequest = { type: "close" };
        this.worker.postMessage(request);
        // The worker calls self.close() on that message; terminate is the
        // backstop for a worker that never got there.
        setTimeout(() => this.worker.terminate(), 1000);
    }
}

// ---------------------------------------------------------------------------

export async function createEngine(
    threading: InferenceThreading,
    options: EngineOptions,
): Promise<TrackingEngine> {
    if (threading === "main") {
        const { controller, modelLoadTimeMs, gpuDelegateUsed } = await TrackingController.init(
            options.mode,
            { maxFaces: options.maxFaces, maxHands: options.maxHands },
        );
        return new MainThreadEngine(controller, modelLoadTimeMs, gpuDelegateUsed, options);
    }

    // Classic, not a module worker — see the `worker.format` note in vite.config.ts.
    const worker = new Worker(new URL("./trackingWorker.ts", import.meta.url));

    const ready = await new Promise<{ modelLoadTimeMs: number; gpuDelegateUsed: boolean }>(
        (resolve, reject) => {
            worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
                if (event.data.type === "ready") {
                    resolve({
                        modelLoadTimeMs: event.data.modelLoadTimeMs,
                        gpuDelegateUsed: event.data.gpuDelegateUsed,
                    });
                } else if (event.data.type === "error") {
                    reject(new Error(event.data.message));
                }
            };
            worker.onerror = event => {
                // A worker that dies while loading never gets to post an
                // { type: "error" } of its own, so this event carries the only
                // description of what went wrong. Dropping it turns a named
                // parse error into an unactionable "failed to start".
                const detail = event.message ? `: ${event.message}` : "";
                reject(new Error(`Tracking worker failed to start${detail}`));
            };

            const request: WorkerRequest = {
                type: "init",
                mode: options.mode,
                maxFaces: options.maxFaces,
                maxHands: options.maxHands,
                useGPU: options.useGPU,
                // Absolute: a worker resolves relative URLs against its own
                // script URL, not the page's.
                wasmBase: new URL("/mediapipe/wasm", self.location.origin).href,
                modelBase: new URL("/mediapipe/models", self.location.origin).href,
            };
            worker.postMessage(request);
        },
    ).catch(error => {
        worker.terminate();
        throw error;
    });

    return new WorkerEngine(worker, ready.modelLoadTimeMs, ready.gpuDelegateUsed, options);
}
