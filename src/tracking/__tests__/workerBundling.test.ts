import { describe, expect, it } from "vitest";
import config from "../../../vite.config";

/**
 * The tracking worker is a classic worker, because MediaPipe's WASM loader calls
 * importScripts(). `worker.format` only applies to `vite build`; a plain dev
 * server serves the worker as an ES module while still constructing it as a
 * classic one, so it dies at load with "Cannot use import statement outside a
 * module" and the app reports "Tracking worker failed to start".
 *
 * `experimental.bundledDev` is what makes the dev server emit the same
 * self-contained bundle the build does. The two settings are only correct
 * together, so they are asserted together — dropping either one breaks worker
 * mode in dev while leaving the build green.
 */
describe("worker bundling", () => {
    it("builds the tracking worker as a classic IIFE", () => {
        expect(config.worker?.format).toBe("iife");
    });

    it("bundles in dev too, so the classic worker can load there", () => {
        expect(config.experimental?.bundledDev).toBe(true);
    });
});
