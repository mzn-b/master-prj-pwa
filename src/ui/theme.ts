import type { CSSProperties } from "react";

/**
 * The native app's design system, transcribed for the web.
 *
 * The two apps are rated side by side in the UX questionnaire, so any visual
 * difference between them is a confound: participants would be scoring the
 * look of two designs rather than the behaviour of two platforms. Every value
 * here is copied from `master-prj-native-2/src/**` StyleSheets — when one side
 * changes, change the other in the same commit.
 *
 * Sources:
 *   colours + layout   screens/CameraScreen.tsx
 *   buttons + status   ui/SessionControls.tsx
 *   mode chips         ui/ModeSelector.tsx
 *   filter chips       ui/FilterBar.tsx
 *   settings rows      ui/SettingsSheet.tsx
 *   metrics card       ui/PerformanceHud.tsx
 */
export const color = {
    root: "#0b0b0f",
    panel: "#111827",
    /** Inactive chip / tab. */
    chip: "#374151",
    /** Primary: active chip, active tab, start button, survey button. */
    primary: "#4f46e5",
    /** Filter chip border when inactive; also the disabled button. */
    muted: "#4b5563",
    /** Filter chip fill when active. */
    filterActive: "#312e81",
    stop: "#dc2626",
    dotActive: "#22c55e",
    dotIdle: "#9ca3af",
    text: "#fff",
    textDim: "#e5e7eb",
    label: "#9ca3af",
    value: "#f9fafb",
    error: "#fca5a5",
    warning: "#fcd34d",
    /** Translucent card fills; the HUD is lighter than the settings sheet. */
    hudCard: "rgba(17,24,39,0.82)",
    settingsCard: "rgba(17,24,39,0.92)",
} as const;

/** React Native's default font stack has no web equivalent; this is the closest. */
export const fontStack =
    "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

export const s = {
    root: {
        // 100dvh, not 100vh: mobile browsers inset the dynamic toolbar, and the
        // native app has no toolbar to account for.
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        background: color.root,
        fontFamily: fontStack,
        color: color.text,
        overflow: "hidden",
    } satisfies CSSProperties,

    preview: {
        flex: 1,
        position: "relative",
        overflow: "hidden",
        minHeight: 0,
    } satisfies CSSProperties,

    placeholder: {
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: color.label,
        fontSize: 16,
    } satisfies CSSProperties,

    hudLayer: {
        position: "absolute",
        top: 12,
        left: 12,
        right: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        pointerEvents: "none",
    } satisfies CSSProperties,

    panel: {
        maxHeight: 300,
        background: color.panel,
        overflowY: "auto",
        flexShrink: 0,
    } satisfies CSSProperties,

    panelContent: {
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
    } satisfies CSSProperties,

    row: { display: "flex", flexDirection: "row", gap: 6 } satisfies CSSProperties,

    controlRow: {
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
    } satisfies CSSProperties,

    button: {
        padding: "10px 24px",
        borderRadius: 8,
        border: "none",
        color: color.text,
        fontWeight: 700,
        fontSize: 16,
        fontFamily: fontStack,
        cursor: "pointer",
    } satisfies CSSProperties,

    statusRow: {
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
    } satisfies CSSProperties,

    dot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 } satisfies CSSProperties,

    status: { color: color.textDim, fontSize: 14 } satisfies CSSProperties,

    tab: {
        padding: "6px 16px",
        borderRadius: 6,
        border: "none",
        background: color.chip,
        color: color.text,
        fontSize: 14,
        fontFamily: fontStack,
        cursor: "pointer",
    } satisfies CSSProperties,

    chip: {
        padding: "6px 14px",
        borderRadius: 6,
        border: "none",
        background: color.chip,
        color: color.text,
        fontSize: 14,
        fontFamily: fontStack,
        textTransform: "capitalize",
        cursor: "pointer",
    } satisfies CSSProperties,

    filterChip: {
        padding: "6px 14px",
        borderRadius: 6,
        borderWidth: 2,
        borderStyle: "solid",
        borderColor: color.muted,
        background: "transparent",
        color: color.text,
        fontSize: 14,
        fontFamily: fontStack,
        cursor: "pointer",
    } satisfies CSSProperties,

    settingsCard: {
        background: color.settingsCard,
        borderRadius: 8,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 6,
    } satisfies CSSProperties,

    settingsRow: {
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
    } satisfies CSSProperties,

    settingsLabel: { color: color.textDim, fontSize: 14, flexShrink: 1 } satisfies CSSProperties,

    surveyButton: {
        background: color.primary,
        borderRadius: 6,
        border: "none",
        padding: "8px 0",
        color: color.text,
        fontWeight: 600,
        fontSize: 14,
        fontFamily: fontStack,
        textAlign: "center",
        textDecoration: "none",
        display: "block",
        cursor: "pointer",
    } satisfies CSSProperties,

    hudCard: {
        background: color.hudCard,
        borderRadius: 8,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 2,
    } satisfies CSSProperties,

    hudRow: {
        display: "flex",
        flexDirection: "row",
        justifyContent: "space-between",
        gap: 16,
    } satisfies CSSProperties,

    hudLabel: { color: color.label, fontSize: 12 } satisfies CSSProperties,

    hudValue: {
        color: color.value,
        fontSize: 12,
        fontVariantNumeric: "tabular-nums",
    } satisfies CSSProperties,

    error: { color: color.error, fontSize: 14 } satisfies CSSProperties,
    warning: { color: color.warning, fontSize: 14 } satisfies CSSProperties,
} as const;
