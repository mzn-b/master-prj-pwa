import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(cleanup);

/**
 * In the survey build participants hold the phone and the operator selects the
 * view and the filters; nothing else may be changeable. Every run must use the
 * study settings (thesis §6.1.2): combined tracking, smoothing, the adaptive
 * inference rate and the GPU delegate on, inference on the main thread. Those
 * are the defaults, so hiding the controls fixes them there.
 *
 * The camera, the overlay renderer and the crown are stubbed: the test is about
 * which controls exist, not about tracking.
 */
const MEASUREMENT_SETTINGS = [
    "F9: Glättung (One Euro)",
    "F15: Dynamische Inferenzrate",
    "GPU-Delegate",
    "Performance-HUD",
    "F14: Debug-HUD",
    "Inferenz im Web Worker",
];
const MODES = ["face", "hand", "combined"];

async function renderScreen(surveyBuild: boolean) {
    vi.resetModules();
    vi.doMock("../../config/surveyBuild", () => ({ SURVEY_BUILD: surveyBuild }));
    vi.doMock("../../hooks", () => ({
        useCamera: () => ({ isActive: false, error: null, start: vi.fn(async () => false), stop: vi.fn() }),
    }));
    vi.doMock("../../rendering", () => ({
        useRenderer: () => ({
            canvasRef: { current: null },
            render: vi.fn(),
            isInitialized: false,
            capabilities: null,
            error: null,
            dispose: vi.fn(),
        }),
    }));
    vi.doMock("../../filters/FilterOverlay", async () => {
        const { forwardRef } = await import("react");
        return { FilterOverlay: forwardRef(() => null) };
    });
    const { CameraScreen } = await import("../CameraScreen");
    render(<CameraScreen />);
}

describe("CameraScreen controls", () => {
    beforeEach(() => vi.clearAllMocks());

    it("full build: offers the tracking modes and every setting", async () => {
        await renderScreen(false);
        for (const mode of MODES) expect(screen.getByText(mode)).toBeTruthy();
        for (const label of MEASUREMENT_SETTINGS) expect(screen.getByText(label)).toBeTruthy();
    });

    it("survey build: keeps what the operator needs", async () => {
        await renderScreen(true);
        expect(screen.getByText("Start")).toBeTruthy();
        expect(screen.getByText("Landmarks")).toBeTruthy();
        expect(screen.getByText("Filters")).toBeTruthy();
        expect(screen.getByText(/\(Studie\)/)).toBeTruthy();
    });

    it("survey build: offers no tracking-mode choice", async () => {
        await renderScreen(true);
        for (const mode of MODES) expect(screen.queryByText(mode)).toBeNull();
    });

    it("survey build: offers none of the measurement settings", async () => {
        await renderScreen(true);
        for (const label of MEASUREMENT_SETTINGS) expect(screen.queryByText(label)).toBeNull();
    });
});
