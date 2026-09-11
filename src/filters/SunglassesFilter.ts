import type {TrackingDTO} from '../domain/tracking.dto'
import {projectNormalized, type ViewGeometry} from '../render/coordinates'

const LEFT_EYE_OUTER = 33
const RIGHT_EYE_OUTER = 263

export class SunglassesFilter {
    private img: HTMLImageElement | null = null
    private loaded = false

    constructor() {
        this.img = new Image()
        this.img.onload = () => {
            this.loaded = true
        }
        this.img.src = '/filters/sunglasses.png'
    }

    render(ctx: CanvasRenderingContext2D, tracking: TrackingDTO, geometry: ViewGeometry): void {
        if (!this.loaded || !this.img) return
        const face = tracking.face?.faces[0]
        if (!face || face.landmarks.length === 0) return

        const lms = face.landmarks
        const l = lms[LEFT_EYE_OUTER]
        const r = lms[RIGHT_EYE_OUTER]
        if (!l || !r) return

        // Mirroring and object-fit come from the shared projection — see
        // src/render/coordinates.ts. Nothing here re-derives them.
        const left = projectNormalized(l.x, l.y, geometry)
        const right = projectNormalized(r.x, r.y, geometry)
        const lx = left.x
        const ly = left.y
        const rx = right.x
        const ry = right.y

        // Under selfie mirroring lx (lm[33]) is right-of-display and rx (lm[263])
        // is left-of-display. Measuring left-of-display → right-of-display keeps
        // the angle near zero for a level head instead of rotating the image 180°.
        const dx = lx - rx
        const dy = ly - ry
        const angle = Math.atan2(dy, dx)
        const dist = Math.hypot(dx, dy)

        const imgW = this.img.naturalWidth || 1
        const imgH = this.img.naturalHeight || 1
        const drawW = dist * 1.5
        const drawH = drawW * (imgH / imgW)

        const cx = (lx + rx) / 2
        const cy = (ly + ry) / 2

        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(angle)
        ctx.drawImage(this.img, -drawW / 2, -drawH / 2, drawW, drawH)
        ctx.restore()
    }
}
