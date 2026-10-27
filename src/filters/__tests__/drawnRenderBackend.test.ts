import { describe, expect, it } from "vitest";
import { drawnRenderBackend } from "../types";
import type { ActiveFilters } from "../types";

/**
 * NF4 / data integrity — `renderBackend` must name what drew the session.
 *
 * It was set once, from the landmark renderer, so every filter session carried
 * the backend of a renderer that drew nothing in it (or null after a reload),
 * and whether the crown ran on WebGPU or on three's WebGL fallback was never
 * recorded at all.
 */
const PATHS = { landmarks: "webgpu", flat: "canvas2d", crown: "webgpu" };
const filters = (f: Partial<ActiveFilters>): ActiveFilters =>
    ({ crown: false, glasses: false, sparkles: false, ...f });

describe("drawnRenderBackend", () => {
    it("reports the landmark renderer in landmarks mode, whatever the selection holds", () => {
        expect(drawnRenderBackend("landmarks", filters({ crown: true }), PATHS)).toBe("webgpu");
        expect(drawnRenderBackend("landmarks", filters({}), { ...PATHS, landmarks: "webgl2" })).toBe("webgl2");
    });

    it("reports the 2D path for the image filters", () => {
        expect(drawnRenderBackend("filters", filters({ glasses: true }), PATHS)).toBe("canvas2d");
        expect(drawnRenderBackend("filters", filters({ sparkles: true }), PATHS)).toBe("canvas2d");
        expect(drawnRenderBackend("filters", filters({ glasses: true, sparkles: true }), PATHS)).toBe("canvas2d");
    });

    it("reports the crown's own backend, including the WebGL fallback", () => {
        expect(drawnRenderBackend("filters", filters({ crown: true }), PATHS)).toBe("webgpu");
        expect(drawnRenderBackend("filters", filters({ crown: true }), { ...PATHS, crown: "webgl" })).toBe("webgl");
    });

    it("joins both paths when all three filters are drawn", () => {
        expect(drawnRenderBackend("filters", filters({ crown: true, glasses: true, sparkles: true }), PATHS))
            .toBe("canvas2d+webgpu");
    });

    it("says so when the crown never finished initialising, and when nothing was drawn", () => {
        expect(drawnRenderBackend("filters", filters({ crown: true }), { ...PATHS, crown: undefined })).toBe("pending");
        expect(drawnRenderBackend("filters", filters({}), PATHS)).toBe("none");
    });
});
