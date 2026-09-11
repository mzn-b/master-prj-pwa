/// <reference lib="webworker" />

/**
 * Web Worker host for MediaPipe inference.
 *
 * The main-thread path and this one share `TrackingController`, so the only
 * difference between the two threading modes is *where* the work runs — not
 * what it does. That is what makes the two comparable, and it is why the thesis
 * can attribute the difference between them to threading rather than to code.
 */

import { TrackingController } from "./TrackingController";
import type { TrackingDTO, TrackingMode } from "../domain/tracking.dto";

export type WorkerRequest =
    | {
          type: "init";
          mode: TrackingMode;
          maxFaces: number;
          maxHands: number;
          useGPU: boolean;
          /** Absolute URL — a worker cannot resolve the app's relative asset paths. */
          wasmBase: string;
          modelBase: string;
      }
    | { type: "detect"; bitmap: ImageBitmap; timestampMs: number; mode: TrackingMode; seq: number }
    | { type: "close" };

export type WorkerResponse =
    | { type: "ready"; modelLoadTimeMs: number; gpuDelegateUsed: boolean }
    | { type: "error"; message: string }
    | { type: "result"; seq: number; dto: TrackingDTO | null };

let controller: TrackingController | undefined;

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
    const message = event.data;

    if (message.type === "init") {
        try {
            const result = await TrackingController.init(message.mode, {
                maxFaces: message.maxFaces,
                maxHands: message.maxHands,
                useGPU: message.useGPU,
                wasmBase: message.wasmBase,
                modelBase: message.modelBase,
            });
            controller = result.controller;
            const ready: WorkerResponse = {
                type: "ready",
                modelLoadTimeMs: result.modelLoadTimeMs,
                gpuDelegateUsed: result.gpuDelegateUsed,
            };
            self.postMessage(ready);
        } catch (e) {
            const error: WorkerResponse = {
                type: "error",
                message: e instanceof Error ? e.message : "Worker init failed",
            };
            self.postMessage(error);
        }
        return;
    }

    if (message.type === "detect") {
        // The bitmap was transferred here, so this worker owns it and must
        // close it — an ImageBitmap holds GPU memory until it is released.
        try {
            const dto = controller?.detect(message.bitmap, message.timestampMs, message.mode) ?? null;
            const response: WorkerResponse = { type: "result", seq: message.seq, dto };
            self.postMessage(response);
        } catch (e) {
            const error: WorkerResponse = {
                type: "error",
                message: e instanceof Error ? e.message : "Detection failed",
            };
            self.postMessage(error);
        } finally {
            message.bitmap.close();
        }
        return;
    }

    if (message.type === "close") {
        controller?.close();
        controller = undefined;
        self.close();
    }
};
