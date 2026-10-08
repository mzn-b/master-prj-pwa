import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { ConsentGate } from "../ConsentGate";
import { CONSENT_SECTIONS, CONSENT_TITLE, consentIsIncomplete } from "../consentText";

afterEach(cleanup);

/**
 * The consent gate is the one component where a bug has consequences outside the
 * repository: it stands between a participant and a camera. These tests check
 * the two properties that matter — that nothing starts without an explicit
 * action, and that an unfinished notice cannot be accepted.
 */
describe("ConsentGate", () => {
    it("shows the notice and every section before anything else happens", () => {
        render(<ConsentGate onAccept={() => {}} />);
        expect(screen.getByText(CONSENT_TITLE)).toBeTruthy();
        for (const section of CONSENT_SECTIONS) {
            expect(screen.getByText(section.heading)).toBeTruthy();
        }
    });

    it("does not call onAccept until the participant acts", () => {
        const onAccept = vi.fn();
        render(<ConsentGate onAccept={onAccept} />);
        expect(onAccept).not.toHaveBeenCalled();
    });

    it("calls onAccept exactly once when consent is given", () => {
        const onAccept = vi.fn();
        render(<ConsentGate onAccept={onAccept} />);
        // Guarded: if the notice were incomplete there would be no button, and a
        // silent no-op here would look like a passing test.
        expect(consentIsIncomplete()).toBe(false);
        fireEvent.click(screen.getByText(/Ich stimme zu/));
        expect(onAccept).toHaveBeenCalledTimes(1);
    });

    it("declining replaces the notice and never calls onAccept", () => {
        const onAccept = vi.fn();
        render(<ConsentGate onAccept={onAccept} />);
        fireEvent.click(screen.getByText("Ablehnen"));
        expect(onAccept).not.toHaveBeenCalled();
        expect(screen.queryByText(CONSENT_TITLE)).toBeNull();
        expect(screen.getByText(/ohne Einwilligung werden keine Daten verarbeitet/)).toBeTruthy();
    });

    it("names the controller, which Art. 13 requires", () => {
        render(<ConsentGate onAccept={() => {}} />);
        expect(screen.getByText(/Verantwortlich für die Verarbeitung/)).toBeTruthy();
        expect(screen.getByText(/FH Campus Wien/)).toBeTruthy();
    });

    it("states that the camera image never leaves the device", () => {
        render(<ConsentGate onAccept={() => {}} />);
        expect(screen.getByText(/verlässt das Gerät zu keinem Zeitpunkt/)).toBeTruthy();
    });
});
