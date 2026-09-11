# master-prj-pwa

Progressive Web App half of the master's thesis comparison "PWAs vs Native AR Filters". Real-time face and hand tracking via MediaPipe Tasks Vision (WASM + WebGL/WebGPU), three demo filters (3D crown, 2D sunglasses, particle sparkles), and a metrics-submission flow to the shared Spring Boot backend.

See `../ARCHITECTURE.md` for system-level architecture, data model, and measurement methodology.

## Prerequisites

- Node.js ≥ 22.12 (required by Vite 8)
- A browser with camera access — Chrome/Edge are preferred (Battery Status API, Compute Pressure API).
- HTTPS required by `getUserMedia()` — Vite serves `localhost` over HTTPS via `@vitejs/plugin-basic-ssl` (already configured in `vite.config.ts`). On first run, accept the self-signed certificate prompt.

## Install

```bash
npm install
```

## Run

```bash
npm run dev      # starts Vite dev server on https://localhost:5173
npm run build    # type-check + production build to dist/
npm run preview  # serve the built bundle locally
npm run lint     # ESLint
npm test         # Vitest
npm run sync-wasm # re-copy the MediaPipe WASM bundle out of node_modules
```

## Where things live

```
src/
  domain/tracking.dto.ts         — shared DTO (synced with native + backend)
  tracking/
    TrackingController.ts        — MediaPipe lifecycle, per-frame inference
    PerformanceTracker.ts        — FPS / latency / memory metrics
    LandmarkSmoother.ts          — One Euro Filter
    TrackingConfig.ts            — capability checks, dynamic inference rate
  rendering/
    WebGLRenderer.ts, WebGPURenderer.ts, createRenderer.ts
    overlays/LandmarkOverlay.ts  — landmark dot rendering
  filters/                       — Crown (Three.js), Sunglasses (2D), Sparkles (particles)
  render/coordinates.ts          — the one normalized-landmark → view-pixel transform
  hooks/useCamera.ts             — MediaStream lifecycle
  screens/CameraScreen.tsx       — top-level UI
  ui/PerformanceOverlay.tsx      — HUD
  api/trackingApi.ts             — POST /api/tracking/sessions
public/
  mediapipe/
    models/face_landmarker.task
    models/gesture_recognizer.task  — F13 GestureRecognizer model (HandLandmarker superset)
    wasm/                        — MediaPipe Tasks Vision WASM bundle (npm run sync-wasm)
  filters/crown.glb              — 3D model for the crown filter
```

## Model files

Both `.task` files are committed under `public/mediapipe/models/` and are
byte-identical to the ones the native app ships (`face_landmarker.task`,
`gesture_recognizer.task` — the float16 GestureRecognizer, a HandLandmarker
superset that also gives F13 its gesture labels). Same weights on both
platforms is a precondition for NF4: the comparison measures the runtimes, not
two different models.

If a model ever has to be replaced, take it from the MediaPipe model garden and
copy the same file into `../master-prj-native-2/modules/tracking-native/assets/`.

The WASM bundle under `public/mediapipe/wasm/` is *not* hand-copied — run
`npm run sync-wasm` after changing the `@mediapipe/tasks-vision` version. The
loader `.js` and the `.wasm` binary must come from the same release, and copying
them by hand meant a version bump could silently leave the old pair in place.

## Configuration

The backend URL comes from `VITE_API_BASE_URL` (see `.env`), falling back to
`http://localhost:8080`. There is no hardcoded URL in `src/api/trackingApi.ts`.

The UX feedback survey URL is read from `VITE_UX_SURVEY_URL` (see `.env`); see the post-session UI in `CameraScreen.tsx` for where the button is wired in.

### Sessions are only submitted from mobile browsers

`detectPlatform()` maps the user agent to `IOS_PWA` or `ANDROID_PWA`. A desktop
browser matches neither — the backend's `Platform` enum has no value for it — so
the session is **not** submitted and the status line says so. Running the app on
a laptop is fine for development; it just will not pollute the dataset.

## PWA install

The app is installable as a PWA (manifest + service worker via `vite-plugin-pwa`). When served over HTTPS with a valid certificate, browsers will offer an "Install" prompt. Service-worker precaches the MediaPipe WASM and `.task` model files so the app can run offline after first load.

## Running comparison benchmarks

1. Start the backend (`docker compose up` in `../master-prj-backend`).
2. Set `VITE_API_BASE_URL=http://localhost:8080` in `.env` for local testing.
3. `npm run dev`, open the app on a **phone** via the LAN URL Vite prints —
   a desktop browser will not submit anything (see Configuration above).
4. Pick a tracking mode (face / hand / combined), enable any filters, press **Start**.
5. After ~60 s, press **Stop** — metrics submit automatically.
6. Inspect rows in PostgreSQL: `SELECT * FROM tracking_sessions ORDER BY recorded_at DESC LIMIT 5;`
