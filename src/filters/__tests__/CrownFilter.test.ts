import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import type { TrackingDTO } from "../../domain/tracking.dto";
import type { ViewGeometry } from "../../render/coordinates";

/**
 * Everything about the web crown except the GPU drawing itself: renderer
 * settings and lights shared with the native app, the model's normalisation
 * and clipping, sizing, the backend three chose, placement and pose per frame,
 * failure reporting and Safari's compositor kick. three's renderer and the
 * model loader are stand-ins; the pixels are checked on the phones.
 */
interface FakeRenderer {
    options: Record<string, unknown>;
    outputColorSpace?: string;
    toneMapping?: number;
    toneMappingExposure?: number;
    backend: { isWebGLBackend?: boolean };
    setClearColor: ReturnType<typeof vi.fn>;
    setSize: ReturnType<typeof vi.fn>;
    render: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
}
const renderers: FakeRenderer[] = [];
let initResult: Promise<void> = Promise.resolve();

vi.mock("three/webgpu", async () => {
    const actual = await vi.importActual<typeof import("three/webgpu")>("three/webgpu");
    class WebGPURenderer {
        options: Record<string, unknown>;
        backend = {};
        setClearColor = vi.fn();
        setSize = vi.fn();
        render = vi.fn();
        clear = vi.fn();
        dispose = vi.fn();
        constructor(options: Record<string, unknown>) {
            this.options = options;
            renderers.push(this as unknown as FakeRenderer);
        }
        init() {
            return initResult;
        }
    }
    return { ...actual, WebGPURenderer };
});

const loads: Array<{ url: string; onLoad: (gltf: unknown) => void; onError: (e: unknown) => void }> = [];
vi.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({
    GLTFLoader: class {
        load(url: string, onLoad: (g: unknown) => void, _p: unknown, onError: (e: unknown) => void) {
            loads.push({ url, onLoad, onError });
        }
    },
}));

import { CrownFilter } from "../CrownFilter";

/** The selfie preview the app uses: mirrored, a 100x100 frame in a 400x400 view. */
const geometry: ViewGeometry = {
    frameWidth: 100, frameHeight: 100, viewWidth: 400, viewHeight: 400,
    rotation: 0, mirrorX: true, resizeMode: "cover",
};

function face(nose: [number, number] = [0.5, 0.55]): TrackingDTO {
    const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    const set = (i: number, x: number, y: number) => (landmarks[i] = { x, y, z: 0 });
    set(10, 0.5, 0.3); // forehead top -> (200, 120) on screen
    set(234, 0.7, 0.5); // face left -> (120, 200), mirrored
    set(454, 0.3, 0.5); // face right -> (280, 200)
    set(33, 0.4, 0.45); // eye corners, level
    set(263, 0.6, 0.45);
    set(1, nose[0], nose[1]);
    set(152, 0.5, 0.8); // chin
    return { timestampMs: 1, mode: "combined", face: { faces: [{ landmarks }] } };
}

/** A 2 x 1 x 2 model whose box is off-centre, as an authored .glb may be. */
function model() {
    const scene = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 2), new THREE.MeshStandardMaterial());
    mesh.position.set(3, 0, 0);
    scene.add(mesh);
    return { scene };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

async function ready(onError?: (m: string) => void) {
    const canvas = document.createElement("canvas");
    const crown = new CrownFilter(canvas, onError);
    crown.resize(400, 400);
    await flush();
    loads.at(-1)?.onLoad(model());
    return { crown, canvas, renderer: renderers.at(-1) as FakeRenderer };
}

function scenePivot(renderer: FakeRenderer) {
    const scene = renderer.render.mock.calls.at(-1)?.[0] as THREE.Scene;
    const clipping = scene.children.find(c => (c as THREE.ClippingGroup).isClippingGroup) as THREE.ClippingGroup;
    return { scene, clipping, pivot: clipping.children[0] as THREE.Group };
}

beforeEach(() => {
    renderers.length = 0;
    loads.length = 0;
    initResult = Promise.resolve();
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("CrownFilter", () => {
    it("uses the renderer settings shared with the native app", async () => {
        const { renderer } = await ready();
        expect(renderer.options).toMatchObject({ alpha: true, antialias: true });
        expect(renderer.setClearColor).toHaveBeenCalledWith(0x000000, 0);
        expect(renderer.outputColorSpace).toBe(THREE.SRGBColorSpace);
        expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
        expect(renderer.toneMappingExposure).toBe(2.2);
    });

    it("lights the scene exactly as the native app does", async () => {
        const { crown, renderer } = await ready();
        crown.render(face(), geometry);
        const { scene } = scenePivot(renderer);
        const lights = scene.children.filter(c => (c as THREE.Light).isLight) as THREE.Light[];
        expect(lights.map(l => l.type)).toEqual([
            "AmbientLight", "DirectionalLight", "DirectionalLight", "DirectionalLight", "DirectionalLight",
        ]);
        expect(lights.map(l => l.intensity)).toEqual([5, 6, 4, 3, 3]);
        expect(lights.slice(1).map(l => l.position.toArray())).toEqual([
            [0, 1, 6], [0, 6, 2], [-4, 2, 3], [4, 2, 3],
        ]);
    });

    it("loads the model, centres it in a unit box and clips away its back half", async () => {
        const { crown, renderer } = await ready();
        expect(loads[0].url).toBe("/filters/crown.glb");
        crown.render(face(), geometry);
        const { clipping, pivot } = scenePivot(renderer);
        const plane = clipping.clippingPlanes[0];
        expect(plane.normal.toArray()).toEqual([0, 0, 1]);
        expect(plane.constant).toBe(0);
        const inner = pivot.children[0];
        expect(inner.scale.x).toBeCloseTo(0.5); // largest side 2 -> 1
        expect(inner.position.x).toBeCloseTo(-3); // box centre moved to the pivot
    });

    it("sizes renderer and camera once the renderer is up, y up", async () => {
        const { renderer, crown } = await ready();
        expect(renderer.setSize).toHaveBeenCalledWith(400, 400, false);
        crown.render(face(), geometry);
        const camera = renderer.render.mock.calls.at(-1)?.[1] as THREE.OrthographicCamera;
        expect([camera.left, camera.right, camera.top, camera.bottom]).toEqual([0, 400, 400, 0]);
    });

    it("reports which backend three chose", async () => {
        initResult = new Promise(() => {}); // never ready
        const pending = new CrownFilter(document.createElement("canvas"));
        expect(pending.backend()).toBe("pending");

        initResult = Promise.resolve();
        const { crown, renderer } = await ready();
        expect(crown.backend()).toBe("webgpu");
        renderer.backend.isWebGLBackend = true;
        expect(crown.backend()).toBe("webgl");
    });

    it("places the crown 1.12 face widths wide, lifted 0.15 of that above the forehead", async () => {
        const { crown, renderer } = await ready();
        crown.render(face(), geometry);
        const { pivot } = scenePivot(renderer);
        const width = 160 * 1.12;
        expect(pivot.scale.x).toBeCloseTo(width);
        expect(pivot.position.x).toBeCloseTo(200);
        expect(pivot.position.y).toBeCloseTo(400 - 120 + 0.15 * width); // y-up camera
        expect(pivot.rotation.z).toBeCloseTo(0); // level eyes
        expect(pivot.rotation.y).toBeCloseTo(0); // nose centred
        // Nose 0.2 of the face height below the eyes against a neutral 0.38.
        expect(pivot.rotation.x).toBeCloseTo((0.2 - 0.38) * Math.PI);
    });

    it("clamps the turn so the crown cannot swing past the side of the head", async () => {
        const { crown, renderer } = await ready();
        crown.render(face([0.95, 0.55]), geometry);
        expect(scenePivot(renderer).pivot.rotation.y).toBeCloseTo(-Math.PI / 2.2);
    });

    it("clears instead of drawing when no face is tracked", async () => {
        const { crown, renderer } = await ready();
        crown.render({ timestampMs: 1, mode: "combined" }, geometry);
        expect(renderer.clear).toHaveBeenCalled();
        expect(renderer.render).not.toHaveBeenCalled();
    });

    it("reports a renderer that fails to start", async () => {
        initResult = Promise.reject(new Error("no adapter"));
        const onError = vi.fn();
        new CrownFilter(document.createElement("canvas"), onError);
        await flush();
        expect(onError).toHaveBeenCalledWith("WebGPU/WebGL-Start fehlgeschlagen: no adapter");
    });

    it("reports a model that fails to load", async () => {
        const onError = vi.fn();
        new CrownFilter(document.createElement("canvas"), onError);
        loads.at(-1)?.onError(new Error("404"));
        expect(onError).toHaveBeenCalledWith("Krone konnte nicht geladen werden: 404");
    });

    it("kicks Safari's compositor for two seconds and then leaves the canvas alone", async () => {
        const now = vi.spyOn(performance, "now");
        const { crown, canvas } = await ready();
        now.mockReturnValue(10_000);
        crown.render(face(), geometry);
        const first = canvas.style.opacity;
        crown.render(face(), geometry);
        expect(new Set([first, canvas.style.opacity])).toEqual(new Set(["0.999", "1"]));

        now.mockReturnValue(10_000 + 2_500);
        crown.render(face(), geometry);
        crown.render(face(), geometry);
        expect(canvas.style.opacity).toBe("1");
    });

    it("releases the renderer", async () => {
        const { crown, renderer } = await ready();
        crown.dispose();
        expect(renderer.dispose).toHaveBeenCalled();
    });
});
