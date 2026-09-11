/**
 * Subscribe to camera frames rather than to the display refresh.
 *
 * `requestVideoFrameCallback` fires once per frame the video element actually
 * presents, which is what the pipeline should be driven by: a 30 fps camera in a
 * 120 Hz page otherwise gets inferred on four times, three of them on frames
 * MediaPipe has already seen.
 *
 * Firefox has no `requestVideoFrameCallback`, so there the fallback polls on
 * requestAnimationFrame and gates on `currentTime` advancing — coarser, but it
 * still refuses to re-infer a frame that has not changed.
 *
 * Returns a function that cancels the subscription.
 */

/** Whether the precise per-camera-frame API is available in this browser. */
export function hasVideoFrameCallback(): boolean {
    return (
        typeof HTMLVideoElement !== "undefined" &&
        "requestVideoFrameCallback" in HTMLVideoElement.prototype
    );
}

export function subscribeToVideoFrames(video: HTMLVideoElement, onFrame: () => void): () => void {
    // Checked on the element rather than the prototype: that is what actually
    // determines whether the call works, and it keeps the two paths testable.
    if (typeof video.requestVideoFrameCallback === "function") {
        let handle = 0;
        let cancelled = false;
        const tick = () => {
            if (cancelled) return;
            onFrame();
            handle = video.requestVideoFrameCallback(tick);
        };
        handle = video.requestVideoFrameCallback(tick);
        return () => {
            cancelled = true;
            video.cancelVideoFrameCallback(handle);
        };
    }

    let raf = 0;
    let cancelled = false;
    let lastTime = -1;
    const tick = () => {
        if (cancelled) return;
        // Only a changed currentTime means a new frame was decoded.
        if (video.currentTime !== lastTime) {
            lastTime = video.currentTime;
            onFrame();
        }
        raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
        cancelled = true;
        cancelAnimationFrame(raf);
    };
}

