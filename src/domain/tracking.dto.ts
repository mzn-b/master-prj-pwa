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

    fps: number;
    avgFps: number;
    minFps: number;
    maxFps: number;


    inferenceTimeMs: number;
    avgInferenceTimeMs: number;
    frameProcessingTimeMs: number;
    avgFrameProcessingTimeMs: number;


    memoryUsageMB?: number;
    cpuUsagePercent?: number;
    gpuUsagePercent?: number;


    batteryLevel?: number;
    batteryCharging?: boolean;


    frameCount: number;
    droppedFrames: number;
    sessionDurationMs: number;
    warmupComplete: boolean;


    trackingConfidence?: number;
    trackingLostCount: number;
};
