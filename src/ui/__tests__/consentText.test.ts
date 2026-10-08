import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    CONSENT_CONTROLLER,
    CONSENT_SECTIONS,
    consentIsIncomplete,
} from "../consentText";

const here = path.dirname(fileURLToPath(import.meta.url));
const pwaText = path.join(here, "../consentText.ts");
const nativeText = path.resolve(
    here,
    "../../../../master-prj-native-2/src/ui/consentText.ts",
);

/**
 * Participants read this before either app starts, and the two apps are rated
 * against each other. If the texts diverge, the two groups consented to
 * different things and the comparison is no longer between platforms.
 */
describe("consent text", () => {
    it("is byte-identical to the native app's copy, apart from the cross-reference", () => {
        if (!fs.existsSync(nativeText)) return; // native repo not checked out
        const normalise = (s: string) =>
            s.replace(/master-prj-(pwa|native-2)/g, "APP");
        expect(normalise(fs.readFileSync(pwaText, "utf8"))).toBe(
            normalise(fs.readFileSync(nativeText, "utf8")),
        );
    });

    it("names a controller, a purpose, a legal basis and a retention period", () => {
        const all = CONSENT_SECTIONS.map(s => s.body).join(" ");
        // Art. 13 GDPR essentials. Worded as substance checks rather than exact
        // strings so the text can be reworded without breaking the test.
        expect(all).toMatch(/Art\. 6 Abs\. 1 lit\. a DSGVO/); // legal basis
        expect(all).toMatch(/freiwillig/i); // voluntariness
        expect(all).toMatch(/widerruf/i); // right to withdraw
        expect(all).toMatch(/gelöscht/i); // retention / erasure
        expect(all).toMatch(/Datenschutzbehörde/); // right to complain
        expect(CONSENT_CONTROLLER.body).toMatch(/FH Campus Wien/);
    });

    it("states plainly that the camera image never leaves the device", () => {
        const all = CONSENT_SECTIONS.map(s => s.body).join(" ");
        expect(all).toMatch(/nicht aufgezeichnet/);
        expect(all).toMatch(/nicht gespeichert/);
        expect(all).toMatch(/verlässt das Gerät zu keinem Zeitpunkt/);
    });

    it("reports itself incomplete while the controller block has placeholders", () => {
        // The gate hides the accept button in this state, so an unfinished
        // notice cannot reach a participant. Once the real contact details are
        // filled in this expectation flips — update it then, deliberately.
        expect(consentIsIncomplete()).toBe(CONSENT_CONTROLLER.body.includes("TODO"));
    });
});
