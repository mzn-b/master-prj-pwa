import type { TrackingDTO, NormalizedPoint, FaceLandmarksDTO, HandLandmarksDTO } from "../domain/tracking.dto";

/**
 * One Euro Filter implementation for landmark smoothing
 * Reduces visual jitter while maintaining responsiveness to quick movements
 *
 * Reference: https://cristal.univ-lille.fr/~casiez/1euro/
 */
class OneEuroFilter {
    private readonly minCutoff: number;
    private readonly beta: number;
    private readonly dCutoff: number;
    private xPrev: number | null = null;
    private dxPrev: number | null = null;
    private tPrev: number | null = null;

    constructor(minCutoff: number = 1.0, beta: number = 0.007, dCutoff: number = 1.0) {
        this.minCutoff = minCutoff;
        this.beta = beta;
        this.dCutoff = dCutoff;
    }

    private alpha(cutoff: number, dt: number): number {
        const tau = 1.0 / (2 * Math.PI * cutoff);
        return 1.0 / (1.0 + tau / dt);
    }

    filter(coord: number, t: number): number {
        if (this.xPrev === null || this.tPrev === null) {
            this.xPrev = coord;
            this.dxPrev = 0;
            this.tPrev = t;
            return coord;
        }

        const dt = t - this.tPrev;
        if (dt <= 0) return this.xPrev;


        const dx = (coord - this.xPrev) / dt;
        const edx = this.alpha(this.dCutoff, dt) * dx + (1 - this.alpha(this.dCutoff, dt)) * (this.dxPrev ?? 0);


        const cutoff = this.minCutoff + this.beta * Math.abs(edx);


        const result = this.alpha(cutoff, dt) * coord + (1 - this.alpha(cutoff, dt)) * this.xPrev;

        this.xPrev = result;
        this.dxPrev = edx;
        this.tPrev = t;

        return result;
    }
}

interface PointFilter {
    x: OneEuroFilter;
    y: OneEuroFilter;
    z: OneEuroFilter;
}

export interface SmoothingConfig {
    enabled: boolean;
    minCutoff: number;
    beta: number;
    dCutoff: number;
}

export const DEFAULT_SMOOTHING_CONFIG: SmoothingConfig = {
    enabled: true,
    minCutoff: 1.0,
    beta: 0.007,
    dCutoff: 1.0,
};

export class LandmarkSmoother {
    private config: SmoothingConfig;
    private faceFilters: Map<number, PointFilter[]> = new Map();
    private handFilters: Map<number, PointFilter[]> = new Map();

    constructor(config: SmoothingConfig = DEFAULT_SMOOTHING_CONFIG) {
        this.config = { ...config };
    }

    setConfig(config: Partial<SmoothingConfig>): void {
        this.config = { ...this.config, ...config };
        if (!this.config.enabled) {
            this.reset();
        }
    }
    reset(): void {
        this.faceFilters.clear();
        this.handFilters.clear();
    }

    smooth(tracking: TrackingDTO): TrackingDTO {
        if (!this.config.enabled) {
            return tracking;
        }

        const t = tracking.timestampMs / 1000;
        const result: TrackingDTO = {
            ...tracking,
        };


        if (tracking.face?.faces) {
            result.face = this.smoothFaces(tracking.face, t);
        }


        if (tracking.hand?.hands) {
            result.hand = this.smoothHands(tracking.hand, t);
        }

        return result;
    }

    private smoothFaces(face: FaceLandmarksDTO, t: number): FaceLandmarksDTO {
        return {
            faces: face.faces.map((f, faceIndex) => ({
                landmarks: this.smoothLandmarks(f.landmarks, t, this.faceFilters, faceIndex),
            })),
        };
    }

    private smoothHands(hand: HandLandmarksDTO, t: number): HandLandmarksDTO {
        return {
            hands: hand.hands.map((h, handIndex) => ({
                handedness: h.handedness,
                landmarks: this.smoothLandmarks(h.landmarks, t, this.handFilters, handIndex),
            })),
        };
    }

    private smoothLandmarks(
        landmarks: NormalizedPoint[],
        t: number,
        filterMap: Map<number, PointFilter[]>,
        entityIndex: number
    ): NormalizedPoint[] {

        let filters = filterMap.get(entityIndex);
        if (!filters || filters.length !== landmarks.length) {
            filters = landmarks.map(() => this.createPointFilter());
            filterMap.set(entityIndex, filters);
        }

        return landmarks.map((point, i) => {
            const filter = filters![i];
            return {
                x: filter.x.filter(point.x, t),
                y: filter.y.filter(point.y, t),
                z: point.z !== undefined ? filter.z.filter(point.z, t) : undefined,
            };
        });
    }

    private createPointFilter(): PointFilter {
        return {
            x: new OneEuroFilter(this.config.minCutoff, this.config.beta, this.config.dCutoff),
            y: new OneEuroFilter(this.config.minCutoff, this.config.beta, this.config.dCutoff),
            z: new OneEuroFilter(this.config.minCutoff, this.config.beta, this.config.dCutoff),
        };
    }
}
