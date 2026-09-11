import type { PerformanceMetricsDTO, TrackingDTO } from "../domain/tracking.dto";
import { color, s } from "./theme";

/**
 * F8 + F14 — the metrics card and the debug card, overlaid on the preview.
 *
 * Deliberately a transcription of the native app's `PerformanceHud` and
 * `DebugHud`: same two cards, same rows, same labels, same number formatting.
 * The UX questionnaire rates the two apps against each other, so a richer or
 * differently-styled HUD on one side would be scored as a product difference
 * rather than a platform one. Change both together or neither.
 */
interface Props {
    metrics: PerformanceMetricsDTO | null;
    visible: boolean;
    debug: boolean;
    tracking: TrackingDTO | null;
    currentFrameSkip: number;
}

/** MediaPipe face-mesh indices, matching the native DebugHud. */
const NOSE_TIP = 1;
const WRIST = 0;

function Row({ label, value }: { label: string; value: string }) {
    return (
        <div style={s.hudRow}>
            <span style={s.hudLabel}>{label}</span>
            <span style={s.hudValue}>{value}</span>
        </div>
    );
}

/** `—` for a missing reading, so an absent metric never reads as zero. */
function optional(value: number | undefined | null, suffix: string, digits: number): string {
    return value === undefined || value === null ? "—" : `${value.toFixed(digits)}${suffix}`;
}

export function PerformanceOverlay({ metrics, visible, debug, tracking, currentFrameSkip }: Props) {
    const face = tracking?.face?.faces[0];
    const nose = face?.landmarks[NOSE_TIP];
    const hands = tracking?.hand?.hands ?? [];

    return (
        <>
            {visible && metrics && (
                <div style={s.hudCard} data-testid="performance-hud">
                    <Row
                        label="FPS"
                        value={`${metrics.fps.toFixed(1)} (Ø ${metrics.avgFps.toFixed(1)})`}
                    />
                    <Row label="Inferenz" value={`${metrics.avgInferenceTimeMs.toFixed(1)} ms`} />
                    <Row label="Frame" value={`${metrics.avgFrameProcessingTimeMs.toFixed(1)} ms`} />
                    <Row
                        label="Frames"
                        value={`${metrics.frameCount} (${metrics.droppedFrames} verworfen)`}
                    />
                    <Row label="Speicher" value={optional(metrics.memoryUsageMB, " MB", 1)} />
                    <Row label="CPU" value={optional(metrics.cpuUsagePercent, " %", 0)} />
                    <Row label="Thermal" value={metrics.thermalState ?? "—"} />
                    <Row label="Akku" value={optional(metrics.batteryLevel, " %", 0)} />
                    <Row label="Frame-Skip" value={`${currentFrameSkip}`} />
                    <Row label="Warmup" value={metrics.warmupComplete ? "fertig" : "läuft"} />
                </div>
            )}

            {debug && (
                <div style={s.hudCard} data-testid="debug-hud">
                    <div style={{ ...s.hudLabel, fontWeight: 700 }}>Debug</div>
                    <div style={{ color: color.value, fontSize: 12 }}>
                        Gesicht: {face ? "erkannt" : "nicht erkannt"}
                        {nose ? `  Nase (${nose.x.toFixed(3)}, ${nose.y.toFixed(3)})` : ""}
                    </div>
                    <div style={{ color: color.value, fontSize: 12 }}>
                        Blendshapes: {face?.blendshapes ? `${face.blendshapes.length}` : "—"}
                    </div>
                    <div style={{ color: color.value, fontSize: 12 }}>Hände: {hands.length}</div>
                    {hands.map((hand, index) => {
                        const wrist = hand.landmarks[WRIST];
                        return (
                            <div key={index} style={{ color: color.value, fontSize: 12 }}>
                                {hand.handedness ?? "Unknown"} · Wrist (
                                {wrist ? `${wrist.x.toFixed(3)}, ${wrist.y.toFixed(3)}` : "—"}) ·{" "}
                                {hand.gesture ?? "keine Geste"}
                                {hand.gestureScore !== undefined
                                    ? ` ${(hand.gestureScore * 100).toFixed(0)}%`
                                    : ""}
                            </div>
                        );
                    })}
                </div>
            )}
        </>
    );
}
