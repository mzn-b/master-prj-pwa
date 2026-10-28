import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Only `npm run build:survey` may produce a survey build: the flag is on for
 * exactly the string "true" from `.env.survey`, and off for a normal build.
 */
async function surveyBuildWith(value: string | undefined) {
    vi.resetModules();
    vi.stubEnv("VITE_SURVEY_BUILD", value as string);
    return (await import("../surveyBuild")).SURVEY_BUILD;
}

afterEach(() => vi.unstubAllEnvs());

describe("SURVEY_BUILD", () => {
    it("is on only for the survey mode's value", async () => {
        expect(await surveyBuildWith("true")).toBe(true);
        expect(await surveyBuildWith(undefined)).toBe(false);
        expect(await surveyBuildWith("false")).toBe(false);
        expect(await surveyBuildWith("1")).toBe(false);
    });
});
