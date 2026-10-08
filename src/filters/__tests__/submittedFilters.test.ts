import { describe, expect, it } from "vitest";
import { submittedFilters } from "../types";
import type { ActiveFilters } from "../types";

/**
 * NF4 / data integrity — a session must report the filters it actually drew.
 *
 * Ported from the native app, which carried the same defect: `appMode` gates
 * rendering (landmarks mode never mounts the filter overlay) while the filter
 * selection is independent state that survives a mode switch, so submission
 * read a selection that was not on screen. Two native sessions on 2026-10-08
 * were recorded as `['crown']` while drawing only landmarks.
 *
 * Because filters mode forces the tracking mode to `combined`, any FACE or HAND
 * row carrying filters is provably spurious — which is how the damage to the
 * existing data was bounded.
 */
const CROWN_ONLY: ActiveFilters = { crown: true, glasses: false, sparkles: false };
const ALL: ActiveFilters = { crown: true, glasses: true, sparkles: true };
const NONE: ActiveFilters = { crown: false, glasses: false, sparkles: false };

describe("submittedFilters", () => {
    it("reports the selected filters in filters mode", () => {
        expect(submittedFilters("filters", ALL)).toEqual(["crown", "glasses", "sparkles"]);
        expect(submittedFilters("filters", CROWN_ONLY)).toEqual(["crown"]);
    });

    it("reports nothing in landmarks mode, whatever the selection holds", () => {
        expect(submittedFilters("landmarks", CROWN_ONLY)).toEqual([]);
        expect(submittedFilters("landmarks", ALL)).toEqual([]);
    });

    it("reports nothing when nothing is selected", () => {
        expect(submittedFilters("filters", NONE)).toEqual([]);
        expect(submittedFilters("landmarks", NONE)).toEqual([]);
    });
});
