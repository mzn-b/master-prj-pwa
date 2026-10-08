import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => fs.readFileSync(path.join(here, p), "utf8");
const nativeDir = path.resolve(here, "../../../../master-prj-native-2/src/render/filters");
const haveNative = fs.existsSync(nativeDir);
const readNative = (f: string) => fs.readFileSync(path.join(nativeDir, f), "utf8");

/**
 * The three filters are what a participant sees, and the UX questionnaire asks
 * them to rate the two apps against each other — so a filter that looks
 * different is scored as a product difference when the study is trying to
 * isolate a platform one.
 *
 * `crownParity.test.ts` already pinned the crown's *structure* — clipping
 * normal, unit normalisation, pivot — and passed throughout while the crown was
 * drawn at 0.60x the face width against native's 1.12x. Structure was never the
 * thing that drifted. These assertions pin the **magnitudes**: the numbers that
 * decide how big, how fast and how many.
 *
 * Found by a parity audit on 2026-10-08: all three filters had diverged while
 * every test passed. See THESIS-FINDINGS.md section 3.17.
 */
const num = (src: string, name: string): number =>
    Number(new RegExp(`${name}\\s*=\\s*([0-9.]+)`).exec(src)?.[1]);

describe.skipIf(!haveNative)("filter magnitude parity with native", () => {
    it("sizes the crown identically", () => {
        const pwa = read("../CrownFilter.ts");
        const native = readNative("Crown3D.tsx");
        expect(num(pwa, "CROWN_WIDTH_RATIO")).toBe(num(native, "CROWN_WIDTH_RATIO"));
        expect(num(pwa, "LIFT")).toBe(num(native, "LIFT"));
        expect(num(pwa, "NEUTRAL_NOSE_RATIO")).toBe(num(native, "NEUTRAL_NOSE_RATIO"));
    });

    it("sizes the glasses identically", () => {
        // The PWA scales the outer-eye distance inline; native names it.
        const pwa = read("../SunglassesFilter.ts");
        const native = readNative("GlassesFilter.tsx");
        const pwaScale = Number(/dist \* ([0-9.]+)/.exec(pwa)?.[1]);
        expect(pwaScale).toBe(num(native, "WIDTH_SCALE"));
    });

    it("shares one particle system, byte for byte", () => {
        // Copied rather than reimplemented: the two had drifted into different
        // algorithms — different gravity, a different initial-velocity model,
        // random sizes against a fixed one, and a cap on one side only.
        expect(read("../sparkleSystem.ts")).toBe(readNative("sparkleSystem.ts"));
    });

    it("spawns sparkles at the same rate and on the same cadence", () => {
        const pwa = read("../SparklesFilter.ts");
        const native = readNative("SparklesFilter.tsx");
        expect(num(pwa, "SPAWN_PER_TIP_PER_FRAME")).toBe(num(native, "SPAWN_PER_TIP_PER_FRAME"));
        // The cadence is the performance-relevant one: the PWA used to spawn
        // once per rendered frame, so particle count scaled with display rate.
        expect(num(pwa, "TICK_MS")).toBe(num(native, "TICK_MS"));
        expect(num(pwa, "SPARKLE_SIZE")).toBe(num(native, "SPARKLE_SIZE"));
    });

    it("uses the same fingertips", () => {
        const tips = (src: string) => /\[\s*4,\s*8,\s*12,\s*16,\s*20\s*\]/.test(src);
        expect(tips(read("../SparklesFilter.ts"))).toBe(true);
        expect(tips(readNative("SparklesFilter.tsx"))).toBe(true);
    });
});
