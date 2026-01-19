import type { PerformanceMetricsDTO } from "../domain/tracking.dto";

const WARMUP_FRAMES = 30;
const FPS_SAMPLE_SIZE = 60;

export class PerformanceTracker {
    private startTime: number = 0;
    private frameCount: number = 0;
    private droppedFrames: number = 0;
    private trackingLostCount: number = 0;

    private lastFrameTime: number = 0;
    private frameTimes: number[] = [];
    private inferenceTimes: number[] = [];
    private frameProcessingTimes: number[] = [];

    private minFps: number = Infinity;
    private maxFps: number = 0;

    private warmupComplete: boolean = false;
    private lastTrackingValid: boolean = false;

    private batteryManager: BatteryManager | null = null;

    constructor() {
        this.initBattery();
    }

    private async initBattery(): Promise<void> {
        try {
            if ("getBattery" in navigator) {
                this.batteryManager = await (navigator as NavigatorWithBattery).getBattery();
            }
        } catch { /* empty */ }
    }

    start(): void {
        this.startTime = performance.now();
        this.frameCount = 0;
        this.droppedFrames = 0;
        this.trackingLostCount = 0;
        this.lastFrameTime = this.startTime;
        this.frameTimes = [];
        this.inferenceTimes = [];
        this.frameProcessingTimes = [];
        this.minFps = Infinity;
        this.maxFps = 0;
        this.warmupComplete = false;
        this.lastTrackingValid = false;
    }

    stop(): void {

    }

    recordFrameStart(): number {
        return performance.now();
    }

    recordInferenceTime(startTime: number): number {
        const inferenceTime = performance.now() - startTime;
        this.inferenceTimes.push(inferenceTime);
        if (this.inferenceTimes.length > FPS_SAMPLE_SIZE) {
            this.inferenceTimes.shift();
        }
        return inferenceTime;
    }

    recordFrameEnd(frameStartTime: number, trackingValid: boolean): void {
        const now = performance.now();
        const frameProcessingTime = now - frameStartTime;

        this.frameCount++;
        this.frameProcessingTimes.push(frameProcessingTime);
        if (this.frameProcessingTimes.length > FPS_SAMPLE_SIZE) {
            this.frameProcessingTimes.shift();
        }


        const frameTime = now - this.lastFrameTime;
        this.lastFrameTime = now;

        if (frameTime > 0) {
            this.frameTimes.push(frameTime);
            if (this.frameTimes.length > FPS_SAMPLE_SIZE) {
                this.frameTimes.shift();
            }


            if (this.warmupComplete) {
                const currentFps = 1000 / frameTime;
                if (currentFps < this.minFps) this.minFps = currentFps;
                if (currentFps > this.maxFps) this.maxFps = currentFps;
            }
        }


        if (this.lastTrackingValid && !trackingValid) {
            this.trackingLostCount++;
        }
        this.lastTrackingValid = trackingValid;


        if (!this.warmupComplete && this.frameCount >= WARMUP_FRAMES) {
            this.warmupComplete = true;

            this.minFps = Infinity;
            this.maxFps = 0;
        }
    }
    getMetrics(): PerformanceMetricsDTO {
        const now = performance.now();
        const sessionDuration = now - this.startTime;


        const avgFrameTime = this.frameTimes.length > 0
            ? this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length
            : 0;
        const fps = avgFrameTime > 0 ? 1000 / avgFrameTime : 0;


        const avgFps = sessionDuration > 0 ? (this.frameCount * 1000) / sessionDuration : 0;


        const avgInferenceTime = this.inferenceTimes.length > 0
            ? this.inferenceTimes.reduce((a, b) => a + b, 0) / this.inferenceTimes.length
            : 0;
        const currentInferenceTime = this.inferenceTimes.length > 0
            ? this.inferenceTimes[this.inferenceTimes.length - 1]
            : 0;


        const avgFrameProcessingTime = this.frameProcessingTimes.length > 0
            ? this.frameProcessingTimes.reduce((a, b) => a + b, 0) / this.frameProcessingTimes.length
            : 0;
        const currentFrameProcessingTime = this.frameProcessingTimes.length > 0
            ? this.frameProcessingTimes[this.frameProcessingTimes.length - 1]
            : 0;


        let memoryUsageMB: number | undefined;
        const perfMemory = (performance as PerformanceWithMemory).memory;
        if (perfMemory) {
            memoryUsageMB = perfMemory.usedJSHeapSize / (1024 * 1024);
        }


        let batteryLevel: number | undefined;
        let batteryCharging: boolean | undefined;
        if (this.batteryManager) {
            batteryLevel = this.batteryManager.level;
            batteryCharging = this.batteryManager.charging;
        }

        return {
            fps: Math.round(fps * 10) / 10,
            avgFps: Math.round(avgFps * 10) / 10,
            minFps: this.minFps === Infinity ? 0 : Math.round(this.minFps * 10) / 10,
            maxFps: Math.round(this.maxFps * 10) / 10,
            inferenceTimeMs: Math.round(currentInferenceTime * 100) / 100,
            avgInferenceTimeMs: Math.round(avgInferenceTime * 100) / 100,
            frameProcessingTimeMs: Math.round(currentFrameProcessingTime * 100) / 100,
            avgFrameProcessingTimeMs: Math.round(avgFrameProcessingTime * 100) / 100,
            memoryUsageMB: memoryUsageMB ? Math.round(memoryUsageMB * 10) / 10 : undefined,
            cpuUsagePercent: undefined,
            gpuUsagePercent: undefined,
            batteryLevel,
            batteryCharging,
            frameCount: this.frameCount,
            droppedFrames: this.droppedFrames,
            sessionDurationMs: Math.round(sessionDuration),
            warmupComplete: this.warmupComplete,
            trackingConfidence: undefined,
            trackingLostCount: this.trackingLostCount,
        };
    }
}


interface BatteryManager {
    level: number;
    charging: boolean;
    addEventListener(type: string, listener: () => void): void;
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
