import * as THREE from 'three';
import { buildScene } from './scene.js';
import { FirstPersonController } from './controller.js';

const MAX_DT = 1 / 30;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 1000);

const world = buildScene(scene) || {};
const controller = new FirstPersonController(camera, renderer.domElement, {
  colliders: world.colliders ?? [],
  spawn: world.spawn ?? new THREE.Vector3(0, 0, 0),
  spawnYaw: world.spawnYaw ?? 0,
});

// ---- HUD -------------------------------------------------------------------
const overlay = document.getElementById('overlay');
const setLocked = (locked) => document.body.classList.toggle('locked', locked);
overlay.addEventListener('click', () => controller.lock());
renderer.domElement.addEventListener('click', () => controller.lock());
controller.addEventListener('lock', () => setLocked(true));
controller.addEventListener('unlock', () => setLocked(false));
document.body.classList.add('ready');

// ---- resize ----------------------------------------------------------------
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);

// ---- loop ------------------------------------------------------------------
let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, MAX_DT);
  last = now;
  controller.update(dt);
  renderer.render(scene, camera);
});

// Handy for poking at things from the devtools console.
window.footfall = { scene, camera, renderer, controller, world };
