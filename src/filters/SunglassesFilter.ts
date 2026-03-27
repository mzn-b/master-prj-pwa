import type {TrackingDTO} from '../domain/tracking.dto'

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

    render(ctx: CanvasRenderingContext2D, tracking: TrackingDTO, canvasW: number, canvasH: number): void {
        if (!this.loaded || !this.img) return
        const face = tracking.face?.faces[0]
        if (!face || face.landmarks.length === 0) return

        const lms = face.landmarks
        const l = lms[LEFT_EYE_OUTER]
        const r = lms[RIGHT_EYE_OUTER]
        if (!l || !r) return

        // Video is CSS-mirrored (scaleX(-1)) but FilterOverlay is not — flip X to match display
        const lx = (1 - l.x) * canvasW
        const ly = l.y * canvasH
        const rx = (1 - r.x) * canvasW
        const ry = r.y * canvasH

        // After X-flip: lx (lm[33]) is right-of-display, rx (lm[263]) is left-of-display.
        // Compute angle from left-of-display (rx) → right-of-display (lx) so it's near zero
        // for a level head and doesn't rotate the image 180°.
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
