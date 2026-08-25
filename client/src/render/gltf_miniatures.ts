/**
 * glTF MINIATURE LAYER — EVALUATION RECORD (iteration 50, Pillar 9 gap #2).
 *
 * FINDING: glTF miniatures are NOT implemented this iteration. This module is
 * the deliberate, documented "not yet" — the verified path forward lives here
 * as code so the next iteration starts from evidence instead of re-research.
 * Nothing below is wired into a render loop; importing this file executes no
 * WebGL and creates no scene.
 *
 * ── VERIFIED FACTS (researched 2026-08-25) ──────────────────────────────────
 *
 * 1. three.js GLTFLoader (r150+ through v0.185.x, current at research time):
 *    `import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'` — it is
 *    an ADDON, not core. Core usage: `new THREE.WebGLRenderer({ alpha: true,
 *    antialias: true })`, an orthographic top-down camera, `loader.loadAsync(url)`
 *    then `scene.add(gltf.scene)`. Sources: threejs.org/docs/pages/GLTFLoader.html;
 *    three.js package.json exports map (`./addons/*` → `./examples/jsm/*`).
 * 2. Bundle cost (bundlephobia API, package=three, v0.185.1): 725,907 B minified
 *    / 182,364 B gzip for CORE ALONE, before GLTFLoader (~15–25 KB more).
 * 3. The transitive three.js via @3d-dice/dice-box 1.1.4 is NOT reusable:
 *    node_modules/@3d-dice/dice-box/dist/Dice.js (1.4 MB) is a PRE-BUNDLED UMD
 *    with three.js inlined — there is no peer dependency and no export of the
 *    internal THREE namespace, so two WebGL contexts would ship two copies of
 *    three (~360 KB gzip duplicated). Verified by inspecting the installed
 *    dist bundle; dice-box's package.json declares zero runtime deps.
 * 4. Rendering .glb INTO the existing Pixi v8 board is not feasible: Pixi's
 *    scene graph is its own GPU pipeline; it cannot ingest three.js meshes or
 *    a foreign WebGL context's output without a readPixels/texture round-trip.
 *    Any miniature layer therefore means a SECOND transparent canvas stacked
 *    over/under the Pixi canvas, with viewport_sync translating cell→world.
 *
 * ── WHY NOT THIS ITERATION (scope guard) ────────────────────────────────────
 *
 *   - +182 KB gzip core on every page load that never touches miniatures
 *     (unless dynamically imported behind the flag below — still ~180 KB of
 *     new vendor chunk), against a CLAUDE.md build budget of "<15s" (current:
 *     11s). A heavyweight new runtime for an unproven visual pillar fails the
 *     iteration's own SCOPE DECISION GUARD.
 *   - No .glb assets exist anywhere in client/public — there is nothing to
 *     render, so even a perfect loader ships an empty feature today.
 *   - Two WebGL contexts (Pixi + three) doubles GPU memory and forces an
 *     explicit compositing/z-order policy that needs its own design pass.
 *
 * ── HONEST MINIMUM DELIVERED INSTEAD ────────────────────────────────────────
 *
 * The opt-in gate below (`isGltfMiniaturesEnabled`) is real and unit-tested:
 * it reads `VITE_ENABLE_GLTF_MINIATURES` exactly like VITE_PIXI_PREFERENCE
 * does, defaults OFF, and is the seam a future implementation must hang from.
 * When enabled, the intended shape is: dynamic `import('three')` +
 * `import('three/addons/loaders/GLTFLoader.js')` inside an init() that no-ops
 * when the flag is off, one transparent full-board canvas positioned by
 * TacticalCanvas, camera mapped 1:1 to pixi_board cells (cellSize 60px),
 * per-token placement from `(x+0.5)*cellSize, elevationToAudioZ(feet)*cellPx`
 * so miniatures share the SAME elevation ruler as spatial audio.
 *
 * TODO(iteration 51+): add three.js as a direct dependency, add a sample .glb
 * under client/public/miniatures/, implement GltfMiniatureLayer.init/attach/
 * dispose against this gate, and extend viewport_sync tests to cover the
 * second-canvas transform. Do not merge any loader code until all four exist.
 */

/** env.d.ts documents this flag; default OFF keeps the bundle untouched. */
export function isGltfMiniaturesEnabled(): boolean {
  return import.meta.env.VITE_ENABLE_GLTF_MINIATURES === 'true';
}
