/**
 * WebGL Renderer - Fallback renderer for browsers without WebGPU
 *
 * Features:
 * - Universal browser support
 * - WebGL 2 preferred, WebGL 1 fallback
 * - Same overlay interface as WebGPU renderer
 */

import type {
    Renderer,
    RendererConfig,
    RenderContext,
    Overlay,
    RendererCapabilities,
} from "./types";

export class WebGLRenderer implements Renderer {
    private canvas: HTMLCanvasElement;
    private gl!: WebGL2RenderingContext | WebGLRenderingContext;
    private isWebGL2: boolean = false;
    private width: number;
    private height: number;
    private pixelRatio: number;

    private overlays: Map<string, Overlay> = new Map();
    private sortedOverlays: Overlay[] = [];
    private initialized = false;

    constructor(config: RendererConfig) {
        this.canvas = config.canvas;
        this.width = config.width;
        this.height = config.height;
        this.pixelRatio = config.pixelRatio ?? window.devicePixelRatio;
    }

    static isSupported(): boolean {
        const canvas = document.createElement("canvas");
        return !!(
            canvas.getContext("webgl2") || canvas.getContext("webgl")
        );
    }

    async init(): Promise<void> {
        // Try WebGL 2 first
        let gl = this.canvas.getContext("webgl2", {
            alpha: true,
            antialias: true,
            premultipliedAlpha: true,
            preserveDrawingBuffer: false,
        }) as WebGL2RenderingContext | null;

        if (gl) {
            this.isWebGL2 = true;
            this.gl = gl;
        } else {
            // Fall back to WebGL 1
            const gl1 = this.canvas.getContext("webgl", {
                alpha: true,
                antialias: true,
                premultipliedAlpha: true,
                preserveDrawingBuffer: false,
            }) as WebGLRenderingContext | null;
            if (!gl1) {
                throw new Error("WebGL not supported");
            }
            this.gl = gl1;
        }

        // Enable blending for transparency
        this.gl.enable(this.gl.BLEND);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

        this.resize(this.width, this.height);

        // Initialize all overlays
        for (const overlay of this.overlays.values()) {
            await overlay.init(this);
        }

        this.initialized = true;
    }

    resize(width: number, height: number): void {
        this.width = width;
        this.height = height;
        this.canvas.width = Math.floor(width * this.pixelRatio);
        this.canvas.height = Math.floor(height * this.pixelRatio);
        this.gl?.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    beginFrame(): void {
        const gl = this.gl;
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    endFrame(): void {
        // WebGL flushes automatically, but we can force it
        this.gl.flush();
    }

    render(context: RenderContext): void {
        if (!this.initialized) return;

        this.beginFrame();

        // Render all enabled overlays in order
        for (const overlay of this.sortedOverlays) {
            if (overlay.enabled) {
                overlay.update(context);
                overlay.render(context);
            }
        }

        this.endFrame();
    }

    async addOverlay(overlay: Overlay): Promise<void> {
        this.overlays.set(overlay.id, overlay);
        this.updateSortedOverlays();
        if (this.initialized) {
            await overlay.init(this);
        }
    }

    /** Get the current canvas pixel dimensions (accounting for pixel ratio) */
    getCanvasDimensions(): { width: number; height: number } {
        return {
            width: this.canvas.width,
            height: this.canvas.height,
        };
    }

    /** Get the current logical dimensions (CSS pixels) */
    getLogicalDimensions(): { width: number; height: number } {
        return {
            width: this.width,
            height: this.height,
        };
    }

    getPixelRatio(): number {
        return this.pixelRatio;
    }

    removeOverlay(id: string): void {
        const overlay = this.overlays.get(id);
        if (overlay) {
            overlay.dispose();
            this.overlays.delete(id);
            this.updateSortedOverlays();
        }
    }

    getOverlay(id: string): Overlay | undefined {
        return this.overlays.get(id);
    }

    private updateSortedOverlays(): void {
        this.sortedOverlays = Array.from(this.overlays.values()).sort(
            (a, b) => a.order - b.order
        );
    }

    getGL(): WebGL2RenderingContext | WebGLRenderingContext {
        return this.gl;
    }

    isWebGL2Context(): boolean {
        return this.isWebGL2;
    }

    getCapabilities(): RendererCapabilities {
        const gl = this.gl;
        const maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

        return {
            backend: this.isWebGL2 ? "webgl2" : "webgl",
            maxTextureSize: maxTexSize,
            computeShaders: false,
            instancing: this.isWebGL2,
            mrt: this.isWebGL2,
            floatTextures: !!gl.getExtension("OES_texture_float"),
            maxOverlays: 16,
        };
    }

    dispose(): void {
        for (const overlay of this.overlays.values()) {
            overlay.dispose();
        }
        this.overlays.clear();
        this.sortedOverlays = [];
        this.initialized = false;
    }
}
