import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("checkDeviceCapabilities on a phone", () => {
    const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
    const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";

    function phone({
        devices = [{ kind: "videoinput" }] as Array<{ kind: string }> | Error,
        userAgent = ANDROID_CHROME,
        mediaDevices = true,
    } = {}) {
        vi.stubGlobal("navigator", {
            userAgent,
            mediaDevices: mediaDevices
                ? {
                    getUserMedia: () => {},
                    enumerateDevices: async () => {
                        if (devices instanceof Error) throw devices;
                        return devices;
                    },
                }
                : undefined,
        });
    }

    beforeEach(() => {
        Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
            ((type: string) => (type === "webgl2" ? {} : null)) as never,
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        delete (window as { isSecureContext?: boolean }).isSecureContext;
        delete (performance as { memory?: unknown }).memory;
    });

    it("lets a phone with a camera, WebGL and WebAssembly start, without warnings", async () => {
        phone();
        const caps = await checkDeviceCapabilities();
        expect(caps.errors).toEqual([]);
        expect(caps.warnings).toEqual([]);
        expect(canStartTracking(caps)).toBe(true);
    });

    it("refuses without a camera or without getUserMedia", async () => {
        phone({ devices: [{ kind: "audioinput" }] });
        expect((await checkDeviceCapabilities()).errors).toEqual(["Keine Kamera gefunden."]);
        phone({ mediaDevices: false });
        expect((await checkDeviceCapabilities()).errors).toEqual(["getUserMedia wird nicht unterstützt."]);
    });

    it("warns, rather than refusing, when the camera list cannot be read", async () => {
        phone({ devices: new Error("NotAllowedError") });
        const caps = await checkDeviceCapabilities();
        expect(caps.warnings).toEqual(["Kamera-Erkennung fehlgeschlagen."]);
        expect(caps.errors).not.toContain("Keine Kamera gefunden.");
    });

    it("refuses without WebGL, also when probing it throws", async () => {
        phone();
        vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
        expect((await checkDeviceCapabilities()).errors).toEqual(["WebGL wird nicht unterstützt."]);
        vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(() => {
            throw new Error("context lost");
        });
        expect((await checkDeviceCapabilities()).errors).toEqual(["WebGL-Prüfung fehlgeschlagen."]);
    });

    it("refuses without WebAssembly", async () => {
        phone();
        vi.stubGlobal("WebAssembly", undefined);
        expect((await checkDeviceCapabilities()).errors).toEqual(["WebAssembly wird nicht unterstützt."]);
    });

    it("refuses an insecure page served from anywhere but localhost", async () => {
        phone();
        Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
        // jsdom serves the page from localhost, which browsers exempt.
        expect((await checkDeviceCapabilities()).errors).toEqual([]);
        vi.stubGlobal("location", { hostname: "192.168.0.10" });
        expect((await checkDeviceCapabilities()).errors).toEqual(["HTTPS ist erforderlich für Kamerazugriff."]);
    });

    it("warns about little free heap where the browser reports it", async () => {
        phone();
        Object.defineProperty(performance, "memory", {
            value: { jsHeapSizeLimit: 150 * 1024 * 1024, usedJSHeapSize: 100 * 1024 * 1024 },
            configurable: true,
        });
        const caps = await checkDeviceCapabilities();
        expect(caps.hasSufficientMemory).toBe(false);
        expect(caps.warnings).toEqual(["Wenig Speicher verfügbar (50MB)."]);
        expect(canStartTracking(caps)).toBe(true);
    });

    it("warns on Safari and on browsers it does not know", async () => {
        phone({ userAgent: IPHONE_SAFARI });
        expect((await checkDeviceCapabilities()).warnings).toEqual(["Safari: Eingeschränkte WebGL-Performance möglich."]);
        phone({ userAgent: "SomeBrowser/1.0" });
        expect((await checkDeviceCapabilities()).warnings).toEqual(["Browser möglicherweise nicht vollständig unterstützt."]);
    });
});
