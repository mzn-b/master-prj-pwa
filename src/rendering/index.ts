/**
 * Rendering Module - High-performance overlay rendering system
 *
 * Usage (React hook - recommended):
 *   import { useRenderer } from './rendering';
 *
 *   const { canvasRef, render, isInitialized } = useRenderer(videoEl);
 *   // In render loop: render(trackingDTO);
 *
 * Usage (imperative):
 *   import { createRenderer, LandmarkOverlay, DEFAULT_LANDMARK_CONFIG } from './rendering';
 *
 *   const renderer = await createRenderer({ canvas, width, height });
 *   renderer.addOverlay(new LandmarkOverlay(DEFAULT_LANDMARK_CONFIG));
 *   renderer.render({ tracking, width, height, deltaTime, elapsedTime });
 */

export * from "./types";
export * from "./createRenderer";
export * from "./useRenderer";
export { WebGPURenderer } from "./WebGPURenderer";
export { WebGLRenderer } from "./WebGLRenderer";
export { LandmarkOverlay } from "./overlays/LandmarkOverlay";
