import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { CAPTURE_HEIGHT, CAPTURE_WIDTH, useCamera } from "../useCamera";

/**
 * The capture constraints are half of NF4: both apps must analyse frames of
 * the same size, from the front camera. A device that cannot deliver 1280x720
 * exactly gets the closest mode instead of no camera at all.
 */
const track = () => ({ stop: vi.fn() });

function stream(tracks = [track(), track()]) {
    return { getTracks: () => tracks } as unknown as MediaStream & { getTracks: () => ReturnType<typeof track>[] };
}

function videoElement() {
    return {
        srcObject: null as MediaStream | null,
        play: vi.fn(async () => {}),
        pause: vi.fn(),
    } as unknown as HTMLVideoElement & { play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> };
}

const getUserMedia = vi.fn();

beforeEach(() => {
    getUserMedia.mockReset();
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("useCamera", () => {
    it("asks for the front camera at exactly 1280x720, without audio", async () => {
        const video = videoElement();
        getUserMedia.mockResolvedValue(stream());
        const { result } = renderHook(() => useCamera({ current: video }));

        let started = false;
        await act(async () => {
            started = await result.current.start();
        });

        expect(started).toBe(true);
        expect(getUserMedia).toHaveBeenCalledWith({
            video: { facingMode: "user", width: { exact: CAPTURE_WIDTH }, height: { exact: CAPTURE_HEIGHT } },
            audio: false,
        });
        expect(video.srcObject).not.toBeNull();
        expect(video.play).toHaveBeenCalled();
        expect(result.current.isActive).toBe(true);
        expect(result.current.error).toBeNull();
    });

    it("falls back to the closest mode when the exact size is unavailable", async () => {
        const overconstrained = Object.assign(new Error("no 720p mode"), { name: "OverconstrainedError" });
        getUserMedia.mockRejectedValueOnce(overconstrained).mockResolvedValueOnce(stream());
        const { result } = renderHook(() => useCamera({ current: videoElement() }));

        await act(async () => {
            await result.current.start();
        });

        expect(getUserMedia.mock.calls[1][0]).toEqual({
            video: { facingMode: "user", width: { ideal: CAPTURE_WIDTH }, height: { ideal: CAPTURE_HEIGHT } },
            audio: false,
        });
        expect(result.current.isActive).toBe(true);
    });

    it("reports a refused permission instead of falling back", async () => {
        getUserMedia.mockRejectedValue(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
        const { result } = renderHook(() => useCamera({ current: videoElement() }));

        let started = true;
        await act(async () => {
            started = await result.current.start();
        });

        expect(started).toBe(false);
        expect(getUserMedia).toHaveBeenCalledTimes(1);
        expect(result.current.error).toBe("Permission denied");
        expect(result.current.isActive).toBe(false);
    });

    it("explains a missing camera API", async () => {
        Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
        const { result } = renderHook(() => useCamera({ current: videoElement() }));
        await act(async () => {
            await result.current.start();
        });
        // jsdom serves the page from http://localhost, which is exempt from the HTTPS rule.
        expect(result.current.error).toBe("Camera not supported in this browser.");
    });

    it("fails without a video element to show the stream in", async () => {
        getUserMedia.mockResolvedValue(stream());
        const { result } = renderHook(() => useCamera({ current: null }));
        await act(async () => {
            await result.current.start();
        });
        expect(result.current.error).toBe("Video element not available.");
    });

    it("releases the camera on stop", async () => {
        const video = videoElement();
        const tracks = [track(), track()];
        getUserMedia.mockResolvedValue(stream(tracks));
        const { result } = renderHook(() => useCamera({ current: video }));
        await act(async () => {
            await result.current.start();
        });

        act(() => result.current.stop());

        for (const t of tracks) expect(t.stop).toHaveBeenCalled();
        expect(video.pause).toHaveBeenCalled();
        expect(video.srcObject).toBeNull();
        expect(result.current.isActive).toBe(false);
    });
});
