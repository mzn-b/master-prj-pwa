import type { PerformanceMetricsDTO, TrackingMode } from "../domain/tracking.dto";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";

export type Platform = "IOS_PWA" | "ANDROID_PWA" | "IOS_NATIVE" | "ANDROID_NATIVE";

export interface DeviceInfo {
    deviceModel: string;
    osVersion: string;
    appVersion: string;
    screenWidth?: number;
    screenHeight?: number;
    browserInfo?: string;
}

export interface TrackingSessionRequest {
    platform: Platform;
    deviceInfo: DeviceInfo;
    sessionId: string;
    mode: TrackingMode;
    metrics: PerformanceMetricsDTO;
    recordedAt?: string;
    activeFilters?: string[];
}

export interface TrackingSessionResponse {
    id: number;
    sessionId: string;
    platform: Platform;
    recordedAt: string;
    message: string;
}

/** Outcome of a submission attempt. `skipped` is a deliberate no-send, not a failure. */
export type SubmitResult =
    | { status: "ok"; response: TrackingSessionResponse }
    | { status: "skipped"; reason: string }
    | { status: "error"; reason: string };

/**
 * The backend's Platform enum has exactly four values, all of them mobile.
 * A desktop browser is none of them.
 *
 * This used to return ANDROID_PWA for "not iOS", so every session run on a
 * laptop — during development, or while checking the UI — was stored as an
 * Android session and silently contaminated the platform comparison. Android is
 * now matched explicitly and anything else yields `null`, which stops the
 * submission rather than mislabelling it.
 */
export function detectPlatform(userAgent: string = navigator.userAgent): Platform | null {
    if (/iPhone|iPad|iPod/i.test(userAgent)) return "IOS_PWA";
    // iPadOS 13+ presents a desktop Safari UA; touch points are what give it away.
    if (/Macintosh/i.test(userAgent) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1) {
        return "IOS_PWA";
    }
    if (/Android/i.test(userAgent)) return "ANDROID_PWA";
    return null;
}

function getDeviceInfo(): DeviceInfo {
    const userAgent = navigator.userAgent;

    // Extract OS version
    let osVersion = "Unknown";
    const iosMatch = userAgent.match(/OS (\d+[._]\d+[._]?\d*)/);
    const androidMatch = userAgent.match(/Android (\d+\.?\d*\.?\d*)/);
    if (iosMatch) {
        osVersion = `iOS ${iosMatch[1].replace(/_/g, ".")}`;
    } else if (androidMatch) {
        osVersion = `Android ${androidMatch[1]}`;
    } else if (userAgent.includes("Mac OS X")) {
        const macMatch = userAgent.match(/Mac OS X (\d+[._]\d+[._]?\d*)/);
        osVersion = macMatch ? `macOS ${macMatch[1].replace(/_/g, ".")}` : "macOS";
    } else if (userAgent.includes("Windows")) {
        osVersion = "Windows";
    } else if (userAgent.includes("Linux")) {
        osVersion = "Linux";
    }

    // Extract device model (simplified)
    let deviceModel: string;
    if (/iphone/i.test(userAgent)) {
        deviceModel = "iPhone";
    } else if (/ipad/i.test(userAgent)) {
        deviceModel = "iPad";
    } else if (/android/i.test(userAgent)) {
        // Try to extract device model from Android UA
        const modelMatch = userAgent.match(/;\s*([^;)]+)\s*Build/);
        deviceModel = modelMatch ? modelMatch[1].trim() : "Android Device";
    } else {
        deviceModel = "Desktop Browser";
    }

    return {
        deviceModel,
        osVersion,
        appVersion: "1.0.0",
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        browserInfo: userAgent,
    };
}

function generateSessionId(): string {
    return `pwa-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export async function submitTrackingSession(
    mode: TrackingMode,
    metrics: PerformanceMetricsDTO,
    activeFilters: string[] = []
): Promise<SubmitResult> {
    const platform = detectPlatform();
    if (platform === null) {
        const reason = "Kein mobiles Gerät — Messung wird nicht übertragen.";
        console.warn(`[trackingApi] ${reason} (${navigator.userAgent})`);
        return { status: "skipped", reason };
    }

    const request: TrackingSessionRequest = {
        platform,
        deviceInfo: getDeviceInfo(),
        sessionId: generateSessionId(),
        mode: mode.toUpperCase() as TrackingMode,
        metrics,
        recordedAt: new Date().toISOString(),
        activeFilters,
    };

    try {
        const response = await fetch(`${API_BASE_URL}/api/tracking/sessions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(request),
        });

        if (!response.ok) {
            const reason = `${response.status} ${response.statusText}`;
            console.error("Failed to submit tracking session:", reason);
            return { status: "error", reason };
        }

        return { status: "ok", response: await response.json() };
    } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown error";
        console.error("Error submitting tracking session:", error);
        return { status: "error", reason };
    }
}
