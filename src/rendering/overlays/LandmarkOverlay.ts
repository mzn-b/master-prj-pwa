/**
 * Landmark Overlay - Renders face and hand landmarks
 *
 * Works with both WebGPU and WebGL renderers.
 * Optimized for performance with batched rendering.
 *
 * WebGPU: Uses instanced quad rendering (point primitives don't support variable sizes)
 * WebGL: Uses native point primitives with gl_PointSize
 */

import type {
    Overlay,
    Renderer,
    RenderContext,
    LandmarkOverlayConfig,
} from "../types";

// Maximum points we can render (face: 478, hands: 21*2 = 42, total ~520)
const MAX_POINTS = 1024;

export class LandmarkOverlay implements Overlay {
    readonly id: string;
    readonly type = "landmarks" as const;
    enabled: boolean;
    order: number;

    private config: LandmarkOverlayConfig;
    private rendererBackend: "webgl" | "webgl2" | "webgpu" | null = null;
    private pixelRatio: number = 1;

    // WebGPU resources
    private gpuDevice: GPUDevice | null = null;
    private gpuPipeline: GPURenderPipeline | null = null;
    private gpuInstanceBuffer: GPUBuffer | null = null;
    private gpuUniformBuffer: GPUBuffer | null = null;
    private gpuBindGroup: GPUBindGroup | null = null;

    // WebGL resources
    private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
    private glProgram: WebGLProgram | null = null;
    private glPositionBuffer: WebGLBuffer | null = null;
    private glPointSizeBuffer: WebGLBuffer | null = null;
    private glLocations: {
        position: number;
        pointSize: number;
        resolution: WebGLUniformLocation | null;
        color: WebGLUniformLocation | null;
    } | null = null;

    // Shared data buffers (reused each frame to avoid allocations)
    private positionData: Float32Array;
    private pointSizeData: Float32Array;
    // WebGPU instance data: x, y, size, colorIndex per instance
    private instanceData: Float32Array;
    private facePointCount = 0;
    private handPointCount = 0;

    constructor(config: LandmarkOverlayConfig) {
        this.id = config.id;
        this.enabled = config.enabled;
        this.order = config.order;
        this.config = config;
        this.positionData = new Float32Array(MAX_POINTS * 2);
        this.pointSizeData = new Float32Array(MAX_POINTS);
        this.instanceData = new Float32Array(MAX_POINTS * 4); // x, y, size, colorIndex
    }

    async init(renderer: Renderer): Promise<void> {
        const caps = renderer.getCapabilities();
        this.rendererBackend = caps.backend as "webgl" | "webgl2" | "webgpu";
        this.pixelRatio = (renderer as unknown as { getPixelRatio?(): number }).getPixelRatio?.() ?? window.devicePixelRatio;

        if (caps.backend === "webgpu") {
            await this.initWebGPU(renderer);
        } else if (caps.backend === "webgl" || caps.backend === "webgl2") {
            await this.initWebGL(renderer);
        }

        console.log(`[LandmarkOverlay] Initialized with ${caps.backend} backend`);
    }

    private async initWebGPU(renderer: Renderer): Promise<void> {
        const device = (renderer as unknown as { getDevice(): GPUDevice }).getDevice();
        const format = (renderer as unknown as { getFormat(): GPUTextureFormat }).getFormat();
        this.gpuDevice = device;

        // Shader for instanced quad rendering
        // Each instance is a point rendered as a quad with circle fragment shader
        const shaderModule = device.createShaderModule({
            code: `
                struct Uniforms {
                    resolution: vec2f,
                    faceColor: vec4f,
                    handColor: vec4f,
                }

                @group(0) @binding(0) var<uniform> uniforms: Uniforms;

                struct VertexOutput {
                    @builtin(position) position: vec4f,
                    @location(0) uv: vec2f,
                    @location(1) color: vec4f,
                }

                // Quad vertices (2 triangles)
                const quadVertices = array<vec2f, 6>(
                    vec2f(-0.5, -0.5),
                    vec2f( 0.5, -0.5),
                    vec2f( 0.5,  0.5),
                    vec2f(-0.5, -0.5),
                    vec2f( 0.5,  0.5),
                    vec2f(-0.5,  0.5),
                );

                const quadUVs = array<vec2f, 6>(
                    vec2f(0.0, 0.0),
                    vec2f(1.0, 0.0),
                    vec2f(1.0, 1.0),
                    vec2f(0.0, 0.0),
                    vec2f(1.0, 1.0),
                    vec2f(0.0, 1.0),
                );

                @vertex
                fn vertexMain(
                    @builtin(vertex_index) vertexIndex: u32,
                    @location(0) instanceData: vec4f  // x, y, size, colorIndex
                ) -> VertexOutput {
                    var output: VertexOutput;

                    let quadIndex = vertexIndex % 6u;
                    let quadVertex = quadVertices[quadIndex];

                    // Scale quad by point size and position at instance location
                    let worldPos = instanceData.xy + quadVertex * instanceData.z;

                    // Convert from pixels to clip space
                    let clipPos = (worldPos / uniforms.resolution) * 2.0 - 1.0;
                    output.position = vec4f(clipPos.x, -clipPos.y, 0.0, 1.0);
                    output.uv = quadUVs[quadIndex];

                    // Select color based on colorIndex (0 = face, 1 = hand)
                    if (instanceData.w < 0.5) {
                        output.color = uniforms.faceColor;
                    } else {
                        output.color = uniforms.handColor;
                    }

                    return output;
                }

                @fragment
                fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
                    // Circle shape - discard outside radius
                    let center = input.uv - vec2f(0.5);
                    let dist = length(center);
                    if (dist > 0.5) {
                        discard;
                    }

                    // Smooth edge
                    let alpha = 1.0 - smoothstep(0.4, 0.5, dist);
                    return vec4f(input.color.rgb, input.color.a * alpha);
                }
            `,
        });

        // Instance buffer (dynamic, updated each frame)
        this.gpuInstanceBuffer = device.createBuffer({
            size: MAX_POINTS * 4 * 4, // vec4f per instance
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });

        // Uniform buffer
        this.gpuUniformBuffer = device.createBuffer({
            size: 48, // vec2f resolution (8) + padding (8) + vec4f faceColor (16) + vec4f handColor (16)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Bind group layout and bind group
        const bindGroupLayout = device.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: "uniform" },
            }],
        });

        this.gpuBindGroup = device.createBindGroup({
            layout: bindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.gpuUniformBuffer } }],
        });

        // Pipeline
        this.gpuPipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
            vertex: {
                module: shaderModule,
                entryPoint: "vertexMain",
                buffers: [{
                    arrayStride: 16, // vec4f
                    stepMode: "instance",
                    attributes: [{ shaderLocation: 0, offset: 0, format: "float32x4" }],
                }],
            },
            fragment: {
                module: shaderModule,
                entryPoint: "fragmentMain",
                targets: [{
                    format: format,
                    blend: {
                        color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
                        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                    },
                }],
            },
            primitive: { topology: "triangle-list" },
        });
    }

    private async initWebGL(renderer: Renderer): Promise<void> {
        const gl = (renderer as unknown as { getGL(): WebGLRenderingContext | WebGL2RenderingContext }).getGL();
        this.gl = gl;

        const vertexShader = `
            attribute vec2 a_position;
            attribute float a_pointSize;
            uniform vec2 u_resolution;

            void main() {
                vec2 clipSpace = (a_position / u_resolution) * 2.0 - 1.0;
                gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
                gl_PointSize = a_pointSize;
            }
        `;

        const fragmentShader = `
            precision mediump float;
            uniform vec4 u_color;

            void main() {
                vec2 coord = gl_PointCoord - vec2(0.5);
                float dist = length(coord);
                if (dist > 0.5) {
                    discard;
                }
                float alpha = 1.0 - smoothstep(0.4, 0.5, dist);
                gl_FragColor = vec4(u_color.rgb, u_color.a * alpha);
            }
        `;

        this.glProgram = this.createGLProgram(gl, vertexShader, fragmentShader);
        if (!this.glProgram) return;

        // Pre-allocate buffers with maximum size (avoids reallocation each frame)
        this.glPositionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.glPositionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, MAX_POINTS * 2 * 4, gl.DYNAMIC_DRAW);

        this.glPointSizeBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.glPointSizeBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, MAX_POINTS * 4, gl.DYNAMIC_DRAW);

        this.glLocations = {
            position: gl.getAttribLocation(this.glProgram, "a_position"),
            pointSize: gl.getAttribLocation(this.glProgram, "a_pointSize"),
            resolution: gl.getUniformLocation(this.glProgram, "u_resolution"),
            color: gl.getUniformLocation(this.glProgram, "u_color"),
        };
    }

    private createGLProgram(
        gl: WebGLRenderingContext | WebGL2RenderingContext,
        vertexSrc: string,
        fragmentSrc: string
    ): WebGLProgram | null {
        const vertexShader = gl.createShader(gl.VERTEX_SHADER)!;
        gl.shaderSource(vertexShader, vertexSrc);
        gl.compileShader(vertexShader);
        if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
            console.error("Vertex shader error:", gl.getShaderInfoLog(vertexShader));
            return null;
        }

        const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)!;
        gl.shaderSource(fragmentShader, fragmentSrc);
        gl.compileShader(fragmentShader);
        if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
            console.error("Fragment shader error:", gl.getShaderInfoLog(fragmentShader));
            return null;
        }

        const program = gl.createProgram()!;
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error("Shader link error:", gl.getProgramInfoLog(program));
            return null;
        }

        // Clean up shaders (they're now part of the program)
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);

        return program;
    }

    update(context: RenderContext): void {
        const { tracking, width, height } = context;
        if (!tracking) {
            this.facePointCount = 0;
            this.handPointCount = 0;
            return;
        }

        const canvasWidth = width * this.pixelRatio;
        const canvasHeight = height * this.pixelRatio;

        let offset = 0;
        let instanceOffset = 0;

        // Face landmarks
        const faces = tracking.face?.faces ?? [];
        this.facePointCount = 0;
        const faceSize = this.config.faceStyle.size * this.pixelRatio;
        for (const face of faces) {
            for (const p of face.landmarks) {
                const x = p.x * canvasWidth;
                const y = p.y * canvasHeight;

                // WebGL data
                this.positionData[offset * 2] = x;
                this.positionData[offset * 2 + 1] = y;
                this.pointSizeData[offset] = faceSize;

                // WebGPU instance data: x, y, size, colorIndex (0 = face)
                this.instanceData[instanceOffset++] = x;
                this.instanceData[instanceOffset++] = y;
                this.instanceData[instanceOffset++] = faceSize;
                this.instanceData[instanceOffset++] = 0;

                offset++;
                this.facePointCount++;
            }
        }

        // Hand landmarks
        const hands = tracking.hand?.hands ?? [];
        this.handPointCount = 0;
        const handSize = this.config.handStyle.size * this.pixelRatio;
        for (const hand of hands) {
            for (const p of hand.landmarks) {
                const x = p.x * canvasWidth;
                const y = p.y * canvasHeight;

                // WebGL data
                this.positionData[offset * 2] = x;
                this.positionData[offset * 2 + 1] = y;
                this.pointSizeData[offset] = handSize;

                // WebGPU instance data: x, y, size, colorIndex (1 = hand)
                this.instanceData[instanceOffset++] = x;
                this.instanceData[instanceOffset++] = y;
                this.instanceData[instanceOffset++] = handSize;
                this.instanceData[instanceOffset++] = 1;

                offset++;
                this.handPointCount++;
            }
        }
    }

    render(context: RenderContext): void {
        if (this.facePointCount === 0 && this.handPointCount === 0) return;

        if (this.rendererBackend === "webgpu") {
            this.renderWebGPU(context);
        } else if (this.rendererBackend === "webgl" || this.rendererBackend === "webgl2") {
            this.renderWebGL(context);
        }
    }

    renderWebGPU(context: RenderContext): void {
        const device = this.gpuDevice;
        if (!device || !this.gpuPipeline || !this.gpuInstanceBuffer || !this.gpuUniformBuffer || !this.gpuBindGroup) {
            return;
        }

        const totalPoints = this.facePointCount + this.handPointCount;
        if (totalPoints === 0) return;

        const canvasWidth = context.width * this.pixelRatio;
        const canvasHeight = context.height * this.pixelRatio;

        // Update uniform buffer
        const uniformData = new Float32Array([
            canvasWidth, canvasHeight, 0, 0,  // resolution + padding
            ...this.config.faceStyle.color,   // faceColor
            ...this.config.handStyle.color,   // handColor
        ]);
        device.queue.writeBuffer(this.gpuUniformBuffer, 0, uniformData);

        // Update instance buffer
        device.queue.writeBuffer(
            this.gpuInstanceBuffer,
            0,
            this.instanceData.buffer,
            0,
            totalPoints * 4 * 4
        );
    }

    /**
     * Called by WebGPURenderer to encode draw commands
     * This allows the overlay to participate in the renderer's render pass
     */
    encodeWebGPU(passEncoder: GPURenderPassEncoder): void {
        if (!this.gpuPipeline || !this.gpuInstanceBuffer || !this.gpuBindGroup) return;

        const totalPoints = this.facePointCount + this.handPointCount;
        if (totalPoints === 0) return;

        passEncoder.setPipeline(this.gpuPipeline);
        passEncoder.setBindGroup(0, this.gpuBindGroup);
        passEncoder.setVertexBuffer(0, this.gpuInstanceBuffer);
        // 6 vertices per quad (2 triangles), instanced for each point
        passEncoder.draw(6, totalPoints, 0, 0);
    }

    private renderWebGL(context: RenderContext): void {
        const gl = this.gl;
        if (!gl || !this.glProgram || !this.glLocations) return;

        const canvasWidth = context.width * this.pixelRatio;
        const canvasHeight = context.height * this.pixelRatio;
        const totalPoints = this.facePointCount + this.handPointCount;

        gl.useProgram(this.glProgram);
        gl.uniform2f(this.glLocations.resolution, canvasWidth, canvasHeight);

        // Upload all position data at once using bufferSubData (no reallocation)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.glPositionBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.positionData.subarray(0, totalPoints * 2));
        gl.enableVertexAttribArray(this.glLocations.position);
        gl.vertexAttribPointer(this.glLocations.position, 2, gl.FLOAT, false, 0, 0);

        // Upload all point size data at once
        gl.bindBuffer(gl.ARRAY_BUFFER, this.glPointSizeBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.pointSizeData.subarray(0, totalPoints));
        gl.enableVertexAttribArray(this.glLocations.pointSize);
        gl.vertexAttribPointer(this.glLocations.pointSize, 1, gl.FLOAT, false, 0, 0);

        // Render face points
        if (this.facePointCount > 0) {
            const faceColor = this.config.faceStyle.color;
            gl.uniform4f(this.glLocations.color, faceColor[0], faceColor[1], faceColor[2], faceColor[3]);
            gl.drawArrays(gl.POINTS, 0, this.facePointCount);
        }

        // Render hand points (continue from face offset)
        if (this.handPointCount > 0) {
            const handColor = this.config.handStyle.color;
            gl.uniform4f(this.glLocations.color, handColor[0], handColor[1], handColor[2], handColor[3]);
            gl.drawArrays(gl.POINTS, this.facePointCount, this.handPointCount);
        }
    }

    setConfig(config: Partial<LandmarkOverlayConfig>): void {
        Object.assign(this.config, config);
    }

    dispose(): void {
        // Clean up WebGL resources
        if (this.gl) {
            if (this.glProgram) this.gl.deleteProgram(this.glProgram);
            if (this.glPositionBuffer) this.gl.deleteBuffer(this.glPositionBuffer);
            if (this.glPointSizeBuffer) this.gl.deleteBuffer(this.glPointSizeBuffer);
        }

        // Clean up WebGPU resources
        this.gpuInstanceBuffer?.destroy();
        this.gpuUniformBuffer?.destroy();

        // Clear references
        this.glProgram = null;
        this.glPositionBuffer = null;
        this.glPointSizeBuffer = null;
        this.gpuDevice = null;
        this.gpuPipeline = null;
        this.gpuInstanceBuffer = null;
        this.gpuUniformBuffer = null;
        this.gpuBindGroup = null;
        this.gl = null;
        this.rendererBackend = null;
    }
}
