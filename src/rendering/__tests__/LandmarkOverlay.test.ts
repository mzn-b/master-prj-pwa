import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandmarkOverlay } from "../overlays/LandmarkOverlay";
import { DEFAULT_LANDMARK_CONFIG, type RenderContext, type Renderer } from "../types";
import type { TrackingDTO } from "../../domain/tracking.dto";
import type { ViewGeometry } from "../../render/coordinates";

/**
 * The landmarks view: every face and hand point projected through the shared
 * view transform, in device pixels, face points in the face colour and hand
 * points in the hand colour. Both GPU APIs are recording stand-ins, so the
 * test reads what would be uploaded and drawn; the pixels are checked on the
 * phones.
 */

/** Mirrored selfie preview: a 100x100 frame shown in a 200x200 view. */
const geometry: ViewGeometry = {
    frameWidth: 100, frameHeight: 100, viewWidth: 200, viewHeight: 200,
    rotation: 0, mirrorX: true, resizeMode: "cover",
};

const tracking: TrackingDTO = {
    timestampMs: 0,
    mode: "combined",
    face: { faces: [{ landmarks: [{ x: 0.25, y: 0.5, z: 0 }, { x: 0.75, y: 0.1, z: 0 }] }] },
    hand: { hands: [{ handedness: "Left", landmarks: [{ x: 0.5, y: 0.5, z: 0 }] }] },
};

function context(t: TrackingDTO | null = tracking): RenderContext {
    return { tracking: t, width: 200, height: 200, geometry, deltaTime: 16, elapsedTime: 16 };
}

const config = () => structuredClone(DEFAULT_LANDMARK_CONFIG);

function fakeGL(compiles = true) {
    const gl = {
        VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
        ARRAY_BUFFER: 5, DYNAMIC_DRAW: 6, FLOAT: 7, POINTS: 8,
        createShader: vi.fn((type: number) => ({ type })),
        shaderSource: vi.fn(), compileShader: vi.fn(),
        getShaderParameter: vi.fn(() => compiles),
        getShaderInfoLog: vi.fn(() => "syntax error"),
        createProgram: vi.fn(() => ({ program: true })),
        attachShader: vi.fn(), linkProgram: vi.fn(),
        getProgramParameter: vi.fn(() => true),
        getProgramInfoLog: vi.fn(),
        deleteShader: vi.fn(), deleteProgram: vi.fn(), deleteBuffer: vi.fn(),
        createBuffer: vi.fn(() => ({})),
        bindBuffer: vi.fn(), bufferData: vi.fn(), bufferSubData: vi.fn(),
        getAttribLocation: vi.fn((_p: unknown, name: string) => (name === "a_position" ? 0 : 1)),
        getUniformLocation: vi.fn((_p: unknown, name: string) => ({ name })),
        useProgram: vi.fn(), uniform2f: vi.fn(), uniform4f: vi.fn(),
        enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(),
        drawArrays: vi.fn(),
    };
    return gl;
}

function fakeDevice() {
    const buffers: Array<{ size: number; destroy: ReturnType<typeof vi.fn> }> = [];
    return {
        buffers,
        createShaderModule: vi.fn(() => ({})),
        createBuffer: vi.fn((d: { size: number }) => {
            const b = { size: d.size, destroy: vi.fn() };
            buffers.push(b);
            return b;
        }),
        createBindGroupLayout: vi.fn(() => ({})),
        createBindGroup: vi.fn(() => ({})),
        createPipelineLayout: vi.fn(() => ({})),
        createRenderPipeline: vi.fn(() => ({ pipeline: true })),
        queue: { writeBuffer: vi.fn() },
    };
}

function renderer(backend: "webgl" | "webgl2" | "webgpu", gpu: { gl?: unknown; device?: unknown }) {
    return {
        getCapabilities: () => ({ backend }),
        getPixelRatio: () => 2,
        getGL: () => gpu.gl,
        getDevice: () => gpu.device,
        getFormat: () => "bgra8unorm",
    } as unknown as Renderer;
}

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, COPY_DST: 2, UNIFORM: 4 });
    vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("LandmarkOverlay on WebGL", () => {
    async function webgl(compiles = true) {
        const gl = fakeGL(compiles);
        const overlay = new LandmarkOverlay(config());
        await overlay.init(renderer("webgl2", { gl }));
        return { gl, overlay };
    }

    it("draws face points then hand points, projected and in device pixels", async () => {
        const { gl, overlay } = await webgl();
        overlay.update(context());
        overlay.render(context());

        // Mirrored: x 0.25 -> 150 px, 0.75 -> 50 px; doubled for a pixel ratio of 2.
        const positions = Array.from(gl.bufferSubData.mock.calls[0][2] as Float32Array);
        expect(positions).toEqual([300, 200, 100, 40, 200, 200]);
        const sizes = Array.from(gl.bufferSubData.mock.calls[1][2] as Float32Array);
        expect(sizes).toEqual([8, 8, 12]); // face 4 px, hand 6 px, doubled
        expect(gl.uniform2f).toHaveBeenCalledWith({ name: "u_resolution" }, 400, 400);

        expect(gl.drawArrays.mock.calls).toEqual([[gl.POINTS, 0, 2], [gl.POINTS, 2, 1]]);
        expect(gl.uniform4f.mock.calls).toEqual([
            [{ name: "u_color" }, ...DEFAULT_LANDMARK_CONFIG.faceStyle.color],
            [{ name: "u_color" }, ...DEFAULT_LANDMARK_CONFIG.handStyle.color],
        ]);
    });

    it("draws only the hand when no face is tracked", async () => {
        const { gl, overlay } = await webgl();
        const handsOnly = { ...tracking, face: undefined };
        overlay.update(context(handsOnly));
        overlay.render(context(handsOnly));
        expect(gl.drawArrays.mock.calls).toEqual([[gl.POINTS, 0, 1]]);
    });

    it("draws nothing for a frame without tracking", async () => {
        const { gl, overlay } = await webgl();
        overlay.update(context());
        overlay.update(context(null)); // the previous frame's points must not linger
        overlay.render(context(null));
        expect(gl.drawArrays).not.toHaveBeenCalled();
    });

    it("logs a shader that does not compile and then draws nothing", async () => {
        const { gl, overlay } = await webgl(false);
        expect(console.error).toHaveBeenCalledWith("Vertex shader error:", "syntax error");
        overlay.update(context());
        overlay.render(context());
        expect(gl.drawArrays).not.toHaveBeenCalled();
    });

    it("releases its program and buffers", async () => {
        const { gl, overlay } = await webgl();
        overlay.dispose();
        expect(gl.deleteProgram).toHaveBeenCalled();
        expect(gl.deleteBuffer).toHaveBeenCalledTimes(2);
        overlay.update(context());
        overlay.render(context());
        expect(gl.drawArrays).not.toHaveBeenCalled();
    });
});

describe("LandmarkOverlay on WebGPU", () => {
    async function webgpu() {
        const device = fakeDevice();
        const overlay = new LandmarkOverlay(config());
        await overlay.init(renderer("webgpu", { device }));
        return { device, overlay };
    }

    it("uploads resolution, both colours and one instance per point", async () => {
        const { device, overlay } = await webgpu();
        overlay.update(context());
        overlay.renderWebGPU(context());

        const [uniformCall, instanceCall] = device.queue.writeBuffer.mock.calls;
        expect(Array.from(uniformCall[2] as Float32Array)).toEqual(
            [400, 400, 0, 0, ...DEFAULT_LANDMARK_CONFIG.faceStyle.color, ...DEFAULT_LANDMARK_CONFIG.handStyle.color]
                .map(Math.fround),
        );
        // x, y, size, colour index (0 face, 1 hand) for three points.
        expect(instanceCall[4]).toBe(3 * 4 * 4);
        const instances = Array.from(new Float32Array(instanceCall[2] as ArrayBuffer, 0, 12));
        expect(instances).toEqual([300, 200, 8, 0, 100, 40, 8, 0, 200, 200, 12, 1]);
    });

    it("encodes one instanced quad draw for all points", async () => {
        const { overlay } = await webgpu();
        overlay.update(context());
        const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(), draw: vi.fn() };
        overlay.encodeWebGPU(pass as unknown as GPURenderPassEncoder);
        expect(pass.draw).toHaveBeenCalledWith(6, 3, 0, 0);
    });

    it("encodes nothing for a frame without points", async () => {
        const { device, overlay } = await webgpu();
        overlay.update(context(null));
        overlay.renderWebGPU(context(null));
        const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(), draw: vi.fn() };
        overlay.encodeWebGPU(pass as unknown as GPURenderPassEncoder);
        expect(device.queue.writeBuffer).not.toHaveBeenCalled();
        expect(pass.draw).not.toHaveBeenCalled();
    });

    it("destroys its buffers", async () => {
        const { device, overlay } = await webgpu();
        overlay.dispose();
        for (const b of device.buffers) expect(b.destroy).toHaveBeenCalled();
    });
});
