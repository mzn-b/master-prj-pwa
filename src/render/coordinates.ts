/**
 * The single implementation of the normalized-landmark to view-pixel transform.
 *
 * MediaPipe emits image-normalized coordinates (x, y in 0..1, origin top-left)
 * in the camera frame's own orientation. Turning those into overlay pixels needs
 * three steps, always in this order:
 *
 *     viewPoint = fit( mirror( rotate( normalizedPoint ) ) )
 *
 * Every overlay — landmark dots, the 2D filters, the 3D crown — must use this
 * module. Each of them used to re-derive its own `1 - x` mirroring and its own
 * pixel mapping, which had two consequences:
 *
 *   - the overlays could disagree about where a face was, because a fix applied
 *     to one of them did not reach the others;
 *   - none of them accounted for `object-fit: cover`, so as soon as the preview
 *     box stopped matching the camera's aspect ratio every landmark was placed
 *     at the wrong pixel.
 *
 * This is a port of `master-prj-native-2/src/render/coordinates.ts`. It is kept
 * deliberately line-for-line comparable with that file so the two apps can be
 * shown to place landmarks identically — the measurement in the thesis compares
 * the platforms, not two different projections.
 */

/**
 * Clockwise rotation applied to the camera frame before display.
 *
 * Always 0 in a browser: `getUserMedia` hands over frames already upright, and
 * the rotation is applied by the capture stack rather than by us. The field is
 * kept so this module stays identical to the native copy, where the camera
 * delivers frames in sensor orientation and the rotation is ours to apply.
 */
export type Rotation = 0 | 90 | 180 | 270;

export interface ViewGeometry {
  /** Camera frame size in sensor orientation, before rotation (`video.videoWidth/Height`). */
  frameWidth: number;
  frameHeight: number;
  /** Preview box size in CSS pixels (`video.clientWidth/Height`). */
  viewWidth: number;
  viewHeight: number;
  /** Clockwise rotation applied to the frame before display. */
  rotation: Rotation;
  /** Selfie mirroring, applied after rotation. */
  mirrorX: boolean;
  /** How the frame is fitted into the preview box — matches the video's `object-fit`. */
  resizeMode: "cover" | "contain";
}

export interface Point2D {
  x: number;
  y: number;
}

/** Rotate a normalized point clockwise within the unit square. */
function rotateNormalized(x: number, y: number, rotation: Rotation): Point2D {
  switch (rotation) {
    case 90:
      return { x: 1 - y, y: x };
    case 180:
      return { x: 1 - x, y: 1 - y };
    case 270:
      return { x: y, y: 1 - x };
    default:
      return { x, y };
  }
}

export function projectNormalized(x: number, y: number, g: ViewGeometry): Point2D {
  const rotated = rotateNormalized(x, y, g.rotation);
  const nx = g.mirrorX ? 1 - rotated.x : rotated.x;
  const ny = rotated.y;

  // A quarter turn swaps which frame axis maps to the view's width.
  const quarterTurn = g.rotation === 90 || g.rotation === 270;
  const frameW = quarterTurn ? g.frameHeight : g.frameWidth;
  const frameH = quarterTurn ? g.frameWidth : g.frameHeight;

  const scaleX = g.viewWidth / frameW;
  const scaleY = g.viewHeight / frameH;
  const scale = g.resizeMode === "cover" ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);

  const drawnWidth = frameW * scale;
  const drawnHeight = frameH * scale;
  const offsetX = (g.viewWidth - drawnWidth) / 2;
  const offsetY = (g.viewHeight - drawnHeight) / 2;

  return { x: offsetX + nx * drawnWidth, y: offsetY + ny * drawnHeight };
}

export function projectPoint(p: Point2D, g: ViewGeometry): Point2D {
  return projectNormalized(p.x, p.y, g);
}

/**
 * Geometry for the live preview.
 *
 * Falls back to the display box when the stream has not reported its intrinsic
 * size yet (`videoWidth` is 0 until the first frame decodes), which degrades to
 * a plain stretch for those first few frames rather than dividing by zero.
 */
export function viewGeometryFromVideo(
  video: HTMLVideoElement,
  viewWidth: number,
  viewHeight: number,
  mirrorX = true,
): ViewGeometry {
  return {
    frameWidth: video.videoWidth || viewWidth || 1,
    frameHeight: video.videoHeight || viewHeight || 1,
    viewWidth,
    viewHeight,
    rotation: 0,
    mirrorX,
    resizeMode: "cover",
  };
}

/** Geometry that maps straight through, for tests and for overlays with no camera yet. */
export const IDENTITY_GEOMETRY: ViewGeometry = {
  frameWidth: 1,
  frameHeight: 1,
  viewWidth: 1,
  viewHeight: 1,
  rotation: 0,
  mirrorX: false,
  resizeMode: "cover",
};
