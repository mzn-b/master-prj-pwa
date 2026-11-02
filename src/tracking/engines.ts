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
    /**
     * The worker is busy; this frame is held and goes next, unless a newer one
     * replaces it first. Accounted for like "scheduled".
     */
    | { status: "queued" }
    /**
     * A frame was dropped because inference was busy. On the worker engine the
     * dropped frame is the held one this frame replaced, which keeps the count
     * at one per frame that is never processed.
     */
    | { status: "busy" }
    /** No inference ran: the timestamp had not advanced. Also a dropped frame. */
    | { status: "skipped" };

export interface EngineResult {
    dto: TrackingDTO;
    /** End-to-end: frame available to landmarks ready. See NF4 in the audit. */
    inferenceMs: number;
    /**
     * What the detector returned this frame, before the NF7 grace may have
     * substituted a held result. Carried separately from `dto` because a graced
     * frame is deliberately indistinguishable from a detected one in the DTO —
     * right for drawing, wrong for counting. Native counts from raw detector
     * output, so the PWA must too. See METRICS.md.
     */
    rawFaceCount: number;
    rawHandCount: number;
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
        this.options.onResult({
            dto,
            inferenceMs: performance.now() - startedAt,
            rawFaceCount: this.controller.rawFaceCount,
            rawHandCount: this.controller.rawHandCount,
        });
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

/** A frame that arrived while the worker was busy, waiting to go next. */
interface HeldFrame {
    timestampMs: number;
    mode: TrackingMode;
    /** Null until its capture has finished. */
    bitmap: ImageBitmap | null;
    /** How long the capture took; the frame's measured span begins with it. */
    captureMs: number;
}

class WorkerEngine implements TrackingEngine {
    readonly threading = "worker" as const;
    readonly modelLoadTimeMs: number;
    readonly gpuDelegateActive: boolean;

    private readonly worker: Worker;
    private readonly options: EngineOptions;
    private lastDto: TrackingDTO | null = null;
    /** A frame is being captured to be sent at once, or is with the worker. */
    private inFlight = false;
    private held: HeldFrame | null = null;
    private seq = 0;
    /** Start of the in-flight frame's measured span: when its capture began. */
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
                this.sendHeld();
                this.options.onError(message.message);
                return;
            }
            if (message.type !== "result") return;

            // End-to-end, measured on the thread that asked for it: bitmap
            // capture, transfer, inference, and the result coming back. The
            // native app's number spans the equivalent bridge crossing. Taken
            // before sendHeld(), which starts the next frame's span.
            const inferenceMs = performance.now() - this.startedAt;
            this.inFlight = false;
            this.sendHeld();
            if (message.dto === null) return;

            this.lastDto = message.dto;
            this.options.onResult({
                dto: message.dto,
                inferenceMs,
                rawFaceCount: message.rawFaceCount,
                rawHandCount: message.rawHandCount,
            });
        };
    }

    submit(video: HTMLVideoElement, timestampMs: number, mode: TrackingMode): SubmitOutcome {
        if (this.closed) return { status: "skipped" };

        // MediaPipe's VIDEO mode needs strictly increasing timestamps. The check
        // lives here rather than in the worker so a rejected frame is not paid
        // for with a bitmap copy and a round trip.
        if (timestampMs <= this.lastTimestamp) return { status: "skipped" };
        this.lastTimestamp = timestampMs;

        if (!this.inFlight && this.held === null) {
            this.inFlight = true;
            const captureStart = performance.now();
            // createImageBitmap is async, so the frame is captured off the
            // critical path; this is the browser's analogue of Android's
            // ImageProxy -> Bitmap conversion, and it is inside the measured span
            // for the same reason.
            createImageBitmap(video).then(
                bitmap => {
                    if (this.closed) {
                        bitmap.close();
                        return;
                    }
                    this.send(bitmap, timestampMs, mode, captureStart);
                },
                () => {
                    // A frame that cannot be captured (the video was torn down
                    // mid-flight) is simply skipped, without a result.
                    this.inFlight = false;
                    this.sendHeld();
                },
            );
            return { status: "scheduled" };
        }

        // The worker is busy. Until 2026-11-02 the frame was refused here, so
        // the worker idled until the next camera frame after each result. Now
        // the newest frame is held and sent the moment the worker is free —
        // what the main-thread engine gets from the video-frame callback, CameraX
        // from KEEP_ONLY_LATEST and the native iOS app from its newest-frame
        // runner. A held frame is captured on arrival rather than when it is
        // sent: capturing later could pick up a frame whose own callback has not
        // run yet, and that frame would then be detected twice.
        const replaced = this.held;
        replaced?.bitmap?.close();
        const frame: HeldFrame = { timestampMs, mode, bitmap: null, captureMs: 0 };
        this.held = frame;
        const captureStart = performance.now();
        createImageBitmap(video).then(
            bitmap => {
                if (this.held !== frame || this.closed) {
                    bitmap.close();
                    return;
                }
                frame.bitmap = bitmap;
                frame.captureMs = performance.now() - captureStart;
                this.sendHeld();
            },
            () => {
                if (this.held === frame) this.held = null;
            },
        );
        return { status: replaced ? "busy" : "queued" };
    }

    /** Sends the held frame if it is captured and the worker is free. */
    private sendHeld(): void {
        const frame = this.held;
        if (this.inFlight || this.closed || frame === null || frame.bitmap === null) return;
        this.held = null;
        this.inFlight = true;
        // Back-dated by the capture alone: the time the frame waited for the
        // worker is not part of its span, as on the native runner, whose span
        // begins when the job starts.
        this.send(frame.bitmap, frame.timestampMs, frame.mode, performance.now() - frame.captureMs);
    }

    private send(bitmap: ImageBitmap, timestampMs: number, mode: TrackingMode, startedAt: number): void {
        this.startedAt = startedAt;
        const request: WorkerRequest = { type: "detect", bitmap, timestampMs, mode, seq: ++this.seq };
        this.worker.postMessage(request, [bitmap]);
    }

    latest(): TrackingDTO | null {
        return this.lastDto;
    }

    close(): void {
        this.closed = true;
        this.held?.bitmap?.close();
        this.held = null;
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
        // useGPU must be passed here as well: without it init() defaults to the
        // GPU delegate, and the GPU-Delegate switch had no effect on the
        // main-thread engine (found in the thesis audit, 2026-10-28) while the
        // session still recorded the switch position.
        const { controller, modelLoadTimeMs, gpuDelegateUsed } = await TrackingController.init(
            options.mode,
            { maxFaces: options.maxFaces, maxHands: options.maxHands, useGPU: options.useGPU },
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
