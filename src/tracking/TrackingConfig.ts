export interface DeviceCapabilities {
    hasCamera: boolean;
    hasWebGL: boolean;
    hasWasm: boolean;
    hasSufficientMemory: boolean;
    isSecureContext: boolean;
    browserSupported: boolean;
    warnings: string[];
    errors: string[];
}

export async function checkDeviceCapabilities(): Promise<DeviceCapabilities> {
    const capabilities: DeviceCapabilities = {
        hasCamera: false,
        hasWebGL: false,
        hasWasm: false,
        hasSufficientMemory: true,
        isSecureContext: false,
        browserSupported: false,
        warnings: [],
        errors: [],
    };


    capabilities.isSecureContext = window.isSecureContext;
    if (!capabilities.isSecureContext && window.location.hostname !== "localhost") {
        capabilities.errors.push("HTTPS ist erforderlich für Kamerazugriff.");
    }


    if (await navigator.mediaDevices?.getUserMedia) {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            capabilities.hasCamera = devices.some(d => d.kind === "videoinput");
            if (!capabilities.hasCamera) {
                capabilities.errors.push("Keine Kamera gefunden.");
            }
        } catch {
            capabilities.warnings.push("Kamera-Erkennung fehlgeschlagen.");
        }
    } else {
        capabilities.errors.push("getUserMedia wird nicht unterstützt.");
    }


    try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
        capabilities.hasWebGL = gl !== null;
        if (!capabilities.hasWebGL) {
            capabilities.errors.push("WebGL wird nicht unterstützt.");
        }
    } catch {
        capabilities.errors.push("WebGL-Prüfung fehlgeschlagen.");
    }


    capabilities.hasWasm = typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
    if (!capabilities.hasWasm) {
        capabilities.errors.push("WebAssembly wird nicht unterstützt.");
    }


    const perfMemory = (performance as PerformanceWithMemory).memory;
    if (perfMemory) {
        const availableMB = (perfMemory.jsHeapSizeLimit - perfMemory.usedJSHeapSize) / (1024 * 1024);
        capabilities.hasSufficientMemory = availableMB > 100;
        if (!capabilities.hasSufficientMemory) {
            capabilities.warnings.push(`Wenig Speicher verfügbar (${Math.round(availableMB)}MB).`);
        }
    }


    const ua = navigator.userAgent.toLowerCase();
    const isChrome = ua.includes("chrome") && !ua.includes("edg");
    const isEdge = ua.includes("edg");
    const isFirefox = ua.includes("firefox");
    const isSafari = ua.includes("safari") && !ua.includes("chrome");

    capabilities.browserSupported = isChrome || isEdge || isFirefox || isSafari;
    if (!capabilities.browserSupported) {
        capabilities.warnings.push("Browser möglicherweise nicht vollständig unterstützt.");
    }

    if (isSafari) {
        capabilities.warnings.push("Safari: Eingeschränkte WebGL-Performance möglich.");
    }

    return capabilities;
}

export function canStartTracking(capabilities: DeviceCapabilities): boolean {
    return capabilities.errors.length === 0 &&
        capabilities.hasCamera &&
        capabilities.hasWebGL &&
        capabilities.hasWasm &&
        capabilities.isSecureContext;
}

export interface DynamicInferenceConfig {
    enabled: boolean;
    targetFps: number;
    minFrameSkip: number;
    maxFrameSkip: number;
    adjustmentInterval: number;
    fpsLowThreshold: number;
    fpsHighThreshold: number;
}

export const DEFAULT_DYNAMIC_INFERENCE_CONFIG: DynamicInferenceConfig = {
    enabled: false,
    targetFps: 60,
    minFrameSkip: 1,
    maxFrameSkip: 15,
    adjustmentInterval: 30,
    fpsLowThreshold: 20,
    fpsHighThreshold: 40,
};

export class DynamicInferenceController {
    private config: DynamicInferenceConfig;
    private currentFrameSkip: number;
    private framesSinceAdjustment: number = 0;
    private recentFps: number[] = [];

    constructor(config: DynamicInferenceConfig = DEFAULT_DYNAMIC_INFERENCE_CONFIG) {
        this.config = {...config};
        this.currentFrameSkip = 1;
    }

    setConfig(config: Partial<DynamicInferenceConfig>): void {
        this.config = {...this.config, ...config};
    }

    getCurrentFrameSkip(): number {
        return this.config.enabled ? this.currentFrameSkip : 1;
    }

    recordFps(fps: number): void {
        if (!this.config.enabled) return;

        this.recentFps.push(fps);
        if (this.recentFps.length > 10) {
            this.recentFps.shift();
        }

        this.framesSinceAdjustment++;

        if (this.framesSinceAdjustment >= this.config.adjustmentInterval) {
            this.adjustFrameSkip();
            this.framesSinceAdjustment = 0;
        }
    }

    private adjustFrameSkip(): void {
        if (this.recentFps.length < 3) return;

        const avgFps = this.recentFps.reduce((a, b) => a + b, 0) / this.recentFps.length;

        if (avgFps < this.config.fpsLowThreshold && this.currentFrameSkip < this.config.maxFrameSkip) {

            this.currentFrameSkip = Math.min(this.currentFrameSkip + 1, this.config.maxFrameSkip);
        } else if (avgFps > this.config.fpsHighThreshold && this.currentFrameSkip > this.config.minFrameSkip) {

            this.currentFrameSkip = Math.max(Math.floor(this.currentFrameSkip - 1), this.config.minFrameSkip);
        }
    }

    reset(): void {
        this.currentFrameSkip = 1;
        this.framesSinceAdjustment = 0;
        this.recentFps = [];
    }
}

interface PerformanceWithMemory extends Performance {
    memory?: {
        usedJSHeapSize: number;
        totalJSHeapSize: number;
        jsHeapSizeLimit: number;
    };
}
