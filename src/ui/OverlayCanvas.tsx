import { useEffect, useRef } from "react";
import type { TrackingDTO } from "../domain/tracking.dto";

type Props = {
    tracking: TrackingDTO | null;
    videoEl: HTMLVideoElement | null;
};

export function OverlayCanvas({ tracking, videoEl }: Props) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !videoEl) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const w = videoEl.clientWidth;
        const h = videoEl.clientHeight;
        if (w === 0 || h === 0) return;

        if (canvas.width !== Math.floor(w) || canvas.height !== Math.floor(h)) {
            canvas.width = Math.floor(w);
            canvas.height = Math.floor(h);
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (!tracking) return;

        const faces = tracking.face?.faces ?? [];
        for (const face of faces) {
            for (const p of face.landmarks) {
                drawPoint(ctx, p.x * canvas.width, p.y * canvas.height, 2);
            }
        }

        const hands = tracking.hand?.hands ?? [];
        for (const hand of hands) {
            for (const p of hand.landmarks) {
                drawPoint(ctx, p.x * canvas.width, p.y * canvas.height, 3);
            }
        }
    }, [tracking, videoEl]);

    return (
        <canvas
            ref={canvasRef}
            style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                pointerEvents: "none",
            }}
        />
    );
}

function drawPoint(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
}
