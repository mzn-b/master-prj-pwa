/**
 * useCamera - Camera stream management hook
 * Handles MediaStream lifecycle with proper cleanup.
 *
 * The video ref is owned by the caller and passed in, rather than created here
 * and returned. Returning a ref alongside state in one object makes the returned
 * object opaque to React's ref analysis — every read of `camera.isActive` in
 * render is then reported as a ref access. Taking the ref as a parameter keeps
 * the returned value plain state and makes the ownership obvious.
 */

import { useRef, useCallback, useState } from "react";

/**
 * NF4 — the capture resolution both apps are measured at.
 *
 * Inference cost scales with source resolution, so a cross-platform comparison
 * only means something if both sides capture at the same size. The native app
 * pins the same 1280x720 through VisionCamera's HD_16_9 target.
 *
 * Requested as `exact` first so the browser cannot quietly hand back something
 * else. A device with no matching mode rejects that outright, so we fall back to
 * `ideal` rather than failing to start — and both apps submit the size actually
 * delivered, so any fallback is visible in the data instead of silent.
 */
export const CAPTURE_WIDTH = 1280;
export const CAPTURE_HEIGHT = 720;

async function requestStream(): Promise<MediaStream> {
    const base: MediaTrackConstraints = { facingMode: "user" };
    try {
        return await navigator.mediaDevices.getUserMedia({
            video: {
                ...base,
                width: { exact: CAPTURE_WIDTH },
                height: { exact: CAPTURE_HEIGHT },
            },
            audio: false,
        });
    } catch (e) {
        if (!(e instanceof Error) || e.name !== "OverconstrainedError") throw e;
        console.warn(
            `[useCamera] ${CAPTURE_WIDTH}x${CAPTURE_HEIGHT} unavailable; falling back to the ` +
            "closest mode. The delivered size is submitted with the session.",
        );
        return navigator.mediaDevices.getUserMedia({
            video: {
                ...base,
                width: { ideal: CAPTURE_WIDTH },
                height: { ideal: CAPTURE_HEIGHT },
            },
            audio: false,
        });
    }
}

export interface UseCameraResult {
    isActive: boolean;
    error: string | null;
    start: () => Promise<boolean>;
    stop: () => void;
}

export function useCamera(videoRef: React.RefObject<HTMLVideoElement | null>): UseCameraResult {
    const streamRef = useRef<MediaStream | null>(null);
    const [isActive, setIsActive] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const start = useCallback(async (): Promise<boolean> => {
        setError(null);

        try {
            if (!navigator.mediaDevices?.getUserMedia) {
                if (window.location.protocol === "http:" && window.location.hostname !== "localhost") {
                    throw new Error("Camera requires HTTPS.");
                }
                throw new Error("Camera not supported in this browser.");
            }

            const stream = await requestStream();
            streamRef.current = stream;

            const video = videoRef.current;
            if (!video) throw new Error("Video element not available.");

            video.srcObject = stream;
            await video.play();
            setIsActive(true);
            return true;
        } catch (e) {
            const msg = e instanceof Error ? e.message : "Unknown camera error.";
            setError(msg);
            return false;
        }
    }, [videoRef]);

    const stop = useCallback(() => {
        setIsActive(false);

        const stream = streamRef.current;
        if (stream) {
            for (const track of stream.getTracks()) track.stop();
            streamRef.current = null;
        }

        const video = videoRef.current;
        if (video) {
            video.pause();
            video.srcObject = null;
        }
    }, [videoRef]);

    return { isActive, error, start, stop };
}
