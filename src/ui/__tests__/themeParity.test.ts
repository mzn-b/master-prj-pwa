import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { color } from "../theme";

const here = path.dirname(fileURLToPath(import.meta.url));
const nativeSrc = path.resolve(here, "../../../../master-prj-native-2/src");

/**
 * The PWA's palette is a transcription of the native app's StyleSheets.
 *
 * Participants rate the two apps against each other, so a visual difference
 * between them is scored as a product difference rather than a platform one.
 * `theme.ts` records where each value came from; these tests read those source
 * files and assert the values still agree, so a change on the native side that
 * is not mirrored here fails rather than quietly skewing the questionnaire.
 *
 * Skipped when the native repository is not checked out alongside this one.
 */
function nativeFile(relative: string): string | null {
    const file = path.join(nativeSrc, relative);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

const cameraScreen = nativeFile("screens/CameraScreen.tsx");
const sessionControls = nativeFile("ui/SessionControls.tsx");
const modeSelector = nativeFile("ui/ModeSelector.tsx");
const filterBar = nativeFile("ui/FilterBar.tsx");
const hud = nativeFile("ui/PerformanceHud.tsx");
const available = Boolean(cameraScreen && sessionControls && modeSelector && filterBar && hud);

describe.skipIf(!available)("palette parity with the native app", () => {
    it("uses the same app and panel backgrounds", () => {
        expect(cameraScreen).toContain(`backgroundColor: '${color.root}'`);
        expect(cameraScreen).toContain(`backgroundColor: '${color.panel}'`);
    });

    it("uses the same primary colour for the active tab, chip and start button", () => {
        // One accent across three components on the native side; if any of them
        // moves, the PWA has to move with it.
        expect(cameraScreen).toContain(color.primary); // tabActive
        expect(modeSelector).toContain(color.primary); // active mode chip
        expect(sessionControls).toContain(color.primary); // start button
        expect(filterBar).toContain(color.primary); // active filter border
    });

    it("uses the same inactive chip and disabled colours", () => {
        expect(modeSelector).toContain(color.chip);
        expect(filterBar).toContain(color.muted);
        expect(sessionControls).toContain(color.muted);
    });

    it("uses the same stop colour and status dot colours", () => {
        expect(sessionControls).toContain(color.stop);
        expect(sessionControls).toContain(color.dotActive);
        expect(sessionControls).toContain(color.dotIdle);
    });

    it("uses the same filter-chip fill when active", () => {
        expect(filterBar).toContain(color.filterActive);
    });

    it("uses the same translucent card fills for the HUD and the settings sheet", () => {
        expect(hud).toContain(color.hudCard);
        expect(nativeFile("ui/SettingsSheet.tsx")).toContain(color.settingsCard);
    });

    it("uses the same label and value colours in the metrics card", () => {
        expect(hud).toContain(color.label);
        expect(hud).toContain(color.value);
    });
});

describe.skipIf(!hud)("metrics card parity", () => {
    it("shows the same ten rows, in the same order, with the same labels", () => {
        // The HUD is what a participant looks at while forming an impression of
        // "how fast this feels", so a richer or differently-ordered HUD on one
        // side is a confound.
        const labels = [...(hud ?? "").matchAll(/label="([^"]+)"/g)].map(m => m[1]);
        expect(labels).toEqual([
            "FPS",
            "Inferenz",
            "Frame",
            "Frames",
            "Speicher",
            "CPU",
            "Thermal",
            "Akku",
            "Frame-Skip",
            "Warmup",
        ]);

        const overlay = fs.readFileSync(path.join(here, "../PerformanceOverlay.tsx"), "utf8");
        for (const label of labels) {
            expect(overlay).toContain(`label="${label}"`);
        }
    });

    it("formats a missing reading as an em dash on both sides", () => {
        const overlay = fs.readFileSync(path.join(here, "../PerformanceOverlay.tsx"), "utf8");
        // A missing metric must never read as zero — several are structurally
        // unavailable in the browser, and a zero would look like a measurement.
        expect(overlay).toContain('"—"');
        expect(hud).toContain("'—'");
    });
});
