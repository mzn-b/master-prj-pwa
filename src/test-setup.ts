/**
 * jsdom has no canvas implementation, so `getContext` logs a loud "Not implemented"
 * to the virtual console before returning null. The code under test already handles
 * a null context (WebGL probing in PerformanceTracker is best-effort); stub it so
 * the intended behaviour is exercised without the noise.
 */
HTMLCanvasElement.prototype.getContext = () => null;
