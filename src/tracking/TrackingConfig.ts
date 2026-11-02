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


    // `?? false`: the property is absent in some embedded webviews and in
    // jsdom, and an undefined here would flow into a field the DeviceCapabilities
    // interface declares as boolean.
    capabilities.isSecureContext = window.isSecureContext ?? false;
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

interface PerformanceWithMemory extends Performance {
    memory?: {
        usedJSHeapSize: number;
        totalJSHeapSize: number;
        jsHeapSizeLimit: number;
    };
}
