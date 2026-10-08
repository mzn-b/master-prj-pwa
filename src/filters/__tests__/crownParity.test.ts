import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pwaCrown = fs.readFileSync(path.join(here, "../CrownFilter.ts"), "utf8");
const nativeCrown = path.resolve(
    here,
    "../../../../master-prj-native-2/src/render/filters/Crown3D.tsx",
);

/**
 * The crown is the one filter rendered by a 3D engine on both sides, and the two
 * implementations drifted: the PWA clipped the opposite half of the model, so it
 * showed the crown from behind while the native app showed its front. The apps
 * are rated against each other in the UX questionnaire, so a filter that looks
 * different is scored as a product difference rather than a platform one.
 *
 * These assertions pin the three things that have to agree. They read the native
 * source directly where it is available, so the pair cannot drift silently.
 */
describe("crown parity with the native filter", () => {
    it("clips the back half, with the normal pointing at the camera", () => {
        // three discards fragments where `normal · p + constant < 0`, so a +Z
        // normal keeps z >= 0 — the half facing the orthographic camera.
        expect(pwaCrown).toMatch(/new THREE\.Plane\(new THREE\.Vector3\(0,\s*0,\s*1\),\s*0\)/);
        expect(pwaCrown).not.toMatch(/Vector3\(0,\s*0,\s*-1\)/);
    });

    it("normalises the model to a centred unit box, as native does", () => {
        expect(pwaCrown).toMatch(/position\.sub\(box\.getCenter/);
        expect(pwaCrown).toMatch(/scale\.setScalar\(1 \/ \(Math\.max\(size\.x, size\.y, size\.z\)/);
    });

    it("rotates a pivot rather than the model itself", () => {
        // The model carries the centring offset, so rotating it directly would
        // swing the crown around an off-centre point.
        expect(pwaCrown).toMatch(/const pivot = new THREE\.Group\(\)/);
        expect(pwaCrown).toMatch(/pivot\.add\(model\)/);
    });

    /**
     * Size and lift, pinned numerically against the native source.
     *
     * The earlier assertions in this file passed throughout while the PWA crown
     * was drawn at 0.60x the face width and native at 1.12x — a 1.87x
     * difference, visible to any participant, on the one filter whose whole
     * purpose is to be compared across the two implementations. They checked
     * the clipping normal, the normalisation and the pivot, and simply never
     * looked at the scale.
     *
     * Both apps normalise the model to a unit box, so these multipliers are
     * directly comparable: the drawn width is the multiplier times the
     * temple-to-temple distance, and the lift is a fraction of that width.
     */
    it.skipIf(!fs.existsSync(nativeCrown))(
        "draws the crown at the same size as native, relative to the face",
        () => {
            const native = fs.readFileSync(nativeCrown, "utf8");
            const num = (src: string, name: string) =>
                Number(src.match(new RegExp(`${name}\\s*=\\s*([0-9.]+)`))?.[1]);

            expect(num(pwaCrown, "CROWN_WIDTH_RATIO")).toBe(num(native, "CROWN_WIDTH_RATIO"));
            expect(num(pwaCrown, "LIFT")).toBe(num(native, "LIFT"));
        },
    );

    it.skipIf(!fs.existsSync(nativeCrown))(
        "uses the same clipping normal as the native implementation",
        () => {
            const native = fs.readFileSync(nativeCrown, "utf8");
            const normalOf = (src: string) =>
                src.match(/new THREE\.Plane\(new THREE\.Vector3\(([^)]*)\)/)?.[1]?.replace(/\s/g, "");
            expect(normalOf(pwaCrown)).toBe(normalOf(native));
        },
    );
});
