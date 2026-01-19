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
}

export interface TrackingSessionResponse {
    id: number;
    sessionId: string;
    platform: Platform;
    recordedAt: string;
    message: string;
}

function getPlatform(): Platform {
    const userAgent = navigator.userAgent.toLowerCase();
    const isIOS = /iphone|ipad|ipod/.test(userAgent);
    return isIOS ? "IOS_PWA" : "ANDROID_PWA";
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
    let deviceModel = "Unknown";
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
    metrics: PerformanceMetricsDTO
): Promise<TrackingSessionResponse | null> {
    const request: TrackingSessionRequest = {
        platform: getPlatform(),
        deviceInfo: getDeviceInfo(),
        sessionId: generateSessionId(),
        mode: mode.toUpperCase() as TrackingMode,
        metrics,
        recordedAt: new Date().toISOString(),
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
            console.error("Failed to submit tracking session:", response.status, response.statusText);
            return null;
        }

        return await response.json();
    } catch (error) {
        console.error("Error submitting tracking session:", error);
        return null;
    }
}
