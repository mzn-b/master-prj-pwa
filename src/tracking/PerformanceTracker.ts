/**
 * PerformanceTracker - Efficient circular buffer implementation
 * Collects FPS, inference time, and hardware metrics
 * Uses O(1) circular buffers instead of O(n) array.shift()
 */

import type { PerformanceMetricsDTO } from "../domain/tracking.dto";

const WARMUP_FRAMES = 30;
const BUFFER_SIZE = 60;

/** O(1) circular buffer for time series data */
class CircularBuffer {
    private buffer: Float64Array;
    private index = 0;
    private count = 0;
    private sum = 0;

    constructor(size: number) {
        this.buffer = new Float64Array(size);
    }

    push(value: number): void {
        if (this.count === this.buffer.length) {
            this.sum -= this.buffer[this.index];
        } else {
            this.count++;
        }
        this.buffer[this.index] = value;
        this.sum += value;
        this.index = (this.index + 1) % this.buffer.length;
    }

    average(): number {
        return this.count > 0 ? this.sum / this.count : 0;
    }

    last(): number {
        if (this.count === 0) return 0;
        const idx = (this.index - 1 + this.buffer.length) % this.buffer.length;
        return this.buffer[idx];
    }

    reset(): void {
        this.buffer.fill(0);
        this.index = 0;
        this.count = 0;
        this.sum = 0;
    }
}

export class PerformanceTracker {
    private startTime = 0;
    private frameCount = 0;
    private droppedFrames = 0;
    private trackingLostCount = 0;
    private lastFrameTime = 0;
    private warmupComplete = false;
    private lastTrackingValid = false;

    private frameTimes = new CircularBuffer(BUFFER_SIZE);
    private inferenceTimes = new CircularBuffer(BUFFER_SIZE);
    private processingTimes = new CircularBuffer(BUFFER_SIZE);

    private minFps = Infinity;
    private maxFps = 0;

    // Detection tracking
    private totalFacesDetected = 0;
    private totalHandsDetected = 0;
    private detectionFrameCount = 0;

    // Stability tracking
    private peakMemoryUsageMB = 0;
    private errorCount = 0;
    private trackingLostTime = 0;
    private totalRecoveryTimeMs = 0;
    private recoveryCount = 0;
    private currentConsecutiveLoss = 0;
    private consecutiveTrackingLossMax = 0;

    // Model load time (set externally)
    private modelLoadTimeMs: number | undefined;

    // Cached hardware info
    private batteryManager: BatteryManager | null = null;
    private cpuCores: number | undefined;
    private gpuVendor: string | undefined;
    private gpuRenderer: string | undefined;

    constructor() {
        this.initBattery();
        this.initHardwareInfo();
    }

    private async initBattery(): Promise<void> {
        try {
            if ("getBattery" in navigator) {
                this.batteryManager = await (navigator as NavigatorWithBattery).getBattery();
            }
        } catch { /* Battery API not available */ }
    }

    private initHardwareInfo(): void {
        this.cpuCores = navigator.hardwareConcurrency;

        try {
            const canvas = document.createElement("canvas");
            const gl = canvas.getContext("webgl");
            if (gl) {
                const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
                if (debugInfo) {
                    this.gpuVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) as string;
                    this.gpuRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string;
                }
                const ext = gl.getExtension("WEBGL_lose_context");
                ext?.loseContext();
            }
        } catch { /* WebGL not available */ }
    }

    start(): void {
        this.startTime = performance.now();
        this.lastFrameTime = this.startTime;
        this.frameCount = 0;
        this.droppedFrames = 0;
        this.trackingLostCount = 0;
        this.warmupComplete = false;
        this.lastTrackingValid = false;
        this.minFps = Infinity;
        this.maxFps = 0;
        this.frameTimes.reset();
        this.inferenceTimes.reset();
        this.processingTimes.reset();
        // Reset new metrics
        this.totalFacesDetected = 0;
        this.totalHandsDetected = 0;
        this.detectionFrameCount = 0;
        this.peakMemoryUsageMB = 0;
        this.errorCount = 0;
        this.trackingLostTime = 0;
        this.totalRecoveryTimeMs = 0;
        this.recoveryCount = 0;
        this.currentConsecutiveLoss = 0;
        this.consecutiveTrackingLossMax = 0;
    }

    setModelLoadTime(timeMs: number): void {
        this.modelLoadTimeMs = timeMs;
    }

    recordError(): void {
        this.errorCount++;
    }

    recordDetection(facesCount: number, handsCount: number): void {
        this.totalFacesDetected += facesCount;
        this.totalHandsDetected += handsCount;
        this.detectionFrameCount++;
    }

    recordFrameStart(): number {
        return performance.now();
    }

    recordInferenceTime(startTime: number): void {
        this.inferenceTimes.push(performance.now() - startTime);
    }

    recordFrameEnd(frameStart: number, hasTracking: boolean): void {
        const now = performance.now();
        this.processingTimes.push(now - frameStart);
        this.frameCount++;

        const frameTime = now - this.lastFrameTime;
        this.lastFrameTime = now;

        if (frameTime > 0) {
            this.frameTimes.push(frameTime);

            if (this.warmupComplete) {
                const fps = 1000 / frameTime;
                if (fps < this.minFps) this.minFps = fps;
                if (fps > this.maxFps) this.maxFps = fps;
            }
        }

        // Track tracking loss events and recovery time
        if (this.lastTrackingValid && !hasTracking) {
            this.trackingLostCount++;
            this.trackingLostTime = now;
            this.currentConsecutiveLoss = 1;
        } else if (!this.lastTrackingValid && hasTracking && this.trackingLostTime > 0) {
            // Recovered from tracking loss
            const recoveryTime = now - this.trackingLostTime;
            this.totalRecoveryTimeMs += recoveryTime;
            this.recoveryCount++;
            this.trackingLostTime = 0;
            this.currentConsecutiveLoss = 0;
        } else if (!hasTracking && !this.lastTrackingValid) {
            // Still lost - increment consecutive loss
            this.currentConsecutiveLoss++;
            if (this.currentConsecutiveLoss > this.consecutiveTrackingLossMax) {
                this.consecutiveTrackingLossMax = this.currentConsecutiveLoss;
            }
        }
        this.lastTrackingValid = hasTracking;

        // Complete warmup
        if (!this.warmupComplete && this.frameCount >= WARMUP_FRAMES) {
            this.warmupComplete = true;
            this.minFps = Infinity;
            this.maxFps = 0;
        }
    }

    getMetrics(): PerformanceMetricsDTO {
        const now = performance.now();
        const sessionDuration = now - this.startTime;
        const avgFrameTime = this.frameTimes.average();
        const fps = avgFrameTime > 0 ? 1000 / avgFrameTime : 0;
        const avgFps = sessionDuration > 0 ? (this.frameCount * 1000) / sessionDuration : 0;

        // Memory metrics (Chrome/Edge only)
        const perfMemory = (performance as PerformanceWithMemory).memory;
        const memoryUsageMB = perfMemory ? perfMemory.usedJSHeapSize / (1024 * 1024) : undefined;
        const totalMemoryMB = perfMemory ? perfMemory.totalJSHeapSize / (1024 * 1024) : undefined;
        const heapLimitMB = perfMemory ? perfMemory.jsHeapSizeLimit / (1024 * 1024) : undefined;

        // Network metrics
        const connection = (navigator as NavigatorWithConnection).connection;

        // Track peak memory
        if (memoryUsageMB && memoryUsageMB > this.peakMemoryUsageMB) {
            this.peakMemoryUsageMB = memoryUsageMB;
        }

        // Calculate detection averages
        const facesDetectedAvg = this.detectionFrameCount > 0
            ? Math.round((this.totalFacesDetected / this.detectionFrameCount) * 100) / 100
            : undefined;
        const handsDetectedAvg = this.detectionFrameCount > 0
            ? Math.round((this.totalHandsDetected / this.detectionFrameCount) * 100) / 100
            : undefined;
        const detectionRate = sessionDuration > 0
            ? Math.round((this.detectionFrameCount * 1000 / sessionDuration) * 10) / 10
            : undefined;

        // Calculate average recovery time
        const trackingRecoveryTimeMs = this.recoveryCount > 0
            ? Math.round(this.totalRecoveryTimeMs / this.recoveryCount)
            : undefined;

        return {
            fps: Math.round(fps * 10) / 10,
            avgFps: Math.round(avgFps * 10) / 10,
            minFps: this.minFps === Infinity ? null : Math.round(this.minFps * 10) / 10,
            maxFps: this.maxFps === 0 ? null : Math.round(this.maxFps * 10) / 10,
            inferenceTimeMs: Math.round(this.inferenceTimes.last() * 100) / 100,
            avgInferenceTimeMs: Math.round(this.inferenceTimes.average() * 100) / 100,
            frameProcessingTimeMs: Math.round(this.processingTimes.last() * 100) / 100,
            avgFrameProcessingTimeMs: Math.round(this.processingTimes.average() * 100) / 100,
            memoryUsageMB: memoryUsageMB ? Math.round(memoryUsageMB * 10) / 10 : undefined,
            totalMemoryMB: totalMemoryMB ? Math.round(totalMemoryMB * 10) / 10 : undefined,
            heapLimitMB: heapLimitMB ? Math.round(heapLimitMB * 10) / 10 : undefined,
            cpuCores: this.cpuCores,
            gpuVendor: this.gpuVendor,
            gpuRenderer: this.gpuRenderer,
            batteryLevel: this.batteryManager?.level,
            batteryCharging: this.batteryManager?.charging,
            networkType: connection?.effectiveType,
            networkDownlinkMbps: connection?.downlink,
            networkRttMs: connection?.rtt,
            // Detection metrics
            facesDetectedAvg,
            handsDetectedAvg,
            detectionRate,
            // Model metrics
            modelLoadTimeMs: this.modelLoadTimeMs,
            // Session metrics
            frameCount: this.frameCount,
            droppedFrames: this.droppedFrames,
            sessionDurationMs: Math.round(sessionDuration),
            warmupComplete: this.warmupComplete,
            trackingLostCount: this.trackingLostCount,
            // Stability metrics
            peakMemoryUsageMB: this.peakMemoryUsageMB > 0 ? Math.round(this.peakMemoryUsageMB * 10) / 10 : undefined,
            gpuDelegateActive: undefined, // Not applicable for PWA (WebGL is always used)
            trackingRecoveryTimeMs,
            consecutiveTrackingLossMax: this.consecutiveTrackingLossMax > 0 ? this.consecutiveTrackingLossMax : undefined,
            errorCount: this.errorCount > 0 ? this.errorCount : undefined,
        };
    }
}

interface BatteryManager {
    level: number;
    charging: boolean;
}

interface NavigatorWithBattery extends Navigator {
    getBattery(): Promise<BatteryManager>;
}

interface PerformanceWithMemory extends Performance {
    memory?: {
        usedJSHeapSize: number;
        totalJSHeapSize: number;
        jsHeapSizeLimit: number;
    };
}

interface NavigatorWithConnection extends Navigator {
    connection?: {
        effectiveType?: string;
        downlink?: number;
        rtt?: number;
    };
}
