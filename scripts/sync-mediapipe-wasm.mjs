/**
 * Copies the MediaPipe Tasks Vision WASM bundle out of node_modules into
 * public/mediapipe/wasm, so the files served at runtime always match the
 * @mediapipe/tasks-vision version in package.json.
 *
 * The bundle used to be hand-copied, which meant a dependency bump silently
 * left the old WASM in place — the loader and the .wasm binary must be from
 * the same release or FilesetResolver fails at init.
 *
 * Run via `npm run sync-wasm` after changing the @mediapipe/tasks-vision version.
 */
import {createRequire} from 'node:module';
import {copyFile, mkdir, readFile, rm} from 'node:fs/promises';
import path from 'node:path';

/**
 * Only the files the app actually loads. FilesetResolver.forVisionTasks(basePath)
 * defaults to useModule = false, so it asks for `vision_wasm_internal.*`, falling
 * back to `vision_wasm_nosimd_internal.*` where SIMD is unavailable. The
 * `vision_wasm_module_internal.*` pair is for the ES-module loader we do not use,
 * and copying it would add ~23 MB to the service worker's precache for nothing.
 */
const FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

const require = createRequire(import.meta.url);
// The package restricts "exports", so resolve a subpath it does publish and
// walk up from there rather than requiring ./package.json directly.
const wasmEntry = require.resolve('@mediapipe/tasks-vision/vision_wasm_internal.js');
const srcDir = path.dirname(wasmEntry);
const pkgPath = path.join(srcDir, '..', 'package.json');
const outDir = path.resolve('public/mediapipe/wasm');

const {version} = JSON.parse(await readFile(pkgPath, 'utf8'));

await rm(outDir, {recursive: true, force: true});
await mkdir(outDir, {recursive: true});
for (const file of FILES) {
  await copyFile(path.join(srcDir, file), path.join(outDir, file));
}

console.log(
  `[sync-wasm] copied ${FILES.length} files from @mediapipe/tasks-vision@${version} -> ${outDir}`,
);
