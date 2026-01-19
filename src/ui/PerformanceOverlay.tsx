import type { PerformanceMetricsDTO } from "../domain/tracking.dto";

type Props = {
    metrics: PerformanceMetricsDTO | null;
    visible: boolean;
};

export function PerformanceOverlay({ metrics, visible }: Props) {
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
                        {metrics.minFps} / {metrics.maxFps}
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
