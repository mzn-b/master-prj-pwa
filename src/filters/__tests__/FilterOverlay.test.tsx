import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import type { TrackingDTO } from "../../domain/tracking.dto";
import type { ViewGeometry } from "../../render/coordinates";
import { DEFAULT_ACTIVE_FILTERS, type ActiveFilters } from "../types";

/**
 * The overlay decides each frame which filter does work at all. A filter that
 * is off must cost nothing (the per-filter comparison depends on it), the crown
 * is built only on first use, and every canvas is sized in device pixels.
 * The filters themselves are stand-ins here; they are tested on their own.
 */
const sunglasses = { render: vi.fn() };
const sparkles = { update: vi.fn(), render: vi.fn(), hasParticles: vi.fn(() => false), reset: vi.fn() };
const crown = { render: vi.fn(), resize: vi.fn(), dispose: vi.fn(), backend: vi.fn(() => "webgpu") };
const crownConstructed = vi.fn();

vi.mock("../SunglassesFilter", () => ({
    SunglassesFilter: vi.fn(function SunglassesFilter() {
        return sunglasses;
    }),
}));
vi.mock("../SparklesFilter", () => ({
    SparklesFilter: vi.fn(function SparklesFilter() {
        return sparkles;
    }),
}));
vi.mock("../CrownFilter", () => ({
    // A function, not an arrow: the overlay constructs it with `new`.
    CrownFilter: vi.fn(function CrownFilter(...args: unknown[]) {
        crownConstructed(...args);
        return crown;
    }),
}));

import { FilterOverlay, type FilterOverlayHandle } from "../FilterOverlay";

const geometry: ViewGeometry = {
    frameWidth: 100, frameHeight: 100, viewWidth: 200, viewHeight: 400,
    rotation: 0, mirrorX: true, resizeMode: "cover",
};
const tracking: TrackingDTO = { timestampMs: 1, mode: "combined" };
const ctx = { clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), scale: vi.fn() };

function mount(filters: Partial<ActiveFilters>, onFilterError?: (m: string) => void) {
    const ref = createRef<FilterOverlayHandle>();
    const view = render(
        <FilterOverlay
            ref={ref}
            activeFilters={{ ...DEFAULT_ACTIVE_FILTERS, ...filters }}
            width={200}
            height={400}
            onFilterError={onFilterError}
        />,
    );
    return { ref, view, handle: ref.current as FilterOverlayHandle };
}

beforeEach(() => {
    for (const fn of [
        sunglasses.render, sparkles.update, sparkles.render, sparkles.reset,
        crown.render, crown.resize, crown.dispose, crownConstructed, ctx.clearRect, ctx.scale,
    ]) fn.mockClear();
    sparkles.hasParticles.mockReturnValue(false);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
        ((type: string) => (type === "2d" ? ctx : null)) as never,
    );
    Object.defineProperty(window, "devicePixelRatio", { value: 3, configurable: true });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe("FilterOverlay", () => {
    it("sizes both canvases in device pixels", () => {
        const { view } = mount({});
        const canvases = view.container.querySelectorAll("canvas");
        expect(canvases).toHaveLength(2);
        for (const canvas of canvases) {
            expect([canvas.width, canvas.height]).toEqual([600, 1200]);
        }
    });

    it("does no filter work while every filter is off", () => {
        const { handle } = mount({});
        handle.tick(tracking, geometry);
        expect(ctx.clearRect).toHaveBeenCalled();
        expect(ctx.scale).toHaveBeenCalledWith(3, 3);
        expect(sparkles.update).not.toHaveBeenCalled();
        expect(sunglasses.render).not.toHaveBeenCalled();
        expect(crownConstructed).not.toHaveBeenCalled();
    });

    it("draws the glasses for a tracked frame", () => {
        const { handle } = mount({ glasses: true });
        handle.tick(tracking, geometry);
        expect(sunglasses.render).toHaveBeenCalledWith(ctx, tracking, geometry);
        handle.tick(null, geometry);
        expect(sunglasses.render).toHaveBeenCalledTimes(1);
    });

    it("runs the sparkles while on, and only to let them fade once off", () => {
        const { handle, view } = mount({ sparkles: true });
        handle.tick(tracking, geometry);
        expect(sparkles.update).toHaveBeenLastCalledWith(tracking, geometry, expect.any(Number), true);
        expect(sparkles.render).toHaveBeenCalled();

        view.rerender(
            <FilterOverlay activeFilters={DEFAULT_ACTIVE_FILTERS} width={200} height={400} />,
        );
        sparkles.update.mockClear();
        handle.tick(tracking, geometry);
        expect(sparkles.update).not.toHaveBeenCalled(); // nothing left to fade

        sparkles.hasParticles.mockReturnValue(true);
        handle.tick(tracking, geometry);
        expect(sparkles.update).toHaveBeenLastCalledWith(tracking, geometry, expect.any(Number), false);
    });

    it("builds the crown on first use only, at the overlay's size", () => {
        const onFilterError = vi.fn();
        const { handle } = mount({ crown: true }, onFilterError);
        expect(handle.crownBackend()).toBeUndefined();

        handle.tick(tracking, geometry);
        handle.tick(tracking, geometry);
        expect(crownConstructed).toHaveBeenCalledTimes(1);
        expect(crownConstructed.mock.calls[0][0]).toBeInstanceOf(HTMLCanvasElement);
        expect(crownConstructed.mock.calls[0][1]).toBe(onFilterError);
        expect(crown.resize).toHaveBeenCalledWith(200, 400);
        expect(crown.render).toHaveBeenCalledTimes(2);
        expect(handle.crownBackend()).toBe("webgpu");
    });

    it("releases the crown and the sparkles when it unmounts", () => {
        const { handle, view } = mount({ crown: true });
        handle.tick(tracking, geometry);
        view.unmount();
        expect(crown.dispose).toHaveBeenCalled();
        expect(sparkles.reset).toHaveBeenCalled();
    });
});
