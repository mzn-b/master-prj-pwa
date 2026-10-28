import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EngineOptions, EngineResult } from "../../tracking/engines";
import type { TrackingDTO } from "../../domain/tracking.dto";

/**
 * A session from Start to Stop, as the data sees it: which engine is built
 * with which settings, how camera frames, results and drops are counted, what
 * is drawn, and what is submitted — including the session boundary a filter
 * toggle creates. The tracker, smoother and inference-rate governor are the
 * real ones; the camera, the engine, the frame source, the renderers and the
 * upload are stand-ins, so no model runs.
 */
const camera = { start: vi.fn(async () => true), stop: vi.fn() };
vi.mock("../../hooks", async () => {
    const { useState } = await import("react");
    return {
        useCamera: () => {
            const [isActive, setActive] = useState(false);
            return {
                isActive,
                error: null,
                start: async () => {
                    const ok = await camera.start();
                    setActive(ok);
                    return ok;
                },
                stop: () => {
                    camera.stop();
                    setActive(false);
                },
            };
        },
    };
});

const renderLandmarks = vi.fn();
vi.mock("../../rendering", () => ({
    useRenderer: () => ({
        canvasRef: { current: null },
        render: renderLandmarks,
        isInitialized: true,
        capabilities: { backend: "webgpu" },
        error: null,
        dispose: vi.fn(),
    }),
}));

const filterTick = vi.fn();
let reportFilterError: ((message: string) => void) | undefined;
vi.mock("../../filters/FilterOverlay", async () => {
    const { forwardRef, useImperativeHandle } = await import("react");
    return {
        FilterOverlay: forwardRef((props: { onFilterError?: (m: string) => void }, ref) => {
            reportFilterError = props.onFilterError;
            useImperativeHandle(ref, () => ({ tick: filterTick, crownBackend: () => "webgpu" }));
            return null;
        }),
    };
});

const engine = { submit: vi.fn(), close: vi.fn(), latest: () => null };
let engineOptions: EngineOptions;
const createEngine = vi.fn(async (threading: string, options: EngineOptions) => {
    engineOptions = options;
    return { ...engine, threading, modelLoadTimeMs: 1500, gpuDelegateActive: options.useGPU };
});
vi.mock("../../tracking/engines", () => ({ createEngine: (t: string, o: EngineOptions) => createEngine(t, o) }));

let onCameraFrame: () => void;
const unsubscribe = vi.fn();
vi.mock("../../tracking/videoFrames", () => ({
    subscribeToVideoFrames: (_v: unknown, cb: () => void) => {
        onCameraFrame = cb;
        return unsubscribe;
    },
}));

const submitTrackingSession = vi.fn();
vi.mock("../../api/trackingApi", () => ({
    submitTrackingSession: (...a: unknown[]) => submitTrackingSession(...a),
}));

const deviceCheck = vi.fn();
vi.mock("../../tracking/TrackingConfig", async importOriginal => ({
    ...(await importOriginal<typeof import("../../tracking/TrackingConfig")>()),
    checkDeviceCapabilities: () => deviceCheck(),
}));

vi.mock("../../config/surveyBuild", () => ({ SURVEY_BUILD: false }));

import { CameraScreen } from "../CameraScreen";

const capable = {
    hasCamera: true, hasWebGL: true, hasWasm: true, hasSufficientMemory: true,
    isSecureContext: true, browserSupported: true, warnings: [] as string[], errors: [] as string[],
};

const face: TrackingDTO = {
    timestampMs: 1,
    mode: "combined",
    face: { faces: [{ landmarks: Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 })) }] },
};

let frames: FrameRequestCallback[] = [];
const videoProps: Record<string, number> = {
    readyState: 4, videoWidth: 1280, videoHeight: 720, clientWidth: 390, clientHeight: 700,
};

beforeEach(() => {
    vi.clearAllMocks();
    camera.start.mockResolvedValue(true);
    engine.submit.mockReturnValue({ status: "scheduled" });
    submitTrackingSession.mockResolvedValue({ status: "ok", response: {} });
    deviceCheck.mockResolvedValue({ ...capable });
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("ResizeObserver", class {
        observe() {}
        disconnect() {}
    });
    for (const [name, value] of Object.entries(videoProps)) {
        Object.defineProperty(HTMLVideoElement.prototype, name, { configurable: true, get: () => value });
    }
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const name of Object.keys(videoProps)) delete (HTMLVideoElement.prototype as never)[name];
});

async function mount() {
    render(<CameraScreen />);
    await screen.findByText("Bereit — Start drücken");
}

async function start() {
    await act(async () => fireEvent.click(screen.getByText("Start")));
}

async function stop() {
    await act(async () => fireEvent.click(screen.getByText("Stop")));
}

/** One camera frame offered to the engine, then its result arriving. */
function detectedFrame(result: Partial<EngineResult> = {}) {
    act(() => onCameraFrame());
    act(() => engineOptions.onResult({ dto: face, inferenceMs: 20, rawFaceCount: 1, rawHandCount: 0, ...result }));
}

function drawFrame() {
    const next = frames.shift();
    act(() => next?.(0));
}

const submitted = () => submitTrackingSession.mock.calls.map(([mode, metrics, filters]) => ({ mode, metrics, filters }));

describe("CameraScreen session", () => {
    it("shows the device check's warnings, and blocks Start on its errors", async () => {
        deviceCheck.mockResolvedValue({ ...capable, warnings: ["Wenig Speicher"], errors: ["Kein HTTPS."] });
        render(<CameraScreen />);
        expect(await screen.findByText("Wenig Speicher")).toBeTruthy();
        expect(screen.getByText("Kamera: Kein HTTPS.")).toBeTruthy();
        expect(screen.getByText("Kamerazugriff erforderlich")).toBeTruthy();
        expect((screen.getByText("Start") as HTMLButtonElement).disabled).toBe(true);
    });

    it("builds the engine with the study settings by default", async () => {
        await mount();
        await start();
        expect(createEngine).toHaveBeenCalledWith("main", expect.objectContaining({
            mode: "combined", maxFaces: 1, maxHands: 2, useGPU: true,
        }));
        expect(screen.getByText("Tracking aktiv")).toBeTruthy();
        expect(screen.getByText("Stop")).toBeTruthy();
    });

    it("builds the engine with the settings switched before Start, and submits them", async () => {
        await mount();
        fireEvent.click(screen.getByText("hand"));
        for (const label of ["F9: Glättung (One Euro)", "F15: Dynamische Inferenzrate", "GPU-Delegate", "Inferenz im Web Worker"]) {
            fireEvent.click(screen.getByRole("switch", { name: label }));
        }
        await start();
        expect(createEngine).toHaveBeenCalledWith("worker", expect.objectContaining({ mode: "hand", useGPU: false }));

        detectedFrame();
        await stop();
        expect(submitted()[0].mode).toBe("hand");
        expect(submitted()[0].metrics).toMatchObject({
            inferenceThreading: "worker",
            smoothingEnabled: false,
            dynamicInferenceEnabled: false,
            gpuDelegateEnabled: false,
            gpuDelegateActive: false,
            modelLoadTimeMs: 1500,
            frameWidth: 1280,
            frameHeight: 720,
        });
    });

    it("counts a detected frame, a busy one and an engine error, then submits on Stop", async () => {
        await mount();
        await start();
        detectedFrame();
        engine.submit.mockReturnValueOnce({ status: "busy" });
        act(() => onCameraFrame());
        act(() => engineOptions.onError("graph failed"));
        expect(engine.submit).toHaveBeenCalledWith(expect.any(HTMLVideoElement), expect.any(Number), "combined");

        await stop();
        expect(submitted()).toHaveLength(1);
        expect(submitted()[0]).toMatchObject({ mode: "combined", filters: [] });
        expect(submitted()[0].metrics).toMatchObject({
            frameCount: 1,
            droppedFrames: 1,
            droppedFramesBusy: 1,
            errorCount: 1,
            renderBackend: "webgpu",
            inferenceThreading: "main",
        });
        expect(await screen.findByText("Daten gesendet")).toBeTruthy();
    });

    it("counts a frame graced from an earlier detection as no detection", async () => {
        await mount();
        await start();
        detectedFrame();
        detectedFrame({ rawFaceCount: 0 }); // the DTO still carries the held face
        await stop();
        expect(submitted()[0].metrics).toMatchObject({ trackingLostCount: 1, facesDetectedAvg: 0.5 });
    });

    it("releases the engine, the frame subscription and the camera on Stop", async () => {
        await mount();
        await start();
        await stop();
        expect(engine.close).toHaveBeenCalled();
        expect(unsubscribe).toHaveBeenCalled();
        expect(camera.stop).toHaveBeenCalled();
        expect(screen.getByText("Start")).toBeTruthy();
    });

    it("submits nothing for a session without frames", async () => {
        await mount();
        await start();
        await stop();
        expect(submitTrackingSession).not.toHaveBeenCalled();
        expect(screen.getByText("Tracking gestoppt")).toBeTruthy();
    });

    it("says when the upload failed or was skipped", async () => {
        await mount();
        submitTrackingSession.mockResolvedValueOnce({ status: "skipped", reason: "desktop" });
        await start();
        detectedFrame();
        await stop();
        expect(await screen.findByText("Nicht gesendet (kein mobiles Gerät)")).toBeTruthy();

        submitTrackingSession.mockRejectedValueOnce(new Error("offline"));
        await start();
        detectedFrame();
        await stop();
        expect(await screen.findByText("Senden fehlgeschlagen")).toBeTruthy();
    });

    it("draws the latest detection through the landmark renderer", async () => {
        await mount();
        await start();
        drawFrame(); // nothing detected yet
        detectedFrame();
        drawFrame();
        expect(renderLandmarks).toHaveBeenNthCalledWith(1, null, expect.objectContaining({ viewWidth: 390 }));
        expect(renderLandmarks.mock.calls[1][0].face).toBeDefined();
        expect(filterTick).not.toHaveBeenCalled();
        expect(frames).toHaveLength(1); // the loop re-arms itself
    });

    it("skips frames the inference-rate governor holds back", async () => {
        await mount();
        await start();
        // Slow inference makes the governor raise the skip; force it directly.
        const governor = await import("../../tracking/TrackingConfig");
        vi.spyOn(governor.DynamicInferenceController.prototype, "getCurrentFrameSkip").mockReturnValue(2);
        act(() => onCameraFrame()); // frame 1 of every 2: held back
        act(() => onCameraFrame()); // frame 2: submitted
        expect(engine.submit).toHaveBeenCalledTimes(1);
        detectedFrame();
        await stop();
        expect(submitted()[0].metrics).toMatchObject({ droppedFramesGovernor: 2, avgFrameSkip: 2 });
    });

    it("ignores camera frames before the video has data", async () => {
        await mount();
        await start();
        Object.defineProperty(HTMLVideoElement.prototype, "readyState", { configurable: true, get: () => 1 });
        act(() => onCameraFrame());
        drawFrame();
        expect(engine.submit).not.toHaveBeenCalled();
        expect(renderLandmarks).not.toHaveBeenCalled();
    });

    it("reports a start that fails and leaves the camera off", async () => {
        createEngine.mockRejectedValueOnce(new Error("Modell konnte nicht geladen werden"));
        await mount();
        await start();
        expect(screen.getByText("Kamera: Modell konnte nicht geladen werden")).toBeTruthy();
        expect(camera.stop).toHaveBeenCalled();
        expect(submitTrackingSession).not.toHaveBeenCalled();
    });

    it("builds no engine when the camera does not start", async () => {
        camera.start.mockResolvedValue(false);
        await mount();
        await start();
        expect(createEngine).not.toHaveBeenCalled();
    });

    it("refreshes the metrics and the capture size every half second", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        await mount();
        fireEvent.click(screen.getByRole("switch", { name: "Performance-HUD" }));
        fireEvent.click(screen.getByRole("switch", { name: "F14: Debug-HUD" }));
        Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 0 });
        await start();
        detectedFrame();
        Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 1920 });
        act(() => vi.advanceTimersByTime(500));
        await stop();
        expect(submitted()[0].metrics.frameWidth).toBe(1920);
    });
});

describe("CameraScreen filters", () => {
    async function filtersRunning() {
        await mount();
        fireEvent.click(screen.getByText("hand")); // must not apply in filters mode
        fireEvent.click(screen.getByText("Filters"));
        await start();
    }

    it("always tracks face and hand in the filter view", async () => {
        await filtersRunning();
        expect(createEngine).toHaveBeenCalledWith("main", expect.objectContaining({ mode: "combined" }));
    });

    it("draws through the filter overlay, not the landmark renderer", async () => {
        await filtersRunning();
        detectedFrame();
        drawFrame();
        expect(filterTick).toHaveBeenCalledWith(face, expect.objectContaining({ viewWidth: 390 }));
        expect(renderLandmarks).not.toHaveBeenCalled();
    });

    it("closes the session at each filter toggle, labelled with what was on screen", async () => {
        await filtersRunning();
        detectedFrame();
        await act(async () => fireEvent.click(screen.getByText("Crown")));
        detectedFrame();
        await act(async () => fireEvent.click(screen.getByText("Glasses")));
        await stop(); // no frames since the last toggle

        expect(submitted().map(s => [s.mode, s.filters, s.metrics.renderBackend])).toEqual([
            ["combined", [], "none"],
            ["combined", ["crown"], "webgpu"],
        ]);
        expect(submitted()[1].metrics.frameCount).toBe(1); // reset at the boundary
    });

    it("submits the filters that were on at Stop", async () => {
        await filtersRunning();
        await act(async () => fireEvent.click(screen.getByText("Sparkles")));
        detectedFrame();
        await stop();
        expect(submitted().at(-1)).toMatchObject({ filters: ["sparkles"] });
        expect(submitted().at(-1)?.metrics.renderBackend).toBe("canvas2d");
    });

    it("clears the selection when leaving the filter view, and not while running", async () => {
        await filtersRunning();
        await act(async () => fireEvent.click(screen.getByText("Crown")));
        fireEvent.click(screen.getByText("Landmarks")); // ignored while running
        detectedFrame();
        await stop();
        expect(submitted().at(-1)?.filters).toEqual(["crown"]);

        fireEvent.click(screen.getByText("Landmarks"));
        fireEvent.click(screen.getByText("Filters"));
        await start();
        detectedFrame();
        await stop();
        expect(submitted().at(-1)?.filters).toEqual([]);
    });

    it("shows a filter that failed to start until the view is changed", async () => {
        await filtersRunning();
        act(() => reportFilterError?.("Krone konnte nicht geladen werden: 404"));
        expect(screen.getByText("Filter-Fehler: Krone konnte nicht geladen werden: 404")).toBeTruthy();
        await stop();
        fireEvent.click(screen.getByText("Landmarks"));
        expect(screen.queryByText(/Filter-Fehler/)).toBeNull();
    });
});
