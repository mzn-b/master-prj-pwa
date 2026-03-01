/**
 * useTracking - MediaPipe tracking hook with frame loop
 * Manages inference, smoothing, and dynamic frame skipping
 */

import { useRef, useCallback, useState, useEffect } from "react";
import type { TrackingDTO, TrackingMode, PerformanceMetricsDTO } from "../domain/tracking.dto";
import { TrackingController } from "../tracking/TrackingController";
import { LandmarkSmoother, DEFAULT_SMOOTHING_CONFIG } from "../tracking/LandmarkSmoother";
import { DynamicInferenceController, DEFAULT_DYNAMIC_INFERENCE_CONFIG } from "../tracking/TrackingConfig";
import { PerformanceTracker } from "../tracking/PerformanceTracker";

export interface UseTrackingOptions {
    mode: TrackingMode;
    smoothingEnabled: boolean;
    dynamicInferenceEnabled: boolean;
    onFrame?: (dto: TrackingDTO, width: number, height: number) => void;
}

export interface UseTrackingResult {
    isRunning: boolean;
    metrics: PerformanceMetricsDTO | null;
    currentFrameSkip: number;
    start: (video: HTMLVideoElement) => Promise<void>;
    stop: () => PerformanceMetricsDTO | undefined;
}

export function useTracking(options: UseTrackingOptions): UseTrackingResult {
    const { mode, smoothingEnabled, dynamicInferenceEnabled, onFrame } = options;

    const [isRunning, setIsRunning] = useState(false);
    const [metrics, setMetrics] = useState<PerformanceMetricsDTO | null>(null);
    const [currentFrameSkip, setCurrentFrameSkip] = useState(1);

    const controllerRef = useRef<TrackingController | null>(null);
    const smootherRef = useRef<LandmarkSmoother | null>(null);
    const dynamicInferenceRef = useRef<DynamicInferenceController | null>(null);
    const performanceRef = useRef<PerformanceTracker | null>(null);
    const rafRef = useRef<number | null>(null);
    const metricsIntervalRef = useRef<number | null>(null);
    const frameCountRef = useRef(0);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const onFrameRef = useRef(onFrame);

    // Keep onFrame ref updated
    useEffect(() => {
        onFrameRef.current = onFrame;
    }, [onFrame]);

    // Update smoother config when enabled state changes
    useEffect(() => {
        smootherRef.current?.setConfig({ ...DEFAULT_SMOOTHING_CONFIG, enabled: smoothingEnabled });
    }, [smoothingEnabled]);

    // Update dynamic inference config
    useEffect(() => {
        dynamicInferenceRef.current?.setConfig({ enabled: dynamicInferenceEnabled });
    }, [dynamicInferenceEnabled]);

    const start = useCallback(async (video: HTMLVideoElement) => {
        videoRef.current = video;
        frameCountRef.current = 0;

        // Initialize controller
        const controller = await TrackingController.init(mode, { maxFaces: 1, maxHands: 2 });
        controllerRef.current = controller;

        // Initialize smoother
        smootherRef.current = new LandmarkSmoother({
            ...DEFAULT_SMOOTHING_CONFIG,
            enabled: smoothingEnabled,
        });

        // Initialize dynamic inference
        dynamicInferenceRef.current = new DynamicInferenceController({
            ...DEFAULT_DYNAMIC_INFERENCE_CONFIG,
            enabled: dynamicInferenceEnabled,
        });

        // Initialize performance tracker
        const perf = new PerformanceTracker();
        perf.start();
        performanceRef.current = perf;

        setIsRunning(true);

        // Metrics update interval (500ms)
        metricsIntervalRef.current = window.setInterval(() => {
            const pt = performanceRef.current;
            const di = dynamicInferenceRef.current;
            if (pt) {
                const m = pt.getMetrics();
                setMetrics(m);
                if (di && m.avgInferenceTimeMs > 0) {
                    di.recordInferenceTime(m.avgInferenceTimeMs);
                    setCurrentFrameSkip(di.getCurrentFrameSkip());
                }
            }
        }, 500);

        // Cache dimensions
        let cachedWidth = video.clientWidth;
        let cachedHeight = video.clientHeight;
        let dimensionCheck = 0;

        // Frame loop
        const loop = () => {
            const v = videoRef.current;
            const pt = performanceRef.current;
            const sm = smootherRef.current;
            const di = dynamicInferenceRef.current;
            const c = controllerRef.current;

            if (!v || !c || v.readyState < 2) {
                rafRef.current = requestAnimationFrame(loop);
                return;
            }

            frameCountRef.current++;
            const frameSkip = di?.getCurrentFrameSkip() ?? 1;

            if (frameCountRef.current % frameSkip !== 0) {
                rafRef.current = requestAnimationFrame(loop);
                return;
            }

            // Update dimensions periodically
            if (++dimensionCheck >= 60) {
                dimensionCheck = 0;
                cachedWidth = v.clientWidth;
                cachedHeight = v.clientHeight;
            }

            const frameStart = pt?.recordFrameStart() ?? 0;
            const ts = performance.now();

            // Inference
            const inferenceStart = performance.now();
            let dto = c.detect(v, ts, mode);
            pt?.recordInferenceTime(inferenceStart);

            // Smoothing
            if (sm) dto = sm.smooth(dto);

            const hasTracking = (dto.face?.faces?.length ?? 0) > 0 || (dto.hand?.hands?.length ?? 0) > 0;
            pt?.recordFrameEnd(frameStart, hasTracking);

            // Callback
            onFrameRef.current?.(dto, cachedWidth, cachedHeight);

            rafRef.current = requestAnimationFrame(loop);
        };

        rafRef.current = requestAnimationFrame(loop);
    }, [mode, smoothingEnabled, dynamicInferenceEnabled]);

    const stop = useCallback((): PerformanceMetricsDTO | undefined => {
        const finalMetrics = performanceRef.current?.getMetrics();

        setIsRunning(false);

        if (rafRef.current != null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }

        if (metricsIntervalRef.current != null) {
            clearInterval(metricsIntervalRef.current);
            metricsIntervalRef.current = null;
        }

        performanceRef.current = null;
        smootherRef.current?.reset();
        smootherRef.current = null;
        dynamicInferenceRef.current?.reset();
        dynamicInferenceRef.current = null;
        controllerRef.current?.close();
        controllerRef.current = null;
        videoRef.current = null;

        setMetrics(null);
        frameCountRef.current = 0;

        return finalMetrics;
    }, []);

    return { isRunning, metrics, currentFrameSkip, start, stop };
}
