/**
 * WebGPU Renderer - High-performance rendering using WebGPU API
 *
 * Features:
 * - Modern GPU API with compute shader support
 * - Efficient batched rendering
 * - Extensible overlay system
 */

import type {
    Renderer,
    RendererConfig,
    RenderContext,
    Overlay,
    RendererCapabilities,
} from "./types";

// Extended overlay interface for WebGPU-specific encoding
interface WebGPUOverlay extends Overlay {
    renderWebGPU?(context: RenderContext): void;
    encodeWebGPU?(passEncoder: GPURenderPassEncoder): void;
}

export class WebGPURenderer implements Renderer {
    private canvas: HTMLCanvasElement;
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private format!: GPUTextureFormat;
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

    static async isSupported(): Promise<boolean> {
        if (!navigator.gpu) return false;
        try {
            const adapter = await navigator.gpu.requestAdapter();
            return adapter !== null;
        } catch {
            return false;
        }
    }

    async init(): Promise<void> {
        if (!navigator.gpu) {
            throw new Error("WebGPU not supported");
        }

        const adapter = await navigator.gpu.requestAdapter({
            powerPreference: "high-performance",
        });
        if (!adapter) {
            throw new Error("Failed to get WebGPU adapter");
        }

        this.device = await adapter.requestDevice({
            requiredFeatures: [],
            requiredLimits: {},
        });

        // Handle device loss
        this.device.lost.then((info) => {
            console.error("[WebGPURenderer] Device lost:", info.message);
            this.initialized = false;
        });

        this.context = this.canvas.getContext("webgpu") as GPUCanvasContext;
        if (!this.context) {
            throw new Error("Failed to get WebGPU context");
        }

        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: "premultiplied",
        });

        this.resize(this.width, this.height);

        // Initialize all overlays
        for (const overlay of this.overlays.values()) {
            await overlay.init(this);
        }

        this.initialized = true;
        console.log("[WebGPURenderer] Initialized with format:", this.format);
    }

    resize(width: number, height: number): void {
        this.width = width;
        this.height = height;
        this.canvas.width = Math.floor(width * this.pixelRatio);
        this.canvas.height = Math.floor(height * this.pixelRatio);
    }

    beginFrame(): void {
        // WebGPU handles this via command encoder
    }

    endFrame(): void {
        // WebGPU handles this via command buffer submission
    }

    render(context: RenderContext): void {
        if (!this.initialized || !this.device) return;

        // Update all overlays first (prepare data)
        for (const overlay of this.sortedOverlays) {
            if (overlay.enabled) {
                overlay.update(context);
                // Call renderWebGPU if available (uploads data to GPU)
                const gpuOverlay = overlay as WebGPUOverlay;
                if (gpuOverlay.renderWebGPU) {
                    gpuOverlay.renderWebGPU(context);
                }
            }
        }

        // Create command encoder and render pass
        const commandEncoder = this.device.createCommandEncoder();
        const textureView = this.context.getCurrentTexture().createView();

        const renderPassDescriptor: GPURenderPassDescriptor = {
            colorAttachments: [
                {
                    view: textureView,
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                    loadOp: "clear",
                    storeOp: "store",
                },
            ],
        };

        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);

        // Encode draw commands for all enabled overlays
        for (const overlay of this.sortedOverlays) {
            if (overlay.enabled) {
                const gpuOverlay = overlay as WebGPUOverlay;
                if (gpuOverlay.encodeWebGPU) {
                    gpuOverlay.encodeWebGPU(passEncoder);
                }
            }
        }

        passEncoder.end();
        this.device.queue.submit([commandEncoder.finish()]);
    }

    async addOverlay(overlay: Overlay): Promise<void> {
        this.overlays.set(overlay.id, overlay);
        this.updateSortedOverlays();
        if (this.initialized) {
            await overlay.init(this);
        }
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

    getDevice(): GPUDevice {
        return this.device;
    }

    getFormat(): GPUTextureFormat {
        return this.format;
    }

    getPixelRatio(): number {
        return this.pixelRatio;
    }

    getCapabilities(): RendererCapabilities {
        return {
            backend: "webgpu",
            maxTextureSize: 8192,
            computeShaders: true,
            instancing: true,
            mrt: true,
            floatTextures: true,
            maxOverlays: 32,
        };
    }

    dispose(): void {
        for (const overlay of this.overlays.values()) {
            overlay.dispose();
        }
        this.overlays.clear();
        this.sortedOverlays = [];
        if (this.device) {
            this.device.destroy();
        }
        this.initialized = false;
    }
}
