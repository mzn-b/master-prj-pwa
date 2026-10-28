import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Backend choice for the landmarks view: WebGPU where it starts, WebGL
 * otherwise, and an explicit request is never silently swapped for another
 * backend. Both renderer classes are stand-ins.
 */
const support = { webgpu: true, webgl: true, webgpuInitFails: false, webgl2: true };
const constructed: string[] = [];

vi.mock("../WebGPURenderer", () => ({
    WebGPURenderer: class {
        static isSupported = async () => support.webgpu;
        constructor() {
            constructed.push("webgpu");
        }
        async init() {
            if (support.webgpuInitFails) throw new Error("device request failed");
        }
    },
}));
vi.mock("../WebGLRenderer", () => ({
    WebGLRenderer: class {
        static isSupported = () => support.webgl;
        constructor() {
            constructed.push("webgl");
        }
        async init() {}
        isWebGL2Context() {
            return support.webgl2;
        }
    },
}));

import { createRenderer, getAvailableBackends } from "../createRenderer";

const config = { canvas: document.createElement("canvas"), width: 1, height: 1 };

beforeEach(() => {
    Object.assign(support, { webgpu: true, webgl: true, webgpuInitFails: false, webgl2: true });
    constructed.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("createRenderer", () => {
    it("uses WebGPU when it is available", async () => {
        await createRenderer(config);
        expect(constructed).toEqual(["webgpu"]);
    });

    it("falls back to WebGL when WebGPU is missing or fails to start", async () => {
        support.webgpu = false;
        await createRenderer(config);
        support.webgpu = true;
        support.webgpuInitFails = true;
        support.webgl2 = false;
        await createRenderer(config);
        expect(constructed).toEqual(["webgl", "webgpu", "webgl"]);
        expect(console.warn).toHaveBeenCalled();
        expect(console.log).toHaveBeenLastCalledWith("[Renderer] Using WebGL 1 (auto)");
    });

    it("fails when neither backend is available", async () => {
        support.webgpu = false;
        support.webgl = false;
        await expect(createRenderer(config)).rejects.toThrow("No suitable rendering backend");
    });

    it("honours an explicit backend and does not substitute another", async () => {
        await createRenderer({ ...config, preferredBackend: "webgl2" });
        await createRenderer({ ...config, preferredBackend: "webgpu" });
        expect(constructed).toEqual(["webgl", "webgpu"]);

        support.webgpu = false;
        await expect(createRenderer({ ...config, preferredBackend: "webgpu" })).rejects.toThrow("WebGPU not supported");
        support.webgl = false;
        await expect(createRenderer({ ...config, preferredBackend: "webgl" })).rejects.toThrow("WebGL not supported");
        expect(constructed).toEqual(["webgl", "webgpu"]);
    });
});

describe("getAvailableBackends", () => {
    it("lists what the browser offers", async () => {
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
            ((type: string) => (type === "webgl" ? {} : null)) as never,
        );
        expect(await getAvailableBackends()).toEqual(["webgpu", "webgl"]);
        support.webgpu = false;
        support.webgl = false;
        expect(await getAvailableBackends()).toEqual([]);
    });
});
