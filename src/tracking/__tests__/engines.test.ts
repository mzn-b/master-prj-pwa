import { beforeEach, describe, expect, it, vi } from "vitest";

// The main-thread engine wraps TrackingController directly. Mock it so the test
// checks what createEngine asks for, without loading MediaPipe.
const init = vi.fn();
vi.mock("../TrackingController", () => ({
    TrackingController: { init: (...args: unknown[]) => init(...args) },
}));

import { createEngine } from "../engines";

const options = (useGPU: boolean) => ({
    mode: "combined" as const,
    maxFaces: 1,
    maxHands: 2,
    useGPU,
    onResult: () => {},
    onError: () => {},
});

describe("createEngine on the main thread", () => {
    beforeEach(() => {
        init.mockReset();
        init.mockResolvedValue({ controller: {}, modelLoadTimeMs: 1, gpuDelegateUsed: false });
    });

    it.each([true, false])("passes the GPU-Delegate switch (%s) to the controller", async useGPU => {
        await createEngine("main", options(useGPU) as never);
        expect(init).toHaveBeenCalledTimes(1);
        expect(init.mock.calls[0][1]).toMatchObject({ useGPU });
    });
});
