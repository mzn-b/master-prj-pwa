/**
 * Renderer Factory - Creates the best available renderer
 *
 * Priority:
 * 1. WebGPU (if available)
 * 2. WebGL 2
 * 3. WebGL 1
 */

import type { Renderer, RendererConfig } from "./types";
import { WebGPURenderer } from "./WebGPURenderer";
import { WebGLRenderer } from "./WebGLRenderer";

export type RendererBackend = "webgpu" | "webgl2" | "webgl" | "auto";

export interface CreateRendererOptions extends RendererConfig {
    preferredBackend?: RendererBackend;
}

export async function createRenderer(options: CreateRendererOptions): Promise<Renderer> {
    const { preferredBackend = "auto", ...config } = options;

    // If specific backend requested, try only that
    if (preferredBackend === "webgpu") {
        if (await WebGPURenderer.isSupported()) {
            const renderer = new WebGPURenderer(config);
            await renderer.init();
            console.log("[Renderer] Using WebGPU");
            return renderer;
        }
        throw new Error("WebGPU not supported on this device");
    }

    if (preferredBackend === "webgl2" || preferredBackend === "webgl") {
        if (WebGLRenderer.isSupported()) {
            const renderer = new WebGLRenderer(config);
            await renderer.init();
            console.log(`[Renderer] Using ${renderer.isWebGL2Context() ? "WebGL 2" : "WebGL 1"}`);
            return renderer;
        }
        throw new Error("WebGL not supported on this device");
    }

    // Auto mode: try best available
    if (await WebGPURenderer.isSupported()) {
        try {
            const renderer = new WebGPURenderer(config);
            await renderer.init();
            console.log("[Renderer] Using WebGPU (auto)");
            return renderer;
        } catch (e) {
            console.warn("[Renderer] WebGPU initialization failed, falling back to WebGL:", e);
        }
    }

    if (WebGLRenderer.isSupported()) {
        const renderer = new WebGLRenderer(config);
        await renderer.init();
        console.log(`[Renderer] Using ${renderer.isWebGL2Context() ? "WebGL 2" : "WebGL 1"} (auto)`);
        return renderer;
    }

    throw new Error("No suitable rendering backend available");
}

/**
 * Check which rendering backends are available
 */
export async function getAvailableBackends(): Promise<RendererBackend[]> {
    const backends: RendererBackend[] = [];

    if (await WebGPURenderer.isSupported()) {
        backends.push("webgpu");
    }

    if (WebGLRenderer.isSupported()) {
        // Check for WebGL 2 specifically
        const canvas = document.createElement("canvas");
        if (canvas.getContext("webgl2")) {
            backends.push("webgl2");
        }
        if (canvas.getContext("webgl")) {
            backends.push("webgl");
        }
    }

    return backends;
}
