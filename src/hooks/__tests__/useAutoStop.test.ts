import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {renderHook} from "@testing-library/react";
import {RUN_DURATION_MS, useAutoStop} from "../useAutoStop";

describe("useAutoStop", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("stops a run once, after exactly the run length", () => {
        const stop = vi.fn();
        renderHook(() => useAutoStop(true, true, stop));
        vi.advanceTimersByTime(RUN_DURATION_MS - 1);
        expect(stop).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it("does nothing when disabled (the full build) or not running", () => {
        const stop = vi.fn();
        renderHook(() => useAutoStop(true, false, stop));
        renderHook(() => useAutoStop(false, true, stop));
        vi.advanceTimersByTime(RUN_DURATION_MS * 2);
        expect(stop).not.toHaveBeenCalled();
    });

    it("does not restart the clock when the stop callback changes mid-run", () => {
        const first = vi.fn();
        const second = vi.fn();
        const {rerender} = renderHook(({stop}) => useAutoStop(true, true, stop), {
            initialProps: {stop: first},
        });
        vi.advanceTimersByTime(RUN_DURATION_MS / 2);
        rerender({stop: second});
        vi.advanceTimersByTime(RUN_DURATION_MS / 2);
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });

    it("cancels the pending stop when the run is stopped by hand", () => {
        const stop = vi.fn();
        const {rerender} = renderHook(({running}) => useAutoStop(running, true, stop), {
            initialProps: {running: true},
        });
        vi.advanceTimersByTime(10_000);
        rerender({running: false});
        vi.advanceTimersByTime(RUN_DURATION_MS);
        expect(stop).not.toHaveBeenCalled();
    });
});
