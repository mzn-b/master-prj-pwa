import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CONSENT_ACCEPT, CONSENT_DECLINE } from "../ui/consentText";

/**
 * Consent gates the whole app: the camera screen, and with it the camera, is
 * not even mounted until the participant agrees. The screen itself is a
 * stand-in.
 */
vi.mock("../screens/CameraScreen.tsx", () => ({ CameraScreen: () => <div>camera screen</div> }));

import App from "../App";

afterEach(cleanup);

describe("App", () => {
    it("mounts the camera screen only after consent", () => {
        render(<App />);
        expect(screen.queryByText("camera screen")).toBeNull();
        fireEvent.click(screen.getByText(CONSENT_ACCEPT));
        expect(screen.getByText("camera screen")).toBeTruthy();
    });

    it("never mounts it after a refusal", () => {
        render(<App />);
        fireEvent.click(screen.getByText(CONSENT_DECLINE));
        expect(screen.queryByText("camera screen")).toBeNull();
        expect(screen.queryByText(CONSENT_ACCEPT)).toBeNull();
    });
});
