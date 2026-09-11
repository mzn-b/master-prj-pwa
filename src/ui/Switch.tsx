import { color } from "./theme";

/**
 * A pill switch, standing in for React Native's `<Switch>`.
 *
 * The native app uses the platform control, which is a Material switch on
 * Android and a pill on iOS — so no single web control matches both exactly. A
 * checkbox matches neither and reads as an obviously different product, which
 * would show up in the UX questionnaire as a design difference rather than a
 * platform one. This is the closest neutral shape: track plus thumb, sized like
 * the platform controls, tinted with the app's own accent.
 *
 * Still a real `<input type="checkbox">` underneath, so it keeps keyboard
 * focus, the checked state and screen-reader semantics.
 */
export interface SwitchProps {
    checked: boolean;
    disabled?: boolean;
    onChange: (next: boolean) => void;
    /** Labels the control for assistive tech; the visible label sits beside it. */
    label: string;
}

const TRACK_W = 44;
const TRACK_H = 26;
const PAD = 3;
const THUMB = TRACK_H - PAD * 2;

export function Switch({ checked, disabled = false, onChange, label }: SwitchProps) {
    return (
        <span
            style={{
                position: "relative",
                width: TRACK_W,
                height: TRACK_H,
                flexShrink: 0,
                display: "inline-block",
            }}
        >
            <input
                type="checkbox"
                role="switch"
                aria-label={label}
                checked={checked}
                disabled={disabled}
                onChange={e => onChange(e.target.checked)}
                style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    margin: 0,
                    opacity: 0,
                    cursor: disabled ? "default" : "pointer",
                    zIndex: 1,
                }}
            />
            <span
                aria-hidden
                style={{
                    position: "absolute",
                    inset: 0,
                    borderRadius: TRACK_H / 2,
                    background: checked ? color.primary : color.muted,
                    transition: "background 120ms ease",
                }}
            />
            <span
                aria-hidden
                style={{
                    position: "absolute",
                    top: PAD,
                    left: checked ? TRACK_W - THUMB - PAD : PAD,
                    width: THUMB,
                    height: THUMB,
                    borderRadius: THUMB / 2,
                    background: "#fff",
                    transition: "left 120ms ease",
                }}
            />
        </span>
    );
}
