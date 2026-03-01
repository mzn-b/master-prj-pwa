export type TrackingMode = "face" | "hand" | "combined";

export type NormalizedPoint = {
    x: number;
    y: number;
    z?: number;
};

export type FaceLandmarksDTO = {
    faces: Array<{
        landmarks: NormalizedPoint[];
    }>;
};

export type HandLandmarksDTO = {
    hands: Array<{
        handedness?: "Left" | "Right" | "Unknown";
        landmarks: NormalizedPoint[];
    }>;
};

export type TrackingDTO = {
    timestampMs: number;
    mode: TrackingMode;
    face?: FaceLandmarksDTO;
    hand?: HandLandmarksDTO;
};


export type PerformanceMetricsDTO = {
    // Frame timing metrics
    fps: number;
    avgFps: number;
    minFps: number | null;
    maxFps: number | null;
    inferenceTimeMs: number;
    avgInferenceTimeMs: number;
    frameProcessingTimeMs: number;
    avgFrameProcessingTimeMs: number;

    // Memory metrics
    memoryUsageMB?: number;
    totalMemoryMB?: number;
    availableMemoryMB?: number;
    heapLimitMB?: number;

    // CPU metrics
    cpuUsagePercent?: number;
    cpuCores?: number;
    threadCount?: number;

    // GPU metrics
    gpuUsagePercent?: number;
    gpuVendor?: string;
    gpuRenderer?: string;

    // Thermal metrics
    thermalState?: string;

    // Power metrics
    batteryLevel?: number;
    batteryCharging?: boolean;

    // Network metrics
    networkType?: string;
    networkDownlinkMbps?: number;
    networkRttMs?: number;

    // Detection metrics
    facesDetectedAvg?: number;
    handsDetectedAvg?: number;
    detectionRate?: number;

    // Model metrics
    modelLoadTimeMs?: number;

    // Session metrics
    frameCount: number;
    droppedFrames: number;
    sessionDurationMs: number;
    warmupComplete: boolean;
    trackingConfidence?: number;
    trackingLostCount: number;

    // Stability metrics
    peakMemoryUsageMB?: number;
    gpuDelegateActive?: boolean;
    trackingRecoveryTimeMs?: number;
    consecutiveTrackingLossMax?: number;
    errorCount?: number;
};
