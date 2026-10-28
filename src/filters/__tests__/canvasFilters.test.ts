import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SunglassesFilter } from "../SunglassesFilter";
import { SparklesFilter } from "../SparklesFilter";
import type { TrackingDTO } from "../../domain/tracking.dto";
import type { ViewGeometry } from "../../render/coordinates";

/**
 * The two 2D filters draw through a canvas context; a recording context lets
 * the test read what they would draw. Their constants are pinned against the
 * native sources in filterParity.test.ts; this pins what the code does with
 * them: where, how large, how rotated, how many.
 */
function recordingContext() {
    const calls: Array<[string, ...unknown[]]> = [];
    const record = (name: string) => (...args: unknown[]) => {
        calls.push([name, ...args]);
    };
    const ctx = {
        calls,
        globalAlpha: 1,
        save: record("save"),
        restore: record("restore"),
        translate: record("translate"),
        rotate: record("rotate"),
        drawImage: vi.fn((...args: unknown[]) => calls.push(["drawImage", ...args, ctx.globalAlpha])),
    };
    return ctx;
}

/** The selfie preview the app always uses: mirrored, 100x100 frame in a 200x200 view. */
const geometry: ViewGeometry = {
    frameWidth: 100,
    frameHeight: 100,
    viewWidth: 200,
    viewHeight: 200,
    rotation: 0,
    mirrorX: true,
    resizeMode: "cover",
};

function loaded<T extends { img: HTMLImageElement | null }>(filter: T, width: number, height: number): T {
    const img = filter.img as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: width });
    Object.defineProperty(img, "naturalHeight", { value: height });
    img.onload?.(new Event("load"));
    return filter;
}

function faceWithEyes(left: [number, number], right: [number, number]): TrackingDTO {
    const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    landmarks[33] = { x: left[0], y: left[1], z: 0 };
    landmarks[263] = { x: right[0], y: right[1], z: 0 };
    return { timestampMs: 0, mode: "combined", face: { faces: [{ landmarks }] } };
}

describe("SunglassesFilter", () => {
    it("loads the licensed image from the app's own assets", () => {
        const filter = new SunglassesFilter() as unknown as { img: HTMLImageElement };
        expect(filter.img.src.endsWith("/filters/sunglasses.png")).toBe(true);
    });

    it("draws nothing before the image has loaded or without a face", () => {
        const ctx = recordingContext();
        const notLoaded = new SunglassesFilter();
        notLoaded.render(ctx as never, faceWithEyes([0.6, 0.5], [0.4, 0.5]), geometry);
        const ready = loaded(new SunglassesFilter() as never, 955, 350) as SunglassesFilter;
        ready.render(ctx as never, { timestampMs: 0, mode: "combined" }, geometry);
        expect(ctx.drawImage).not.toHaveBeenCalled();
    });

    it("spans 1.5 eye distances at the image's aspect, centred and level", () => {
        const ctx = recordingContext();
        const filter = loaded(new SunglassesFilter() as never, 955, 350) as SunglassesFilter;
        // Mirrored: landmark 33 at x 0.4 lands at 120 px, 263 at 0.6 lands at 80 px.
        filter.render(ctx as never, faceWithEyes([0.4, 0.5], [0.6, 0.5]), geometry);

        const translate = ctx.calls.find(c => c[0] === "translate");
        const rotate = ctx.calls.find(c => c[0] === "rotate");
        const draw = ctx.calls.find(c => c[0] === "drawImage") as unknown[];
        const width = 40 * 1.5;
        const height = width * (350 / 955);
        expect(translate?.slice(1)).toEqual([100, 100]);
        expect(rotate?.[1] as number).toBeCloseTo(0);
        expect(draw.slice(2, 6)).toEqual([-width / 2, -height / 2, width, height]);
        expect(ctx.calls[0][0]).toBe("save");
        expect(ctx.calls.at(-1)?.[0]).toBe("restore");
    });

    it("rotates with the eye line", () => {
        const ctx = recordingContext();
        const filter = loaded(new SunglassesFilter() as never, 955, 350) as SunglassesFilter;
        // Mirrored eyes at (120, 110) and (80, 90): the line rises to the left.
        filter.render(ctx as never, faceWithEyes([0.4, 0.55], [0.6, 0.45]), geometry);
        const rotate = ctx.calls.find(c => c[0] === "rotate");
        expect(rotate?.[1] as number).toBeCloseTo(Math.atan2(20, 40));
    });
});

describe("SparklesFilter", () => {
    let random: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        random = vi.spyOn(Math, "random").mockReturnValue(0); // always spawn
    });

    afterEach(() => random.mockRestore());

    function hands(count: number): TrackingDTO {
        const hand = (row: number) => ({
            handedness: "Right" as const,
            landmarks: Array.from({ length: 21 }, (_, i) => ({ x: 0.05 * i, y: 0.25 + 0.5 * row, z: 0 })),
        });
        return { timestampMs: 0, mode: "combined", hand: { hands: Array.from({ length: count }, (_, i) => hand(i)) } };
    }

    it("spawns one sparkle per fingertip per 33 ms step, whatever the frame rate", () => {
        const filter = new SparklesFilter();
        filter.update(hands(1), geometry, 1000); // first call: one step
        expect((filter as unknown as { particles: unknown[] }).particles).toHaveLength(5);

        filter.update(hands(1), geometry, 1000 + 66); // two more steps
        expect((filter as unknown as { particles: unknown[] }).particles).toHaveLength(15);

        filter.update(hands(1), geometry, 1000 + 66 + 10); // too soon for a step
        expect((filter as unknown as { particles: unknown[] }).particles).toHaveLength(15);
    });

    it("catches up at most five steps after a pause", () => {
        const filter = new SparklesFilter();
        filter.update(hands(1), geometry, 1000);
        filter.update(hands(1), geometry, 1000 + 10_000);
        expect((filter as unknown as { particles: unknown[] }).particles).toHaveLength(5 + 25);
    });

    it("spawns for every hand and lets sparkles fall without spawning once switched off", () => {
        const filter = new SparklesFilter();
        filter.update(hands(2), geometry, 1000);
        expect((filter as unknown as { particles: unknown[] }).particles).toHaveLength(10);
        filter.update(hands(2), geometry, 1033, false);
        expect((filter as unknown as { particles: unknown[] }).particles).toHaveLength(10);
        expect(filter.hasParticles()).toBe(true);
        filter.reset();
        expect(filter.hasParticles()).toBe(false);
    });

    it("draws each sparkle 18 px square around its position, at its opacity", () => {
        const ctx = recordingContext();
        const filter = loaded(new SparklesFilter() as never, 64, 64) as SparklesFilter;
        filter.update(hands(1), geometry, 1000);
        filter.render(ctx as never);
        const draws = ctx.calls.filter(c => c[0] === "drawImage");
        expect(draws).toHaveLength(5);
        // Fingertip 4 of a mirrored 0.2 lands at 160 px; row 0 at 50 px.
        expect(draws[0].slice(2, 6)).toEqual([160 - 9, 50 - 9, 18, 18]);
        expect(draws[0][6] as number).toBeGreaterThan(0);
    });

    it("draws nothing before the image has loaded", () => {
        const ctx = recordingContext();
        const filter = new SparklesFilter();
        filter.update(hands(1), geometry, 1000);
        filter.render(ctx as never);
        expect(ctx.drawImage).not.toHaveBeenCalled();
    });
});
