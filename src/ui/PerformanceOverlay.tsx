import type { PerformanceMetricsDTO, TrackingDTO } from "../domain/tracking.dto";

type Props = {
    metrics: PerformanceMetricsDTO | null;
    visible: boolean;
    /** F14 — when true, render the Debug section (coordinates + per-modality status). */
    debug?: boolean;
    /** Latest tracking sample, only consumed when `debug` is true. */
    tracking?: TrackingDTO | null;
};

const fmt = (n: number | undefined) =>
    n === undefined ? "—" : n.toFixed(3);

export function PerformanceOverlay({ metrics, visible, debug, tracking }: Props) {
    if (!visible || !metrics) return null;

    const formatDuration = (ms: number): string => {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${minutes}:${secs.toString().padStart(2, "0")}`;
    };

    const getFpsColor = (fps: number): string => {
        if (fps >= 25) return "#22c55e";
        if (fps >= 15) return "#eab308";
        return "#ef4444";
    };

    // F14 — derive debug fields from the current tracking sample.
    // MediaPipe Tasks Vision does not expose per-landmark confidence scores, only
    // per-detection handedness category scores for hands. The HUD reports what is
    // actually available rather than fabricating confidence numbers.
    const nose = tracking?.face?.faces?.[0]?.landmarks?.[1];     // index 1 = nose tip
    const hands = tracking?.hand?.hands ?? [];
    const findHand = (side: "Left" | "Right") => hands.find(h => h.handedness === side);
    const leftHand = findHand("Left");
    const rightHand = findHand("Right");
    const otherHand = hands.find(h => h.handedness === "Unknown" || h.handedness === undefined);
    // F12 — the strongest-firing blendshape is the one that reads as mimicry.
    const face = tracking?.face?.faces[0];
    const topBlendshape = face?.blendshapes?.reduce(
        (best, c) => (best === undefined || c.score > best.score ? c : best),
        undefined as { categoryName: string; score: number } | undefined,
    );

    return (
        <div style={styles.container}>
            <div style={styles.header}>
                Performance Metrics
                {!metrics.warmupComplete && (
                    <span style={styles.warmup}> (Warmup...)</span>
                )}
            </div>

            <div style={styles.section}>
                <div style={styles.sectionTitle}>Frame Rate</div>
                <div style={styles.row}>
                    <span>FPS:</span>
                    <span style={{ ...styles.value, color: getFpsColor(metrics.fps) }}>
                        {metrics.fps}
                    </span>
                </div>
                <div style={styles.row}>
                    <span>Avg FPS:</span>
                    <span style={styles.value}>{metrics.avgFps}</span>
                </div>
                <div style={styles.row}>
                    <span>Min/Max:</span>
                    <span style={styles.value}>
                        {metrics.minFps ?? "-"} / {metrics.maxFps ?? "-"}
                    </span>
                </div>
            </div>

            <div style={styles.section}>
                <div style={styles.sectionTitle}>Latency</div>
                <div style={styles.row}>
                    <span>Inference:</span>
                    <span style={styles.value}>{metrics.inferenceTimeMs} ms</span>
                </div>
                <div style={styles.row}>
                    <span>Avg Inference:</span>
                    <span style={styles.value}>{metrics.avgInferenceTimeMs} ms</span>
                </div>
                <div style={styles.row}>
                    <span>Frame Total:</span>
                    <span style={styles.value}>{metrics.frameProcessingTimeMs} ms</span>
                </div>
            </div>

            <div style={styles.section}>
                <div style={styles.sectionTitle}>Resources</div>
                {metrics.memoryUsageMB !== undefined && (
                    <div style={styles.row}>
                        <span>Memory:</span>
                        <span style={styles.value}>{metrics.memoryUsageMB} MB</span>
                    </div>
                )}
                {metrics.batteryLevel !== undefined && (
                    <div style={styles.row}>
                        <span>Battery:</span>
                        <span style={styles.value}>
                            {Math.round(metrics.batteryLevel * 100)}%
                            {metrics.batteryCharging ? " (charging)" : ""}
                        </span>
                    </div>
                )}
            </div>

            <div style={styles.section}>
                <div style={styles.sectionTitle}>Session</div>
                <div style={styles.row}>
                    <span>Duration:</span>
                    <span style={styles.value}>
                        {formatDuration(metrics.sessionDurationMs)}
                    </span>
                </div>
                <div style={styles.row}>
                    <span>Frames:</span>
                    <span style={styles.value}>{metrics.frameCount}</span>
                </div>
                <div style={styles.row}>
                    <span>Dropped:</span>
                    <span style={styles.value}>{metrics.droppedFrames}</span>
                </div>
                <div style={styles.row}>
                    <span>Tracking Lost:</span>
                    <span style={styles.value}>{metrics.trackingLostCount}</span>
                </div>
            </div>

            {debug && (
                <div style={styles.section}>
                    <div style={styles.sectionTitle}>Debug (F14)</div>
                    <div style={styles.row}>
                        <span>FACE:</span>
                        <span style={styles.value}>
                            {nose ? "tracking" : "lost"}
                        </span>
                    </div>
                    {nose && (
                        <div style={styles.row}>
                            <span>Nose:</span>
                            <span style={styles.value}>
                                ({fmt(nose.x)}, {fmt(nose.y)}, {fmt(nose.z)})
                            </span>
                        </div>
                    )}
                    <div style={styles.row}>
                        <span>HAND L:</span>
                        <span style={styles.value}>{leftHand ? "tracking" : "lost"}</span>
                    </div>
                    {leftHand?.landmarks?.[0] && (
                        <div style={styles.row}>
                            <span>L Wrist:</span>
                            <span style={styles.value}>
                                ({fmt(leftHand.landmarks[0].x)}, {fmt(leftHand.landmarks[0].y)}, {fmt(leftHand.landmarks[0].z)})
                            </span>
                        </div>
                    )}
                    <div style={styles.row}>
                        <span>HAND R:</span>
                        <span style={styles.value}>{rightHand ? "tracking" : "lost"}</span>
                    </div>
                    {rightHand?.landmarks?.[0] && (
                        <div style={styles.row}>
                            <span>R Wrist:</span>
                            <span style={styles.value}>
                                ({fmt(rightHand.landmarks[0].x)}, {fmt(rightHand.landmarks[0].y)}, {fmt(rightHand.landmarks[0].z)})
                            </span>
                        </div>
                    )}
                    {otherHand?.landmarks?.[0] && (
                        <div style={styles.row}>
                            <span>HAND ?:</span>
                            <span style={styles.value}>
                                ({fmt(otherHand.landmarks[0].x)}, {fmt(otherHand.landmarks[0].y)})
                            </span>
                        </div>
                    )}
                    {/* F12/F13 — both are computed on every frame but were not
                        shown anywhere, so neither feature was demonstrable in the
                        PWA while the native app displayed both. */}
                    <div style={styles.row}>
                        <span>BLENDSHAPES:</span>
                        <span style={styles.value}>
                            {face?.blendshapes ? face.blendshapes.length : "—"}
                        </span>
                    </div>
                    {topBlendshape && (
                        <div style={styles.row}>
                            <span>TOP:</span>
                            <span style={styles.value}>
                                {topBlendshape.categoryName} {(topBlendshape.score * 100).toFixed(0)}%
                            </span>
                        </div>
                    )}
                    {hands.map((hand, i) => (
                        <div key={i} style={styles.row}>
                            <span>GESTURE {hand.handedness ?? "?"}:</span>
                            <span style={styles.value}>
                                {hand.gesture ?? "keine"}
                                {hand.gestureScore !== undefined
                                    ? ` ${(hand.gestureScore * 100).toFixed(0)}%`
                                    : ""}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    container: {
        position: "absolute",
        top: 8,
        right: 8,
        backgroundColor: "rgba(0, 0, 0, 0.75)",
        color: "#e5e7eb",
        padding: 12,
        borderRadius: 8,
        fontSize: 12,
        fontFamily: "monospace",
        minWidth: 180,
        zIndex: 100,
    },
    header: {
        fontWeight: "bold",
        marginBottom: 8,
        fontSize: 13,
        borderBottom: "1px solid #374151",
        paddingBottom: 6,
    },
    warmup: {
        color: "#eab308",
        fontWeight: "normal",
        fontSize: 11,
    },
    section: {
        marginBottom: 8,
    },
    sectionTitle: {
        color: "#9ca3af",
        fontSize: 10,
        textTransform: "uppercase",
        marginBottom: 4,
    },
    row: {
        display: "flex",
        justifyContent: "space-between",
        marginBottom: 2,
    },
    value: {
        fontWeight: "bold",
    },
};
