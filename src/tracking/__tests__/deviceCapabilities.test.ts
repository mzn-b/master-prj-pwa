import { describe, expect, it } from "vitest";
import {
    canStartTracking,
    checkDeviceCapabilities,
    type DeviceCapabilities,
} from "../TrackingConfig";

/**
 * F10 — the pre-start capability check.
 *
 * The native app has an equivalent test (`deviceCapabilities.test.ts`); this is
 * the PWA's counterpart. The two checks look for different things by design —
 * the browser needs a secure context, WebGL and WASM, while the device needs a
 * camera and enough memory — but both must refuse to start when the platform
 * cannot support tracking, rather than failing halfway into a session.
 */
function capabilities(overrides: Partial<DeviceCapabilities> = {}): DeviceCapabilities {
    return {
        hasCamera: true,
        hasWebGL: true,
        hasWasm: true,
        hasSufficientMemory: true,
        isSecureContext: true,
        browserSupported: true,
        warnings: [],
        errors: [],
        ...overrides,
    };
}

describe("canStartTracking", () => {
    it("allows a start when every prerequisite is met", () => {
        expect(canStartTracking(capabilities())).toBe(true);
    });

    it.each([
        ["no camera", { hasCamera: false }],
        ["no WebGL", { hasWebGL: false }],
        ["no WebAssembly", { hasWasm: false }],
        ["an insecure context", { isSecureContext: false }],
    ])("refuses to start with %s", (_label, override) => {
        expect(canStartTracking(capabilities(override))).toBe(false);
    });

    it("refuses to start when any error was recorded, even if the flags look fine", () => {
        // The flags and the error list are independent: a check can set an error
        // without clearing the flag it relates to, and the error must still win.
        expect(canStartTracking(capabilities({ errors: ["HTTPS ist erforderlich"] }))).toBe(false);
    });

    it("starts despite warnings — they inform, they do not block", () => {
        const withWarning = capabilities({
            warnings: ["Safari: Eingeschränkte WebGL-Performance möglich."],
        });
        expect(canStartTracking(withWarning)).toBe(true);
    });

    it("is not blocked by low memory alone", () => {
        // hasSufficientMemory feeds a warning rather than a hard stop: the
        // heap-limit reading is a rough heuristic and is absent entirely in
        // Safari, so refusing to start on it would block a whole arm.
        expect(canStartTracking(capabilities({ hasSufficientMemory: false }))).toBe(true);
    });
});

describe("checkDeviceCapabilities", () => {
    it("reports a secure context and never throws in a bare environment", async () => {
        // jsdom has no camera, no WebGL and no real secure context. The point is
        // that the probe degrades to a populated result rather than rejecting —
        // the screen calls this before it can show any error UI of its own.
        const caps = await checkDeviceCapabilities();
        expect(caps).toMatchObject({
            hasCamera: expect.any(Boolean),
            hasWebGL: expect.any(Boolean),
            hasWasm: expect.any(Boolean),
            isSecureContext: expect.any(Boolean),
        });
        expect(Array.isArray(caps.errors)).toBe(true);
        expect(Array.isArray(caps.warnings)).toBe(true);
    });

    it("detects WebAssembly, which jsdom does provide", async () => {
        const caps = await checkDeviceCapabilities();
        expect(caps.hasWasm).toBe(true);
    });

    it("cannot start in jsdom, and says why rather than failing silently", async () => {
        const caps = await checkDeviceCapabilities();
        expect(canStartTracking(caps)).toBe(false);
        // Something must explain the refusal — a blocked start with an empty
        // errors array would leave the user looking at a dead button.
        expect(caps.errors.length + caps.warnings.length).toBeGreaterThan(0);
    });
});
