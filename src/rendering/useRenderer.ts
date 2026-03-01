/**
 * useRenderer - React hook for the rendering system
 *
 * Provides a simple API for using the renderer in React components.
 * Automatically handles initialization, cleanup, and backend selection.
 * Uses lazy initialization - renderer is created on first render() call.
 */

import { useRef, useCallback, useState, useEffect } from "react";
import type { Renderer, RenderContext, RendererCapabilities } from "./types";
import { createRenderer, type RendererBackend } from "./createRenderer";
import { LandmarkOverlay } from "./overlays/LandmarkOverlay";
import { DEFAULT_LANDMARK_CONFIG } from "./types";
import type { TrackingDTO } from "../domain/tracking.dto";

export interface UseRendererOptions {
    preferredBackend?: RendererBackend;
    autoAddLandmarkOverlay?: boolean;
}

export interface UseRendererResult {
    /** Reference to attach to a canvas element */
    canvasRef: React.RefObject<HTMLCanvasElement | null>;
    /** Render tracking data to the overlay. Pass width/height of the video element. */
    render: (tracking: TrackingDTO | null, width: number, height: number) => void;
    /** Whether the renderer is initialized */
    isInitialized: boolean;
    /** Renderer capabilities (available after initialization) */
    capabilities: RendererCapabilities | null;
    /** Any initialization error */
    error: Error | null;
    /** Manually dispose the renderer */
    dispose: () => void;
}

export function useRenderer(options: UseRendererOptions = {}): UseRendererResult {
    const { preferredBackend = "auto", autoAddLandmarkOverlay = true } = options;

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const rendererRef = useRef<Renderer | null>(null);
    const initializingRef = useRef<boolean>(false);
    const startTimeRef = useRef<number>(performance.now());
    const lastFrameTimeRef = useRef<number>(performance.now());
    const lastSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });

    const [isInitialized, setIsInitialized] = useState(false);
    const [capabilities, setCapabilities] = useState<RendererCapabilities | null>(null);
    const [error, setError] = useState<Error | null>(null);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (rendererRef.current) {
                rendererRef.current.dispose();
                rendererRef.current = null;
            }
        };
    }, []);

    // Lazy initialization - called on first render
    const ensureInitialized = useCallback(async (width: number, height: number): Promise<boolean> => {
        // Already initialized
        if (rendererRef.current) return true;

        // Already initializing
        if (initializingRef.current) return false;

        const canvas = canvasRef.current;
        if (!canvas) return false;

        initializingRef.current = true;

        try {
            const renderer = await createRenderer({
                canvas,
                width,
                height,
                preferredBackend,
            });

            // Add default landmark overlay
            if (autoAddLandmarkOverlay) {
                const landmarkOverlay = new LandmarkOverlay(DEFAULT_LANDMARK_CONFIG);
                await renderer.addOverlay(landmarkOverlay);
            }

            rendererRef.current = renderer;
            lastSizeRef.current = { width, height };
            setCapabilities(renderer.getCapabilities());
            setIsInitialized(true);
            setError(null);

            console.log("[useRenderer] Initialized with backend:", renderer.getCapabilities().backend);
            return true;
        } catch (e) {
            setError(e instanceof Error ? e : new Error("Unknown renderer error"));
            console.error("[useRenderer] Failed to initialize:", e);
            return false;
        } finally {
            initializingRef.current = false;
        }
    }, [preferredBackend, autoAddLandmarkOverlay]);

    // Render function - handles lazy init and rendering
    const render = useCallback((tracking: TrackingDTO | null, width: number, height: number) => {
        if (width <= 0 || height <= 0) return;

        const renderer = rendererRef.current;

        // Lazy init if needed
        if (!renderer) {
            ensureInitialized(width, height);
            return; // Will render on next frame after init completes
        }

        const canvas = canvasRef.current;
        if (!canvas) return;

        // Resize if dimensions changed
        if (lastSizeRef.current.width !== width || lastSizeRef.current.height !== height) {
            renderer.resize(width, height);
            lastSizeRef.current = { width, height };
        }

        const now = performance.now();
        const deltaTime = now - lastFrameTimeRef.current;
        const elapsedTime = now - startTimeRef.current;
        lastFrameTimeRef.current = now;

        const context: RenderContext = {
            tracking,
            width,
            height,
            deltaTime,
            elapsedTime,
        };

        renderer.render(context);
    }, [ensureInitialized]);

    // Dispose function
    const dispose = useCallback(() => {
        if (rendererRef.current) {
            rendererRef.current.dispose();
            rendererRef.current = null;
            setIsInitialized(false);
            setCapabilities(null);
        }
    }, []);

    return {
        canvasRef,
        render,
        isInitialized,
        capabilities,
        error,
        dispose,
    };
}
