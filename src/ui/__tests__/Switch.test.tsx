import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Switch } from "../Switch";

afterEach(cleanup);

/**
 * The pill switch stands in for React Native's `<Switch>`. It is a real
 * checkbox underneath so that keyboard focus and screen-reader semantics
 * survive the visual substitution — a plain styled `<div>` would look right and
 * be unusable.
 */
describe("Switch", () => {
    it("exposes itself as a switch with an accessible name", () => {
        render(<Switch label="F9: Glättung" checked={false} onChange={() => {}} />);
        expect(screen.getByRole("switch", { name: "F9: Glättung" })).toBeTruthy();
    });

    it("reflects the checked state rather than holding its own", () => {
        // Controlled: the parent owns the value, so the rendered state must
        // follow the prop and not drift from it.
        const { rerender } = render(<Switch label="x" checked={false} onChange={() => {}} />);
        expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(false);
        rerender(<Switch label="x" checked onChange={() => {}} />);
        expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(true);
    });

    it("reports the new value when toggled", () => {
        const onChange = vi.fn();
        render(<Switch label="x" checked={false} onChange={onChange} />);
        fireEvent.click(screen.getByRole("switch"));
        expect(onChange).toHaveBeenCalledWith(true);
    });

    it("does not fire while disabled", () => {
        // The threading toggle is disabled mid-session; a change there would
        // silently invalidate the run's recorded conditions.
        const onChange = vi.fn();
        render(<Switch label="x" checked={false} disabled onChange={onChange} />);
        fireEvent.click(screen.getByRole("switch"));
        expect(onChange).not.toHaveBeenCalled();
    });
});
