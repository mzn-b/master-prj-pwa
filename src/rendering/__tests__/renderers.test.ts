import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebGLRenderer } from "../WebGLRenderer";
import { WebGPURenderer } from "../WebGPURenderer";
import type { Overlay, RenderContext } from "../types";

/**
 * The two backends behind the landmarks view. Both must size the canvas in
 * device pixels, clear to transparent so the camera shows through, and run the
 * enabled overlays in their declared order. The GPU APIs are recording
 * stand-ins.
 */
const ctx = {} as RenderContext;

function overlay(id: string, order: number, enabled = true, log: string[] = []) {
    return {
        id, order, enabled, type: "custom",
        init: vi.fn(async () => {}),
        update: vi.fn(() => log.push(`update ${id}`)),
        render: vi.fn(() => log.push(`render ${id}`)),
        renderWebGPU: vi.fn(() => log.push(`upload ${id}`)),
        encodeWebGPU: vi.fn(() => log.push(`encode ${id}`)),
        dispose: vi.fn(),
    } satisfies Overlay & Record<string, unknown>;
}

function fakeGL() {
    return {
        BLEND: 1, SRC_ALPHA: 2, ONE_MINUS_SRC_ALPHA: 3, COLOR_BUFFER_BIT: 4, MAX_TEXTURE_SIZE: 5,
        enable: vi.fn(), blendFunc: vi.fn(), viewport: vi.fn(),
        clearColor: vi.fn(), clear: vi.fn(), flush: vi.fn(),
        getParameter: vi.fn(() => 4096),
        getExtension: vi.fn(() => null),
    };
}

function canvasWith(contexts: Record<string, unknown>) {
    const canvas = document.createElement("canvas");
    const getContext = vi.fn((type: string) => contexts[type] ?? null);
    canvas.getContext = getContext as never;
    return { canvas, getContext };
}

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("WebGLRenderer", () => {
    it("prefers WebGL 2, with alpha so the camera shows through", async () => {
        const gl = fakeGL();
        const { canvas, getContext } = canvasWith({ webgl2: gl, webgl: fakeGL() });
        const renderer = new WebGLRenderer({ canvas, width: 200, height: 100, pixelRatio: 3 });
        await renderer.init();
        expect(getContext).toHaveBeenCalledWith("webgl2", expect.objectContaining({ alpha: true, premultipliedAlpha: true }));
        expect(renderer.isWebGL2Context()).toBe(true);
        expect(renderer.getCapabilities()).toMatchObject({ backend: "webgl2", maxTextureSize: 4096, instancing: true });
        expect(gl.blendFunc).toHaveBeenCalledWith(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        expect([canvas.width, canvas.height]).toEqual([600, 300]);
        expect(gl.viewport).toHaveBeenCalledWith(0, 0, 600, 300);
    });

    it("falls back to WebGL 1, and fails without either", async () => {
        const { canvas } = canvasWith({ webgl: fakeGL() });
        const renderer = new WebGLRenderer({ canvas, width: 1, height: 1, pixelRatio: 1 });
        await renderer.init();
        expect(renderer.getCapabilities().backend).toBe("webgl");

        const none = new WebGLRenderer({ ...canvasWith({}), width: 1, height: 1 });
        await expect(none.init()).rejects.toThrow("WebGL not supported");
    });

    it("clears to transparent and runs enabled overlays in order", async () => {
        const gl = fakeGL();
        const { canvas } = canvasWith({ webgl2: gl });
        const renderer = new WebGLRenderer({ canvas, width: 1, height: 1, pixelRatio: 1 });
        const log: string[] = [];
        await renderer.addOverlay(overlay("late", 2, true, log));
        await renderer.addOverlay(overlay("off", 0, false, log));
        await renderer.addOverlay(overlay("early", 1, true, log));

        renderer.render(ctx); // before init: nothing
        expect(log).toEqual([]);

        await renderer.init();
        renderer.render(ctx);
        expect(gl.clearColor).toHaveBeenCalledWith(0, 0, 0, 0);
        expect(log).toEqual(["update early", "render early", "update late", "render late"]);
        expect(gl.flush).toHaveBeenCalled();
    });

    it("initialises overlays added later, and disposes removed ones", async () => {
        const { canvas } = canvasWith({ webgl2: fakeGL() });
        const renderer = new WebGLRenderer({ canvas, width: 1, height: 1, pixelRatio: 1 });
        await renderer.init();
        const late = overlay("late", 0);
        await renderer.addOverlay(late);
        expect(late.init).toHaveBeenCalledWith(renderer);
        expect(renderer.getOverlay("late")).toBe(late);

        renderer.removeOverlay("late");
        renderer.removeOverlay("missing");
        expect(late.dispose).toHaveBeenCalledTimes(1);
        expect(renderer.getOverlay("late")).toBeUndefined();

        const kept = overlay("kept", 0);
        await renderer.addOverlay(kept);
        renderer.dispose();
        expect(kept.dispose).toHaveBeenCalled();
    });
});

describe("WebGPURenderer", () => {
    function fakeGPU(adapter: unknown = undefined) {
        const pass = { end: vi.fn() };
        const encoder = { beginRenderPass: vi.fn<(descriptor: GPURenderPassDescriptor) => typeof pass>(() => pass), finish: vi.fn(() => "commands") };
        let loseDevice: (info: { message: string }) => void = () => {};
        const device = {
            lost: new Promise<{ message: string }>(resolve => (loseDevice = resolve)),
            createCommandEncoder: vi.fn(() => encoder),
            queue: { submit: vi.fn() },
            destroy: vi.fn(),
        };
        const gpuAdapter = adapter === undefined ? { requestDevice: vi.fn(async () => device) } : adapter;
        const gpu = {
            requestAdapter: vi.fn(async () => gpuAdapter),
            getPreferredCanvasFormat: () => "bgra8unorm",
        };
        vi.stubGlobal("navigator", { ...navigator, gpu });
        const context = { configure: vi.fn(), getCurrentTexture: () => ({ createView: () => "view" }) };
        return { gpu, device, encoder, pass, context, lose: (m: string) => loseDevice({ message: m }) };
    }

    it("is supported only with an adapter", async () => {
        vi.stubGlobal("navigator", { ...navigator, gpu: undefined });
        expect(await WebGPURenderer.isSupported()).toBe(false);
        fakeGPU(null);
        expect(await WebGPURenderer.isSupported()).toBe(false);
        fakeGPU();
        expect(await WebGPURenderer.isSupported()).toBe(true);
        const { gpu } = fakeGPU();
        gpu.requestAdapter.mockRejectedValueOnce(new Error("blocked"));
        expect(await WebGPURenderer.isSupported()).toBe(false);
    });

    it("asks for the high-performance adapter and a premultiplied canvas", async () => {
        const { gpu, context } = fakeGPU();
        const { canvas } = canvasWith({ webgpu: context });
        const renderer = new WebGPURenderer({ canvas, width: 200, height: 100, pixelRatio: 2 });
        await renderer.init();
        expect(gpu.requestAdapter).toHaveBeenCalledWith({ powerPreference: "high-performance" });
        expect(context.configure).toHaveBeenCalledWith(
            expect.objectContaining({ format: "bgra8unorm", alphaMode: "premultiplied" }),
        );
        expect([canvas.width, canvas.height]).toEqual([400, 200]);
        expect(renderer.getFormat()).toBe("bgra8unorm");
        expect(renderer.getCapabilities().backend).toBe("webgpu");
    });

    it("fails without WebGPU, an adapter or a canvas context", async () => {
        const { canvas } = canvasWith({});
        vi.stubGlobal("navigator", { ...navigator, gpu: undefined });
        await expect(new WebGPURenderer({ canvas, width: 1, height: 1 }).init()).rejects.toThrow("WebGPU not supported");
        fakeGPU(null);
        await expect(new WebGPURenderer({ canvas, width: 1, height: 1 }).init()).rejects.toThrow("adapter");
        fakeGPU();
        await expect(new WebGPURenderer({ canvas, width: 1, height: 1 }).init()).rejects.toThrow("context");
    });

    it("uploads, then encodes enabled overlays in order in one cleared pass", async () => {
        const { device, encoder, pass, context } = fakeGPU();
        const { canvas } = canvasWith({ webgpu: context });
        const renderer = new WebGPURenderer({ canvas, width: 1, height: 1, pixelRatio: 1 });
        const log: string[] = [];
        await renderer.addOverlay(overlay("late", 2, true, log));
        await renderer.addOverlay(overlay("off", 0, false, log));
        await renderer.addOverlay(overlay("early", 1, true, log));
        await renderer.init();
        renderer.render(ctx);

        expect(log).toEqual(["update early", "upload early", "update late", "upload late", "encode early", "encode late"]);
        const descriptor = encoder.beginRenderPass.mock.calls[0][0];
        const attachment = (descriptor.colorAttachments as GPURenderPassColorAttachment[])[0];
        expect(attachment).toMatchObject({ clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear" });
        expect(pass.end).toHaveBeenCalled();
        expect(device.queue.submit).toHaveBeenCalledWith(["commands"]);
    });

    it("stops drawing once the device is lost, and destroys it on dispose", async () => {
        const { device, context, lose } = fakeGPU();
        const { canvas } = canvasWith({ webgpu: context });
        const renderer = new WebGPURenderer({ canvas, width: 1, height: 1, pixelRatio: 1 });
        const kept = overlay("kept", 0);
        await renderer.addOverlay(kept);
        await renderer.init();
        lose("GPU reset");
        await Promise.resolve();
        renderer.render(ctx);
        expect(device.createCommandEncoder).not.toHaveBeenCalled();

        renderer.removeOverlay("kept");
        expect(kept.dispose).toHaveBeenCalled();
        renderer.dispose();
        expect(device.destroy).toHaveBeenCalled();
    });
});
