import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ViewGeometry } from "../../render/coordinates";

/**
 * The hook behind the landmarks view. The renderer is created on the first
 * frame that has a size, gets the landmark overlay, follows the view's size,
 * and is released with the screen. The factory and overlay are stand-ins.
 */
const renderer = {
    addOverlay: vi.fn(async () => {}),
    getCapabilities: vi.fn(() => ({ backend: "webgpu" })),
    resize: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
};
const createRenderer = vi.fn();
vi.mock("../createRenderer", () => ({ createRenderer: (...a: unknown[]) => createRenderer(...a) }));
vi.mock("../overlays/LandmarkOverlay", () => ({
    LandmarkOverlay: vi.fn(function LandmarkOverlay() {
        return { id: "landmarks" };
    }),
}));

import { useRenderer } from "../useRenderer";

const geometry = (viewWidth: number, viewHeight: number): ViewGeometry => ({
    frameWidth: 100, frameHeight: 100, viewWidth, viewHeight, rotation: 0, mirrorX: true, resizeMode: "cover",
});

function mount(options?: Parameters<typeof useRenderer>[0]) {
    const hook = renderHook(() => useRenderer(options));
    hook.result.current.canvasRef.current = document.createElement("canvas");
    return hook;
}

beforeEach(() => {
    for (const fn of Object.values(renderer)) fn.mockClear();
    createRenderer.mockReset().mockResolvedValue(renderer);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("useRenderer", () => {
    it("creates the renderer on the first sized frame, once, with the landmark overlay", async () => {
        const { result } = mount();
        act(() => result.current.render(null, geometry(0, 0))); // no size yet
        expect(createRenderer).not.toHaveBeenCalled();

        act(() => {
            result.current.render(null, geometry(200, 400));
            result.current.render(null, geometry(200, 400)); // still starting
        });
        await waitFor(() => expect(result.current.isInitialized).toBe(true));
        expect(createRenderer).toHaveBeenCalledTimes(1);
        expect(createRenderer.mock.calls[0][0]).toMatchObject({ width: 200, height: 400, preferredBackend: "auto" });
        expect(renderer.addOverlay).toHaveBeenCalledWith({ id: "landmarks" });
        expect(result.current.capabilities).toEqual({ backend: "webgpu" });
        expect(renderer.render).not.toHaveBeenCalled(); // the starting frames are skipped
    });

    it("waits for the canvas", () => {
        const { result } = renderHook(() => useRenderer());
        act(() => result.current.render(null, geometry(200, 400)));
        expect(createRenderer).not.toHaveBeenCalled();
    });

    it("renders with frame timing and follows the view's size", async () => {
        const { result } = mount({ autoAddLandmarkOverlay: false });
        act(() => result.current.render(null, geometry(200, 400)));
        await waitFor(() => expect(result.current.isInitialized).toBe(true));
        expect(renderer.addOverlay).not.toHaveBeenCalled();

        const now = vi.spyOn(performance, "now").mockReturnValue(1000);
        result.current.render(null, geometry(200, 400));
        now.mockReturnValue(1016);
        result.current.render(null, geometry(300, 400));

        expect(renderer.resize).toHaveBeenCalledTimes(1);
        expect(renderer.resize).toHaveBeenCalledWith(300, 400);
        expect(renderer.render.mock.calls[0][0]).toMatchObject({ deltaTime: 0, elapsedTime: 0, width: 200 });
        expect(renderer.render.mock.calls[1][0]).toMatchObject({ deltaTime: 16, elapsedTime: 16, width: 300 });
    });

    it("reports a renderer that fails to start", async () => {
        createRenderer.mockRejectedValue(new Error("No suitable rendering backend available"));
        const { result } = mount();
        act(() => result.current.render(null, geometry(200, 400)));
        await waitFor(() => expect(result.current.error?.message).toBe("No suitable rendering backend available"));
        expect(result.current.isInitialized).toBe(false);
    });

    it("releases the renderer on dispose and on unmount", async () => {
        const { result, unmount } = mount();
        act(() => result.current.render(null, geometry(200, 400)));
        await waitFor(() => expect(result.current.isInitialized).toBe(true));
        act(() => result.current.dispose());
        expect(renderer.dispose).toHaveBeenCalledTimes(1);
        expect(result.current.isInitialized).toBe(false);

        act(() => result.current.render(null, geometry(200, 400)));
        await waitFor(() => expect(result.current.isInitialized).toBe(true));
        unmount();
        expect(renderer.dispose).toHaveBeenCalledTimes(2);
    });
});
