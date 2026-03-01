/**
 * Rendering Types - Shared interfaces for the overlay/filter system
 *
 * Architecture:
 * - Renderer: Platform-specific (WebGPU/WebGL for PWA, SceneKit/Filament for Native)
 * - Overlay: Pluggable rendering components (dots, meshes, filters)
 * - Filter: 2D post-processing effects
 */

import type { TrackingDTO } from "../domain/tracking.dto";

// ============================================================================
// Core Renderer Interface
// ============================================================================

export interface RendererConfig {
    canvas: HTMLCanvasElement;
    width: number;
    height: number;
    pixelRatio?: number;
}

export interface RenderContext {
    /** Current frame tracking data */
    tracking: TrackingDTO | null;
    /** Canvas/viewport width */
    width: number;
    /** Canvas/viewport height */
    height: number;
    /** Time since last frame in ms */
    deltaTime: number;
    /** Total elapsed time in ms */
    elapsedTime: number;
}

export interface Renderer {
    /** Initialize the renderer */
    init(): Promise<void>;
    /** Resize the rendering surface */
    resize(width: number, height: number): void;
    /** Begin a new frame */
    beginFrame(): void;
    /** End the current frame */
    endFrame(): void;
    /** Render all overlays with the given context */
    render(context: RenderContext): void;
    /** Add an overlay to the render pipeline */
    addOverlay(overlay: Overlay): void | Promise<void>;
    /** Remove an overlay from the render pipeline */
    removeOverlay(id: string): void;
    /** Get an overlay by ID */
    getOverlay(id: string): Overlay | undefined;
    /** Get renderer capabilities */
    getCapabilities(): RendererCapabilities;
    /** Dispose of all resources */
    dispose(): void;
}

// ============================================================================
// Overlay System
// ============================================================================

export type OverlayType = "landmarks" | "mesh" | "filter2d" | "filter3d" | "custom";

export interface OverlayConfig {
    id: string;
    type: OverlayType;
    enabled: boolean;
    order: number; // Render order (lower = rendered first)
}

export interface Overlay {
    readonly id: string;
    readonly type: OverlayType;
    enabled: boolean;
    order: number;

    /** Initialize overlay resources (shaders, buffers, textures) */
    init(renderer: Renderer): Promise<void>;
    /** Update overlay state (called before render) */
    update(context: RenderContext): void;
    /** Render the overlay */
    render(context: RenderContext): void;
    /** Dispose of overlay resources */
    dispose(): void;
}

// ============================================================================
// Landmark Overlay (dots, connections)
// ============================================================================

export interface LandmarkStyle {
    color: [number, number, number, number]; // RGBA 0-1
    size: number;
    shape: "circle" | "square" | "diamond";
}

export interface ConnectionStyle {
    color: [number, number, number, number];
    width: number;
}

export interface LandmarkOverlayConfig extends OverlayConfig {
    type: "landmarks";
    faceStyle: LandmarkStyle;
    handStyle: LandmarkStyle;
    showConnections: boolean;
    connectionStyle?: ConnectionStyle;
}

// ============================================================================
// 3D Mesh Overlay (face masks, hand models)
// ============================================================================

export interface MeshOverlayConfig extends OverlayConfig {
    type: "mesh";
    meshUrl?: string; // URL to 3D model
    textureUrl?: string;
    /** How to anchor the mesh to tracking points */
    anchorMode: "face" | "hand" | "custom";
    /** Scale of the mesh */
    scale: [number, number, number];
    /** Offset from anchor point */
    offset: [number, number, number];
}

// ============================================================================
// 2D Filter (post-processing effects)
// ============================================================================

export type Filter2DType =
    | "blur"
    | "sharpen"
    | "colorAdjust"
    | "vignette"
    | "lut" // Color lookup table
    | "custom";

export interface Filter2DConfig extends OverlayConfig {
    type: "filter2d";
    filterType: Filter2DType;
    intensity: number; // 0-1
    params?: Record<string, number | string>;
}

// ============================================================================
// 3D Filter (volumetric effects, particles)
// ============================================================================

export type Filter3DType =
    | "particles"
    | "volumetric"
    | "distortion"
    | "custom";

export interface Filter3DConfig extends OverlayConfig {
    type: "filter3d";
    filterType: Filter3DType;
    params?: Record<string, number | string | number[]>;
}

// ============================================================================
// Renderer Capabilities
// ============================================================================

export interface RendererCapabilities {
    /** Renderer backend type */
    backend: "webgpu" | "webgl2" | "webgl" | "scenekit" | "filament";
    /** Maximum texture size */
    maxTextureSize: number;
    /** Supports compute shaders */
    computeShaders: boolean;
    /** Supports instanced rendering */
    instancing: boolean;
    /** Supports multiple render targets */
    mrt: boolean;
    /** Supports floating point textures */
    floatTextures: boolean;
    /** Max simultaneous overlays recommended */
    maxOverlays: number;
}

// ============================================================================
// GPU Resource Types
// ============================================================================

export interface GPUBufferDescriptor {
    size: number;
    usage: "vertex" | "index" | "uniform" | "storage";
    data?: ArrayBuffer | ArrayBufferView;
}

export interface GPUTextureDescriptor {
    width: number;
    height: number;
    format: "rgba8" | "rgba16f" | "rgba32f" | "depth24" | "depth32f";
    usage: "sampled" | "storage" | "renderTarget";
}

// ============================================================================
// Shader Types
// ============================================================================

export interface ShaderDescriptor {
    vertex: string;
    fragment: string;
    compute?: string;
}

// ============================================================================
// Default Configurations
// ============================================================================

export const DEFAULT_LANDMARK_CONFIG: LandmarkOverlayConfig = {
    id: "landmarks",
    type: "landmarks",
    enabled: true,
    order: 0,
    faceStyle: {
        color: [0.0, 1.0, 0.5, 0.8],
        size: 4,
        shape: "circle",
    },
    handStyle: {
        color: [0.0, 0.8, 1.0, 0.9],
        size: 6,
        shape: "circle",
    },
    showConnections: false,
};

export const DEFAULT_MESH_CONFIG: MeshOverlayConfig = {
    id: "mesh",
    type: "mesh",
    enabled: false,
    order: 1,
    anchorMode: "face",
    scale: [1, 1, 1],
    offset: [0, 0, 0],
};
