/**
 * useCamera - Camera stream management hook
 * Handles MediaStream lifecycle with proper cleanup
 */

import { useRef, useCallback, useState } from "react";

export interface UseCameraResult {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    streamRef: React.RefObject<MediaStream | null>;
    isActive: boolean;
    error: string | null;
    start: () => Promise<boolean>;
    stop: () => void;
}

export function useCamera(): UseCameraResult {
    const videoRef = useRef<HTMLVideoElement | null>(null);
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

            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
                audio: false,
            });
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
    }, []);

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
    }, []);

    return { videoRef, streamRef, isActive, error, start, stop };
}
