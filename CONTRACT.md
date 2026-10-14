# footfall — build contract

Single-scene Three.js first-person controller demo. No bundler: plain ES modules + importmap,
served as static files. Three.js r170 from jsDelivr.

## Files
- `index.html`        — importmap, canvas, HUD overlay (click-to-start, controls hint). Owned by CONTROLLER agent.
- `src/main.js`       — renderer, camera, loop, wires controller + scene. Owned by CONTROLLER agent.
- `src/controller.js` — `FirstPersonController`. Owned by CONTROLLER agent.
- `src/scene.js`      — `buildScene(scene)`. Owned by SCENE agent. Must not touch other files.

## importmap (index.html)
```
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"
} }
```

## src/scene.js API (SCENE agent implements, CONTROLLER agent consumes)
```js
import * as THREE from 'three';
/**
 * Populate `scene` with the environment: ground, props, lights, sky/fog.
 * All solid geometry the player can collide with is also described as world-space AABBs.
 * @param {THREE.Scene} scene
 * @returns {{
 *   colliders: THREE.Box3[],   // world-space static boxes (ground NOT included — ground is y=0 plane)
 *   spawn: THREE.Vector3,      // player feet position at start
 *   spawnYaw: number           // radians, initial look direction
 * }}
 */
export function buildScene(scene) {}
```
- Ground is the infinite plane y = 0. Controller treats y=0 as floor everywhere.
- Colliders are axis-aligned world-space Box3. Player may stand on their tops (step/jump onto them).
- Scene must include: something to jump onto (0.5–1.0 m steps/crates), something you must crouch
  to pass under (gap ~1.2 m high, player standing eye height 1.7 m / capsule 1.8 m, crouched 1.0 m),
  and a bounding wall/fence so the player can't wander off (colliders for it too).
- Lights live in scene.js. Renderer shadow map is enabled by main.js (PCFSoftShadowMap); set
  castShadow/receiveShadow on meshes and configure the directional light's shadow camera.
- Props are procedural (three.js geometry + materials). No external asset files.

## src/controller.js API
```js
export class FirstPersonController {
  constructor(camera, domElement, { colliders, spawn, spawnYaw })
  update(dt)            // dt seconds, clamped by caller to <= 1/30
  get isLocked()        // pointer-lock state
  get isCrouching()
}
```
- Movement: WASD, Shift = crouch (hold), Space = jump (only when grounded). Pointer lock for look.
- Physics: gravity ~ -20 m/s², jump velocity ~ 7.5, walk 5 m/s, crouch 2.5 m/s, small acceleration
  smoothing. Player is an AABB (0.6 x height x 0.6); height 1.8 standing, 1.0 crouched, eye at
  height - 0.1. Crouch height lerps smoothly. Can't un-crouch if a collider is above the head.
- Collision: resolve against colliders per-axis (move X, resolve; move Z, resolve; move Y, resolve)
  so the player slides along walls and lands on box tops. Floor at y=0.

## src/main.js
- Full-window renderer, sRGB output, ACES tone mapping, shadows on, resize handling.
- `buildScene(scene)` → pass result to controller. Animation loop with clamped dt.
- HUD: overlay shown when not locked ("Click to play — WASD move · Space jump · Shift crouch").
  Small permanent corner hint when locked. Crosshair dot.

## Serving
`python3 -m http.server 5182` from the project root; `.claude/launch.json` already present.
