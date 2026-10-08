import { useState } from "react";
import { color, s } from "./theme";
import {
    CONSENT_ACCEPT,
    CONSENT_CONTROLLER,
    CONSENT_DECLINE,
    CONSENT_DECLINED_MESSAGE,
    CONSENT_INTRO,
    CONSENT_SECTIONS,
    CONSENT_TITLE,
    consentIsIncomplete,
} from "./consentText";

/**
 * Blocks the app until the participant has consented.
 *
 * Consent has to precede processing, so this covers the whole screen and the
 * camera cannot be started behind it.
 *
 * **Deliberately not persisted.** Sessions are supervised individually and
 * several participants use the same device, so remembering a previous person's
 * decision would mean the next one never consents at all. Every launch or
 * reload asks again.
 */
export interface ConsentGateProps {
    onAccept: () => void;
}

export function ConsentGate({ onAccept }: ConsentGateProps) {
    const [declined, setDeclined] = useState(false);
    const incomplete = consentIsIncomplete();

    if (declined) {
        return (
            <div style={{ ...s.root, padding: 24, justifyContent: "center" }}>
                <p style={{ ...s.status, fontSize: 16, lineHeight: 1.5 }}>
                    {CONSENT_DECLINED_MESSAGE}
                </p>
            </div>
        );
    }

    return (
        <div style={{ ...s.root, overflow: "auto" }}>
            <div
                style={{
                    padding: 20,
                    display: "flex",
                    flexDirection: "column",
                    gap: 14,
                    maxWidth: 680,
                    margin: "0 auto",
                }}
            >
                <h1 style={{ margin: 0, fontSize: 22, color: color.text }}>{CONSENT_TITLE}</h1>

                <p style={{ ...s.status, fontSize: 15, lineHeight: 1.5, margin: 0 }}>
                    {CONSENT_INTRO}
                </p>

                {CONSENT_SECTIONS.map(section => (
                    <section key={section.heading} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <h2 style={{ margin: 0, fontSize: 15, color: color.text }}>{section.heading}</h2>
                        <p style={{ ...s.status, fontSize: 14, lineHeight: 1.5, margin: 0 }}>
                            {section.body}
                        </p>
                    </section>
                ))}

                <section style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <h2 style={{ margin: 0, fontSize: 15, color: color.text }}>
                        {CONSENT_CONTROLLER.heading}
                    </h2>
                    <p
                        style={{
                            ...s.status,
                            fontSize: 14,
                            lineHeight: 1.5,
                            margin: 0,
                            whiteSpace: "pre-line",
                        }}
                    >
                        {CONSENT_CONTROLLER.body}
                    </p>
                </section>

                {incomplete ? (
                    // A notice that still names no controller does not inform anyone,
                    // so the app refuses to proceed rather than collecting consent
                    // against placeholder text.
                    <div style={{ ...s.error, fontSize: 15, lineHeight: 1.5 }}>
                        Diese Einwilligungserklärung ist noch unvollständig (siehe
                        „TODO“ oben) und darf nicht verwendet werden. Bitte die
                        Kontaktdaten in <code>src/ui/consentText.ts</code> ergänzen.
                    </div>
                ) : (
                    <div style={{ ...s.controlRow, paddingTop: 4, paddingBottom: 24 }}>
                        <button
                            onClick={onAccept}
                            style={{ ...s.button, background: color.primary }}
                        >
                            {CONSENT_ACCEPT}
                        </button>
                        <button
                            onClick={() => setDeclined(true)}
                            style={{ ...s.button, background: color.muted }}
                        >
                            {CONSENT_DECLINE}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
