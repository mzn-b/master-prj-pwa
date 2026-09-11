import { describe, it, expect } from "vitest";
import { detectPlatform } from "../trackingApi";

const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1";
const ANDROID =
    "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/AP2A.240905.003) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const MAC_CHROME =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const WINDOWS =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

describe("detectPlatform", () => {
    it("recognises iPhone as IOS_PWA", () => {
        expect(detectPlatform(IPHONE)).toBe("IOS_PWA");
    });

    it("recognises Android as ANDROID_PWA", () => {
        expect(detectPlatform(ANDROID)).toBe("ANDROID_PWA");
    });

    // Regression: this used to be "not iOS => ANDROID_PWA", so every desktop
    // session was stored as an Android session. See docs/pwa-followups.md #3.
    it("does not label a desktop Mac as Android", () => {
        expect(detectPlatform(MAC_CHROME)).not.toBe("ANDROID_PWA");
    });

    it("returns null for a desktop Mac, which the backend enum cannot express", () => {
        expect(detectPlatform(MAC_CHROME)).toBeNull();
    });

    it("returns null for Windows", () => {
        expect(detectPlatform(WINDOWS)).toBeNull();
    });

    it("only ever returns a PWA platform value", () => {
        for (const ua of [IPHONE, ANDROID, MAC_CHROME, WINDOWS]) {
            const p = detectPlatform(ua);
            expect(p === null || p === "IOS_PWA" || p === "ANDROID_PWA").toBe(true);
        }
    });
});
