import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { submitTrackingSession } from "../trackingApi";
import { APP_VERSION } from "../../config/buildInfo";
import type { PerformanceMetricsDTO } from "../../domain/tracking.dto";

/**
 * The web side of the data path: what a session sends to the backend, and that
 * a failed or refused submission is reported rather than lost silently. The
 * platform mapping itself is pinned in trackingApi.test.ts.
 */
const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const ANDROID_FULL =
    "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/AP2A.240905.003) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
// What Chrome actually sends since its user-agent reduction (thesis §6.3.2).
const ANDROID_REDUCED =
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36";
const MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const metrics = { frameCount: 900, avgInferenceTimeMs: 31.2 } as unknown as PerformanceMetricsDTO;
const fetchMock = vi.fn();

function asUserAgent(ua: string) {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
}

function sentRequest() {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return { url, init, body: JSON.parse(init.body as string) };
}

beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("submitTrackingSession", () => {
    it("posts the session as JSON to the tracking endpoint", async () => {
        asUserAgent(IPHONE);
        const response = { id: 7, sessionId: "pwa-1", platform: "IOS_PWA", recordedAt: "now", message: "ok" };
        fetchMock.mockResolvedValue({ ok: true, json: async () => response });

        const result = await submitTrackingSession("combined", metrics, ["crown", "glasses"]);

        expect(result).toEqual({ status: "ok", response });
        const { url, init, body } = sentRequest();
        expect(url.endsWith("/api/tracking/sessions")).toBe(true);
        expect(init.method).toBe("POST");
        expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
        expect(body).toMatchObject({
            platform: "IOS_PWA",
            mode: "COMBINED",
            metrics: { frameCount: 900, avgInferenceTimeMs: 31.2 },
            activeFilters: ["crown", "glasses"],
            deviceInfo: {
                deviceModel: "iPhone",
                osVersion: "iOS 18.7",
                appVersion: APP_VERSION,
                browserInfo: IPHONE,
            },
        });
        expect(body.sessionId).toMatch(/^pwa-\d+-[a-z0-9]+$/);
        expect(Number.isNaN(Date.parse(body.recordedAt))).toBe(false);
    });

    it("sends no filters when none were drawn", async () => {
        asUserAgent(IPHONE);
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
        await submitTrackingSession("face", metrics);
        expect(sentRequest().body.activeFilters).toEqual([]);
    });

    it("reads model and version from a full Android user-agent string", async () => {
        asUserAgent(ANDROID_FULL);
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
        await submitTrackingSession("combined", metrics);
        expect(sentRequest().body).toMatchObject({
            platform: "ANDROID_PWA",
            deviceInfo: { deviceModel: "Pixel 7", osVersion: "Android 14" },
        });
    });

    it("records what Chrome's reduced user-agent string reveals, and no more", async () => {
        asUserAgent(ANDROID_REDUCED);
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
        await submitTrackingSession("combined", metrics);
        expect(sentRequest().body).toMatchObject({
            platform: "ANDROID_PWA",
            deviceInfo: { deviceModel: "Android Device", osVersion: "Android 10", browserInfo: ANDROID_REDUCED },
        });
    });

    it("sends nothing from a desktop browser and says so", async () => {
        asUserAgent(MAC);
        const result = await submitTrackingSession("combined", metrics);
        expect(result.status).toBe("skipped");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reports a rejected submission with the server's status", async () => {
        asUserAgent(IPHONE);
        fetchMock.mockResolvedValue({ ok: false, status: 400, statusText: "Bad Request" });
        const result = await submitTrackingSession("combined", metrics);
        expect(result).toEqual({ status: "error", reason: "400 Bad Request" });
    });

    it("reports a network failure", async () => {
        asUserAgent(IPHONE);
        fetchMock.mockRejectedValue(new Error("Failed to fetch"));
        const result = await submitTrackingSession("combined", metrics);
        expect(result).toEqual({ status: "error", reason: "Failed to fetch" });
    });
});
