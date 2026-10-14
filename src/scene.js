import * as THREE from 'three';

/*
 * footfall — scene.js
 * A quiet dusk courtyard: flagstone plaza, a raised terrace with steps, a fountain,
 * a crate stack, a low wooden deck, and a walled "secret garden" reachable only by
 * crouching through a low stone gate.
 *
 * Coordinates: +X east (right), -Z north (forward from spawn), Y up. Units are metres.
 *
 *   z=-15 +----+------------------------------------------------------+   NORTH (iron railing on low wall,
 *         |    |       TERRACE  x[-4,9] z[-14.75,-10.5] top 1.2       |    pillars every 7.5 m)
 *         |  G |   pine(-2.6,-12.8)  bench(2.5,-14)  lamp(8.2,-14)     |
 *         |  A |  planter  [steps x0..5: 0.8 / 0.4]  planter          |
 *         |  R |                                                      |
 *         |  D |  pine(-6.8,-6.5)           tree(7.2,-5.8)   DECK     |
 *         |  E |                                         x[10.5,14.6] |
 *  x=-15  |  N |  GATE                                   z[-8,-2.5]   |  x=15
 *         |    |  x=-10   (crouch tunnel,     FOUNTAIN   top 0.6      |
 *         |    |  z=0      1.2 m clearance)   (2.5,0.5) r2.3          |
 *         |    |                                                      |
 *         |    |  lamp(-3.2,5.5)      bench(2.5,5.4)       CRATES     |
 *         |    |  tree(-6.5,9.5)                     x[9.1,12.5]      |
 *         |    |                    SPAWN (2.5,11.5)  z[5.2,8.9]      |
 *  z=15   +----+------------------------------------------------------+   SOUTH
 *          garden x[-14.75,-10.25]: bench, lamp, tree, birdbath, flower beds
 *
 * Every solid thing pushes a world-space THREE.Box3 into `colliders`. The ground (y=0)
 * has no collider. Perimeter colliders run up to y=4 (invisible above the 2.2 m railing)
 * so the player can't hop out from the terrace, crates or benches.
 */

// ---------------------------------------------------------------------------------------
// Constants and small utilities
// ---------------------------------------------------------------------------------------

const FOG_HEX = 0xd39a77;          // warm dusk haze; also the sky colour at the horizon
const SKY_TOP_HEX = 0x1a2350;      // deep indigo overhead
const SKY_MID_HEX = 0x6d5b8a;      // dusky violet band
const SUN_GLOW_HEX = 0xffb46e;
const SUN_DIR = new THREE.Vector3(-0.7, 0.33, -0.62).normalize(); // towards the sun (low, WNW)

const HALF = 15;                   // perimeter wall centre lines at x/z = ±15
const INNER = 14.75;               // inner face of the perimeter wall
const DIVIDER_X = -10;             // garden divider wall centre line
const GATE_HALF_W = 0.7;           // tunnel half width (z) -> 1.4 m wide
const GATE_CLEAR = 1.2;            // tunnel clearance (standing 1.8 blocked, crouched 1.0 fits)

// Deterministic RNG so the scene looks the same every load.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = mulberry32(20261013);
const rr = (a, b) => a + (b - a) * rand();

function hexToVec3(hex) {
  return new THREE.Vector3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
}

/**
 * BoxGeometry whose UVs are scaled to world size, so a texture tiles at a constant
 * `tile` metres regardless of the box dimensions (no stretching on long walls).
 */
function boxGeo(w, h, d, tile = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (tile > 0) {
    const uv = g.attributes.uv;
    // BoxGeometry face order: +x, -x, +y, -y, +z, -z (4 verts each with 1 segment).
    const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) {
      for (let i = 0; i < 4; i++) {
        const k = f * 4 + i;
        uv.setXY(k, (uv.getX(k) * dims[f][0]) / tile, (uv.getY(k) * dims[f][1]) / tile);
      }
    }
  }
  return g;
}

/** Horizontal plane (XZ) with world-scaled UVs. */
function planeGeo(w, d, tile) {
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  const uv = g.attributes.uv;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, (uv.getX(k) * w) / tile, (uv.getY(k) * d) / tile);
  return g;
}

function shadowed(mesh, cast = true, receive = true) {
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}

function addMesh(parent, geo, mat, x = 0, y = 0, z = 0, opts = {}) {
  const m = shadowed(new THREE.Mesh(geo, mat), opts.cast ?? true, opts.receive ?? true);
  m.position.set(x, y, z);
  if (opts.ry) m.rotation.y = opts.ry;
  parent.add(m);
  return m;
}

function addCollider(ctx, x0, y0, z0, x1, y1, z1) {
  ctx.colliders.push(new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1)));
}

/**
 * Axis-aligned box mesh specified by its footprint centre (x,z), base height y0 and size.
 * Optionally pushes the exact matching collider.
 */
function addBox(ctx, w, h, d, mat, x, y0, z, { tile = 0, collide = true, cast = true, receive = true } = {}) {
  const m = addMesh(ctx.scene, boxGeo(w, h, d, tile), mat, x, y0 + h / 2, z, { cast, receive });
  if (collide) addCollider(ctx, x - w / 2, y0, z - d / 2, x + w / 2, y0 + h, z + d / 2);
  return m;
}

/** Push a collider given in an object's local space (after it has been positioned/rotated). */
function addLocalCollider(ctx, obj, x0, y0, z0, x1, y1, z1) {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
  b.applyMatrix4(obj.matrixWorld);
  ctx.colliders.push(b);
}

/** Approximate a vertical cylinder footprint with a few overlapping AABBs. */
function addRoundCollider(ctx, cx, cz, r, y0, y1) {
  const spans = [[1.0, 0.2], [0.92, 0.4], [0.78, 0.62], [0.62, 0.78], [0.4, 0.92], [0.2, 1.0]];
  for (const [a, b] of spans) addCollider(ctx, cx - a * r, y0, cz - b * r, cx + a * r, y1, cz + b * r);
}

// ---------------------------------------------------------------------------------------
// Procedural canvas textures
// ---------------------------------------------------------------------------------------

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function toTexture(canvas, srgb) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Calls fn at (x,y) and at wrapped copies when near an edge, so speckles tile seamlessly. */
function wrapped(size, x, y, margin, fn) {
  for (const dx of [0, -size, size]) {
    for (const dy of [0, -size, size]) {
      const px = x + dx, py = y + dy;
      if (px > -margin && px < size + margin && py > -margin && py < size + margin) fn(px, py);
    }
  }
}

function speckle(g, size, x, y, w, h, count, dark = 0.1, light = 0.06) {
  for (let i = 0; i < count; i++) {
    const px = x + rand() * w, py = y + rand() * h, s = rr(1, 3.5);
    g.fillStyle = rand() < 0.5 ? `rgba(20,16,12,${rand() * dark})` : `rgba(255,248,235,${rand() * light})`;
    g.fillRect(px, py, s, s);
  }
}

/** Running-bond stone tiles; returns {map, bump}. Used for flagstones and wall ashlar. */
function makeTileTextures({ size, cols, rows, mortar, mortarBump, gap, hue, sat, light, round }) {
  const cc = makeCanvas(size), bc = makeCanvas(size);
  const g = cc.getContext('2d'), b = bc.getContext('2d');
  g.fillStyle = mortar; g.fillRect(0, 0, size, size);
  b.fillStyle = mortarBump; b.fillRect(0, 0, size, size);
  const tw = size / cols, th = size / rows;
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * tw * 0.5;
    const colors = [];
    for (let c = 0; c < cols; c++) {
      colors.push({ h: hue + rr(-6, 6), s: sat + rr(-4, 4), l: light + rr(-7, 7), bump: 185 + rr(-30, 30) });
    }
    for (let c = -1; c < cols; c++) {
      const col = colors[(c + cols) % cols];
      const x = c * tw + off + gap / 2, y = r * th + gap / 2, w = tw - gap, h = th - gap;
      g.fillStyle = `hsl(${col.h},${col.s}%,${col.l}%)`;
      roundRect(g, x, y, w, h, round); g.fill();
      // soft weathering: darker toward the bottom edge, lighter top lip
      const grad = g.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0, 'rgba(255,245,230,0.10)');
      grad.addColorStop(0.15, 'rgba(255,245,230,0)');
      grad.addColorStop(0.8, 'rgba(30,20,10,0)');
      grad.addColorStop(1, 'rgba(30,20,10,0.18)');
      g.fillStyle = grad; roundRect(g, x, y, w, h, round); g.fill();
      b.fillStyle = `rgb(${col.bump | 0},${col.bump | 0},${col.bump | 0})`;
      roundRect(b, x, y, w, h, round); b.fill();
    }
  }
  // speckle + blotches over everything (wrapped so the texture tiles)
  for (let i = 0; i < 1800; i++) {
    const x = rand() * size, y = rand() * size, s = rr(1, 3.2), dark = rand() < 0.55;
    const a = rand() * (dark ? 0.16 : 0.1);
    wrapped(size, x, y, 4, (px, py) => {
      g.fillStyle = dark ? `rgba(25,18,12,${a})` : `rgba(255,250,240,${a})`;
      g.fillRect(px, py, s, s);
      b.fillStyle = dark ? `rgba(0,0,0,${a * 1.5})` : `rgba(255,255,255,${a})`;
      b.fillRect(px, py, s, s);
    });
  }
  for (let i = 0; i < 40; i++) {
    const x = rand() * size, y = rand() * size, rad = rr(size * 0.03, size * 0.09);
    wrapped(size, x, y, rad, (px, py) => {
      const rg = g.createRadialGradient(px, py, 0, px, py, rad);
      rg.addColorStop(0, `rgba(40,30,20,${rr(0.04, 0.09)})`);
      rg.addColorStop(1, 'rgba(40,30,20,0)');
      g.fillStyle = rg; g.fillRect(px - rad, py - rad, rad * 2, rad * 2);
    });
  }
  return { map: toTexture(cc, true), bump: toTexture(bc, false) };
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

/** Horizontal wooden planks with periodic grain. Optionally a crate frame + diagonal brace. */
function makeWoodTextures({ size = 512, planks = 5, hue = 28, light = 42, crate = false }) {
  const cc = makeCanvas(size), bc = makeCanvas(size);
  const g = cc.getContext('2d'), b = bc.getContext('2d');
  const ph = size / planks;

  const drawPlank = (x, y, w, h, L, horizontal = true) => {
    g.fillStyle = `hsl(${hue + rr(-4, 4)},${rr(38, 48)}%,${L}%)`;
    g.fillRect(x, y, w, h);
    const lines = Math.round((horizontal ? h : w) / 3);
    for (let k = 0; k < lines; k++) {
      g.strokeStyle = `rgba(45,24,10,${rr(0.05, 0.2)})`;
      g.lineWidth = rr(0.6, 1.8);
      g.beginPath();
      const amp = rr(0.5, 2.5), ph0 = rr(0, 6.28), base = (horizontal ? y + rand() * h : x + rand() * w);
      for (let s = 0; s <= 32; s++) {
        const t = s / 32;
        const wob = Math.sin(t * Math.PI * 4 + ph0) * amp;
        if (horizontal) { const px = x + t * w; s ? g.lineTo(px, base + wob) : g.moveTo(px, base + wob); }
        else { const py = y + t * h; s ? g.lineTo(base + wob, py) : g.moveTo(base + wob, py); }
      }
      g.stroke();
    }
    // a knot now and then
    if (rand() < 0.35) {
      const kx = x + rr(0.15, 0.85) * w, ky = y + rr(0.3, 0.7) * h;
      g.fillStyle = 'rgba(55,30,12,0.45)';
      g.beginPath(); g.ellipse(kx, ky, horizontal ? 7 : 4, horizontal ? 4 : 7, 0, 0, Math.PI * 2); g.fill();
    }
  };

  b.fillStyle = '#000'; b.fillRect(0, 0, size, size);
  for (let i = 0; i < planks; i++) {
    const y = i * ph;
    drawPlank(0, y, size, ph, light + rr(-5, 5));
    b.fillStyle = `rgb(${150 + rr(-15, 15) | 0},0,0)`; b.fillRect(0, y + 2, size, ph - 4);
    g.fillStyle = 'rgba(30,16,6,0.9)'; g.fillRect(0, y, size, 2.5);
    g.fillStyle = 'rgba(255,230,190,0.08)'; g.fillRect(0, y + 2.5, size, 2);
  }

  if (crate) {
    const f = size * 0.12;
    const frameL = light - 8;
    // diagonal brace, clipped to the inner panel
    g.save(); b.save();
    for (const ctx2 of [g, b]) { ctx2.beginPath(); ctx2.rect(f, f, size - 2 * f, size - 2 * f); ctx2.clip(); }
    const len = (size - 2 * f) * Math.SQRT2 + f;
    for (const ctx2 of [g, b]) { ctx2.translate(size / 2, size / 2); ctx2.rotate(-Math.PI / 4); }
    g.fillStyle = 'rgba(20,10,4,0.45)'; g.fillRect(-len / 2, -f * 0.45 + 3, len, f * 0.9); // drop shadow
    drawPlank(-len / 2, -f * 0.45, len, f * 0.9, frameL + 4);
    b.fillStyle = 'rgb(225,0,0)'; b.fillRect(-len / 2, -f * 0.45, len, f * 0.9);
    g.restore(); b.restore();
    // frame boards
    const boards = [[0, 0, size, f, true], [0, size - f, size, f, true], [0, f, f, size - 2 * f, false], [size - f, f, f, size - 2 * f, false]];
    for (const [x, y, w, h, hor] of boards) {
      drawPlank(x, y, w, h, frameL + rr(-3, 3), hor);
      g.strokeStyle = 'rgba(25,12,4,0.8)'; g.lineWidth = 2.5; g.strokeRect(x + 1, y + 1, w - 2, h - 2);
      b.fillStyle = 'rgb(240,0,0)'; b.fillRect(x + 2, y + 2, w - 4, h - 4);
    }
    // inner shadow line around the panel
    g.strokeStyle = 'rgba(15,8,3,0.55)'; g.lineWidth = 5; g.strokeRect(f + 2, f + 2, size - 2 * f - 4, size - 2 * f - 4);
    // nails
    for (const [nx, ny] of [[f / 2, f / 2], [size - f / 2, f / 2], [f / 2, size - f / 2], [size - f / 2, size - f / 2], [size / 2, f / 2], [size / 2, size - f / 2], [f / 2, size / 2], [size - f / 2, size / 2]]) {
      g.fillStyle = '#2a2420'; g.beginPath(); g.arc(nx, ny, 4, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.25)'; g.beginPath(); g.arc(nx - 1, ny - 1, 1.5, 0, Math.PI * 2); g.fill();
    }
  }
  return { map: toTexture(cc, true), bump: toTexture(bc, false) };
}

function makeGrassTextures(size = 512) {
  const cc = makeCanvas(size), bc = makeCanvas(size);
  const g = cc.getContext('2d'), b = bc.getContext('2d');
  g.fillStyle = '#4a5a30'; g.fillRect(0, 0, size, size);
  b.fillStyle = '#808080'; b.fillRect(0, 0, size, size);
  for (let i = 0; i < 30; i++) {
    const x = rand() * size, y = rand() * size, rad = rr(30, 90);
    const light = rand() < 0.5;
    wrapped(size, x, y, rad, (px, py) => {
      const rg = g.createRadialGradient(px, py, 0, px, py, rad);
      rg.addColorStop(0, light ? 'rgba(120,130,60,0.18)' : 'rgba(25,35,15,0.2)');
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg; g.fillRect(px - rad, py - rad, rad * 2, rad * 2);
    });
  }
  for (let i = 0; i < 5000; i++) {
    const x = rand() * size, y = rand() * size, len = rr(3, 9), ang = rr(-0.5, 0.5) - Math.PI / 2;
    const hue = rr(68, 98), sat = rr(25, 45), l = rr(16, 40), a = rr(0.35, 0.8), lw = rr(0.8, 1.8);
    wrapped(size, x, y, 10, (px, py) => {
      g.strokeStyle = `hsla(${hue},${sat}%,${l}%,${a})`; g.lineWidth = lw;
      g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len); g.stroke();
      const v = (l * 5) | 0;
      b.strokeStyle = `rgba(${v},${v},${v},0.6)`; b.lineWidth = lw;
      b.beginPath(); b.moveTo(px, py); b.lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len); b.stroke();
    });
  }
  return { map: toTexture(cc, true), bump: toTexture(bc, false) };
}

function makeRippleTexture(size = 256) {
  const c = makeCanvas(size), g = c.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, size, size);
  for (let i = 0; i < 160; i++) {
    const x = rand() * size, y = rand() * size, rad = rr(6, 28), light = rand() < 0.5;
    wrapped(size, x, y, rad, (px, py) => {
      const rg = g.createRadialGradient(px, py, 0, px, py, rad);
      rg.addColorStop(0, light ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)');
      rg.addColorStop(1, 'rgba(128,128,128,0)');
      g.fillStyle = rg; g.fillRect(px - rad, py - rad, rad * 2, rad * 2);
    });
  }
  return toTexture(c, false);
}

function makePlaqueTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, '#4a3a26'); grad.addColorStop(1, '#2c2216');
  g.fillStyle = grad; g.fillRect(0, 0, 512, 128);
  g.strokeStyle = '#b8955a'; g.lineWidth = 6; g.strokeRect(8, 8, 496, 112);
  g.strokeStyle = 'rgba(184,149,90,0.5)'; g.lineWidth = 2; g.strokeRect(18, 18, 476, 92);
  g.fillStyle = '#e6c88e';
  g.font = 'bold 50px Georgia, "Times New Roman", serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('MIND YOUR HEAD', 256, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// ---------------------------------------------------------------------------------------
// Materials (one coherent palette: warm sandstone, weathered oak, dark iron, deep greens)
// ---------------------------------------------------------------------------------------

function makeMaterials() {
  const flag = makeTileTextures({ size: 1024, cols: 4, rows: 4, mortar: '#5a5247', mortarBump: '#000', gap: 6, hue: 32, sat: 9, light: 50, round: 6 });
  const ashlar = makeTileTextures({ size: 512, cols: 2, rows: 4, mortar: '#a3978a', mortarBump: '#1a1a1a', gap: 7, hue: 36, sat: 24, light: 62, round: 4 });
  const planks = makeWoodTextures({ planks: 5, hue: 27, light: 40 });
  const crate = makeWoodTextures({ planks: 5, hue: 31, light: 50, crate: true });
  const grass = makeGrassTextures();
  const ripple = makeRippleTexture();
  ripple.repeat.set(2, 2);

  // barrels: same plank canvas rotated so planks become vertical staves
  const staveMap = planks.map.clone();
  staveMap.center.set(0.5, 0.5); staveMap.rotation = Math.PI / 2; staveMap.repeat.set(1, 3);
  const staveBump = planks.bump.clone();
  staveBump.center.set(0.5, 0.5); staveBump.rotation = Math.PI / 2; staveBump.repeat.set(1, 3);

  const std = (o) => new THREE.MeshStandardMaterial(o);
  return {
    flagGround: std({ map: flag.map, bumpMap: flag.bump, bumpScale: 0.8, roughness: 0.88, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    flag: std({ map: flag.map, bumpMap: flag.bump, bumpScale: 0.8, roughness: 0.88 }),
    ashlar: std({ map: ashlar.map, bumpMap: ashlar.bump, bumpScale: 0.9, roughness: 0.92 }),
    stoneSmooth: std({ color: 0xc8b79b, roughness: 0.78 }),
    stoneLight: std({ color: 0xd6c8ae, roughness: 0.82 }),
    stoneDark: std({ color: 0x8d7d68, roughness: 0.85 }),
    stoneRound: std({ color: 0xc4b398, roughness: 0.75, side: THREE.DoubleSide }),
    grass: std({ map: grass.map, bumpMap: grass.bump, bumpScale: 0.6, roughness: 0.97 }),
    planks: std({ map: planks.map, bumpMap: planks.bump, bumpScale: 0.6, roughness: 0.82 }),
    crate: std({ map: crate.map, bumpMap: crate.bump, bumpScale: 0.7, roughness: 0.8 }),
    staves: std({ map: staveMap, bumpMap: staveBump, bumpScale: 0.6, roughness: 0.75, color: 0xb88a66 }),
    benchWood: std({ color: 0x7a5435, roughness: 0.7 }),
    iron: std({ color: 0x26262b, metalness: 0.75, roughness: 0.45 }),
    bulb: std({ color: 0xffe2b0, emissive: 0xffc070, emissiveIntensity: 3.2, roughness: 0.3 }),
    trunk: std({ color: 0x5a4130, roughness: 0.95 }),
    leafA: std({ color: 0x3c5a32, roughness: 0.9, flatShading: true }),
    leafB: std({ color: 0x4d6b38, roughness: 0.9, flatShading: true }),
    leafC: std({ color: 0x2f4a2e, roughness: 0.9, flatShading: true }),
    pine: std({ color: 0x2c4a33, roughness: 0.9, flatShading: true }),
    soil: std({ color: 0x3a2a1e, roughness: 1.0 }),
    flowerPink: std({ color: 0xe58aa8, roughness: 0.8, flatShading: true }),
    flowerYellow: std({ color: 0xf0cf62, roughness: 0.8, flatShading: true }),
    flowerWhite: std({ color: 0xf3eee4, roughness: 0.8, flatShading: true }),
    water: std({ color: 0x2f6475, roughness: 0.08, metalness: 0.35, bumpMap: ripple, bumpScale: 0.35, emissive: 0x0b2028, emissiveIntensity: 0.6 }),
    waterFall: std({ color: 0xbfe3ee, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide, emissive: 0x6fa8b8, emissiveIntensity: 0.15 }),
    plaque: std({ map: makePlaqueTexture(), metalness: 0.5, roughness: 0.45 }),
    rippleTex: ripple,
  };
}

// ---------------------------------------------------------------------------------------
// Sky, fog and lights
// ---------------------------------------------------------------------------------------

function buildSky(scene) {
  scene.background = new THREE.Color(FOG_HEX);
  scene.fog = new THREE.Fog(FOG_HEX, 14, 85);

  // Camera-centred gradient dome: the vertex shader drops the view translation, so the
  // dome always surrounds the eye regardless of the camera's far plane. Colours are in
  // display (sRGB) space and the material is not tone mapped, so the horizon matches the
  // fog colour exactly (three applies fog after tone mapping/colour conversion).
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: hexToVec3(SKY_TOP_HEX) },
      midColor: { value: hexToVec3(SKY_MID_HEX) },
      horizonColor: { value: hexToVec3(FOG_HEX) },
      sunColor: { value: hexToVec3(SUN_GLOW_HEX) },
      sunDir: { value: SUN_DIR.clone() },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 topColor, midColor, horizonColor, sunColor, sunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(horizonColor, midColor, smoothstep(0.0, 0.3, h));
        col = mix(col, topColor, smoothstep(0.22, 0.95, h));
        float s = max(dot(d, sunDir), 0.0);
        // glow fades out right at the horizon so the sky meets the fogged ground seamlessly
        float glowMask = smoothstep(-0.005, 0.12, h);
        col += sunColor * (pow(s, 5.0) * 0.32 + pow(s, 48.0) * 0.45) * glowMask;
        col = mix(col, vec3(1.0, 0.95, 0.84), smoothstep(0.99935, 0.99975, s));
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  sky.name = 'sky';
  scene.add(sky);
}

function buildLights(scene) {
  const hemi = new THREE.HemisphereLight(0x9aa3d6, 0x6e5240, 1.5);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffb27a, 3.2);
  sun.position.copy(SUN_DIR).multiplyScalar(45);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const cam = sun.shadow.camera;
  // Low sun: the 30x30 m yard projects wide (diagonal ~42 m) but short in light space.
  cam.left = -22; cam.right = 22; cam.top = 14; cam.bottom = -12;
  cam.near = 5; cam.far = 85;
  cam.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  scene.add(sun, sun.target);
}

// ---------------------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------------------

function buildGround(ctx, M) {
  // Wide grass field (fades into fog at the horizon). Visible inside the garden too.
  const grass = new THREE.Mesh(planeGeo(400, 400, 3), M.grass);
  grass.receiveShadow = true;
  ctx.scene.add(grass);

  // Flagstone plaza: x[-10,15] z[-15,15]; one texture repeat = 4 tiles = 3.6 m.
  const plaza = new THREE.Mesh(planeGeo(25, 30, 3.6), M.flagGround);
  plaza.position.set(2.5, 0.004, 0);
  plaza.receiveShadow = true;
  ctx.scene.add(plaza);
}

// ---------------------------------------------------------------------------------------
// Perimeter: low ashlar wall + coping + iron railing, pillars every 7.5 m
// ---------------------------------------------------------------------------------------

function buildPerimeter(ctx, M) {
  const wallH = 1.0, wallT = 0.5, len = 2 * HALF + wallT;
  const sides = [
    { x: 0, z: -HALF, w: len, d: wallT }, // north
    { x: 0, z: HALF, w: len, d: wallT },  // south
    { x: -HALF, z: 0, w: wallT, d: len }, // west
    { x: HALF, z: 0, w: wallT, d: len },  // east
  ];
  for (const s of sides) {
    addBox(ctx, s.w, wallH, s.d, M.ashlar, s.x, 0, s.z, { tile: 2, collide: false });
    addBox(ctx, s.w + 0.1, 0.08, s.d + 0.12, M.stoneSmooth, s.x, wallH, s.z, { collide: false });
    // tall invisible collider (0.75 deep to cover pillars) so nothing can be climbed over
    addCollider(ctx, s.x - s.w / 2 - (s.w === wallT ? 0.125 : 0), 0, s.z - s.d / 2 - (s.d === wallT ? 0.125 : 0),
      s.x + s.w / 2 + (s.w === wallT ? 0.125 : 0), 4, s.z + s.d / 2 + (s.d === wallT ? 0.125 : 0));
  }

  // Pillars at corners and every 7.5 m (instanced: body, cap, ball).
  const posts = [];
  const stops = [-15, -7.5, 0, 7.5, 15];
  for (const a of stops) {
    posts.push([a, -HALF], [a, HALF]);
    if (Math.abs(a) !== 15) posts.push([-HALF, a], [HALF, a]);
  }
  const dummy = new THREE.Object3D();
  const parts = [
    { geo: boxGeo(0.75, 2.4, 0.75, 2), mat: M.ashlar, y: 1.2 },
    { geo: new THREE.BoxGeometry(0.92, 0.12, 0.92), mat: M.stoneSmooth, y: 2.46 },
    { geo: new THREE.BoxGeometry(0.6, 0.08, 0.6), mat: M.stoneSmooth, y: 2.56 },
    { geo: new THREE.IcosahedronGeometry(0.17, 2), mat: M.stoneLight, y: 2.77 },
  ];
  for (const p of parts) {
    const im = shadowed(new THREE.InstancedMesh(p.geo, p.mat, posts.length));
    posts.forEach(([x, z], i) => {
      dummy.position.set(x, p.y, z); dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix);
    });
    ctx.scene.add(im);
  }

  // Railing bars + spear tips (instanced), two rails per side.
  const bars = [];
  const isNearPost = (t) => stops.some((a) => Math.abs(t - a) < 0.5);
  for (let t = -14.6; t <= 14.61; t += 0.2) {
    if (isNearPost(t)) continue;
    bars.push([t, -HALF], [t, HALF], [-HALF, t], [HALF, t]);
  }
  const barGeo = new THREE.BoxGeometry(0.035, 1.1, 0.035);
  const tipGeo = new THREE.ConeGeometry(0.04, 0.13, 4);
  const barIM = shadowed(new THREE.InstancedMesh(barGeo, M.iron, bars.length), true, false);
  const tipIM = shadowed(new THREE.InstancedMesh(tipGeo, M.iron, bars.length), true, false);
  bars.forEach(([x, z], i) => {
    dummy.position.set(x, 1.08 + 0.55, z); dummy.rotation.set(0, Math.PI / 4, 0); dummy.updateMatrix();
    barIM.setMatrixAt(i, dummy.matrix);
    dummy.position.y = 1.08 + 1.1 + 0.06; dummy.updateMatrix();
    tipIM.setMatrixAt(i, dummy.matrix);
  });
  ctx.scene.add(barIM, tipIM);
  for (const s of sides) {
    for (const y of [1.28, 2.06]) {
      addBox(ctx, s.w === wallT ? 0.05 : 30, 0.045, s.d === wallT ? 0.05 : 30, M.iron, s.x, y, s.z, { collide: false, receive: false });
    }
  }
}

// ---------------------------------------------------------------------------------------
// Garden divider wall with the low crouch gate (the crouch gap)
// ---------------------------------------------------------------------------------------

function buildGardenWallAndGate(ctx, M) {
  const X = DIVIDER_X, H = 2.4, T = 0.5;
  const segLen = INNER - 1.3; // from |z|=1.3 to the perimeter
  for (const sgn of [-1, 1]) {
    const zc = sgn * (1.3 + segLen / 2);
    addBox(ctx, T, H, segLen, M.ashlar, X, 0, zc, { tile: 2, collide: false });
    addBox(ctx, T + 0.12, 0.09, segLen, M.stoneSmooth, X, H, zc, { collide: false });
    addCollider(ctx, X - 0.31, 0, zc - segLen / 2, X + 0.31, H + 0.09, zc + segLen / 2);
  }

  // Gatehouse: two deep posts, a lintel whose underside is at 1.2 m, a projecting cap.
  const D = 1.6;                 // tunnel length (x), x[-10.8,-9.2]
  const postW = 0.7;             // z[0.7,1.4] each side
  for (const sgn of [-1, 1]) {
    const zc = sgn * (GATE_HALF_W + postW / 2);
    addBox(ctx, D, 2.7, postW, M.ashlar, X, 0, zc, { tile: 2, collide: false });
    // plinth band at the foot of each post
    addBox(ctx, D + 0.08, 0.25, postW + 0.08, M.stoneDark, X, 0, zc, { collide: false });
  }
  addBox(ctx, D, 2.7 - GATE_CLEAR, 2 * GATE_HALF_W, M.ashlar, X, GATE_CLEAR, 0, { tile: 2, collide: false });
  // dressed lintel stone across the opening on both faces + keystone
  for (const sx of [-1, 1]) {
    addBox(ctx, 0.06, 0.32, 2 * GATE_HALF_W + 0.5, M.stoneLight, X + sx * (D / 2 + 0.03), GATE_CLEAR, 0, { collide: false });
    addBox(ctx, 0.1, 0.5, 0.36, M.stoneSmooth, X + sx * (D / 2 + 0.05), GATE_CLEAR, 0, { collide: false });
  }
  addBox(ctx, D + 0.3, 0.15, 2 * (GATE_HALF_W + postW) + 0.3, M.stoneSmooth, X, 2.7, 0, { collide: false });
  addBox(ctx, D + 0.1, 0.1, 2 * (GATE_HALF_W + postW) + 0.1, M.stoneLight, X, 2.85, 0, { collide: false });

  // Colliders: posts (full height) and the lintel block starting exactly at the clearance.
  for (const sgn of [-1, 1]) {
    const z0 = sgn > 0 ? GATE_HALF_W : -(GATE_HALF_W + postW + 0.15);
    const z1 = sgn > 0 ? GATE_HALF_W + postW + 0.15 : -GATE_HALF_W;
    addCollider(ctx, X - D / 2 - 0.15, 0, z0, X + D / 2 + 0.15, 2.95, z1);
  }
  addCollider(ctx, X - D / 2 - 0.15, GATE_CLEAR, -GATE_HALF_W, X + D / 2 + 0.15, 2.95, GATE_HALF_W);

  // Worn stone floor through the tunnel.
  const floor = new THREE.Mesh(planeGeo(D + 0.4, 2 * GATE_HALF_W, 1), M.stoneDark);
  floor.position.set(X, 0.008, 0);
  floor.receiveShadow = true;
  ctx.scene.add(floor);

  // "MIND YOUR HEAD" plaque on the plaza-facing side of the lintel.
  const plaque = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.275), M.plaque);
  plaque.position.set(X + D / 2 + 0.065, 1.95, 0);
  plaque.rotation.y = Math.PI / 2;
  ctx.scene.add(plaque);

  // Ivy clumps spilling over the wall top near the gate (decorative).
  const ivyGeo = new THREE.IcosahedronGeometry(1, 1);
  const ivySpots = [[-1.9, 2.45, 0.45], [-2.6, 2.4, 0.35], [1.8, 2.45, 0.4], [1.2, 2.95, 0.42], [-1.5, 2.95, 0.38], [4.5, 2.45, 0.35], [-5.2, 2.45, 0.4]];
  for (const [z, y, r] of ivySpots) {
    const m = addMesh(ctx.scene, ivyGeo, rand() < 0.5 ? M.leafA : M.leafC, X + rr(-0.1, 0.1), y, z);
    m.scale.set(r * 0.9, r * 0.7, r * 1.3);
    m.rotation.set(rand(), rand(), rand());
  }
}

// ---------------------------------------------------------------------------------------
// North terrace + steps (jump targets: 0.4, 0.8, 1.2)
// ---------------------------------------------------------------------------------------

function buildTerrace(ctx, M) {
  const x0 = -4, x1 = 9, z0 = -INNER, z1 = -10.5, top = 1.2;
  const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  addBox(ctx, w, top - 0.08, d, M.ashlar, cx, 0, cz, { tile: 2, collide: false });
  addBox(ctx, w + 0.1, 0.08, d + 0.05, M.flag, cx, top - 0.08, cz + 0.025, { tile: 3.6, collide: false });
  addBox(ctx, w + 0.06, 0.18, d + 0.03, M.stoneDark, cx, 0, cz + 0.015, { collide: false }); // plinth
  addCollider(ctx, x0 - 0.05, 0, z0, x1 + 0.05, top, z1 + 0.05);

  // Steps, x[0,5]: step 2 z[-10.5,-9.9] top 0.8, step 1 z[-9.9,-9.3] top 0.4.
  addBox(ctx, 5, 0.8, 0.6, M.stoneLight, 2.5, 0, -10.2);
  addBox(ctx, 5, 0.4, 0.6, M.stoneLight, 2.5, 0, -9.6);
  // nosing strips (visual only, sit on top of the step colliders' faces)
  addBox(ctx, 5.02, 0.04, 0.05, M.stoneSmooth, 2.5, 0.78, -9.92, { collide: false });
  addBox(ctx, 5.02, 0.04, 0.05, M.stoneSmooth, 2.5, 0.38, -9.32, { collide: false });

  // Terrace furniture.
  makePlanter(ctx, M, -0.65, 0, -9.95, 0.9, 0.9, 0.6);
  makePlanter(ctx, M, 5.65, 0, -9.95, 0.9, 0.9, 0.6);
  makeBench(ctx, M, 2.5, top, -14.0, Math.PI);
  makeLamp(ctx, M, 8.2, top, -14.0);
  makePine(ctx, M, -2.6, top, -12.8, 1.0);
  makePlanter(ctx, M, 6.2, top, -14.15, 0.8, 0.8, 0.5);
}

// ---------------------------------------------------------------------------------------
// Fountain (centre of the plaza)
// ---------------------------------------------------------------------------------------

function buildFountain(ctx, M) {
  const cx = 2.5, cz = 0.5, R = 2.32;
  const g = new THREE.Group();
  g.position.set(cx, 0, cz);
  ctx.scene.add(g);

  // Basin wall profile, outer-bottom -> rim -> inner wall (lathed).
  const profile = [
    new THREE.Vector2(R, 0), new THREE.Vector2(R, 0.46), new THREE.Vector2(R - 0.04, 0.55),
    new THREE.Vector2(R - 0.08, 0.58), new THREE.Vector2(1.93, 0.58), new THREE.Vector2(1.88, 0.53),
    new THREE.Vector2(1.86, 0.2),
  ];
  addMesh(g, new THREE.LatheGeometry(profile, 40), M.stoneRound);
  addMesh(g, new THREE.CylinderGeometry(R + 0.05, R + 0.08, 0.1, 40), M.stoneDark, 0, 0.05, 0); // footing

  const water = addMesh(g, new THREE.CircleGeometry(1.87, 40), M.water, 0, 0.42, 0, { cast: false });
  water.rotation.x = -Math.PI / 2;
  water.onBeforeRender = () => {
    const t = performance.now() / 1000;
    M.rippleTex.offset.set(t * 0.03, t * 0.019);
  };

  // Pedestal, bowl, upper water, finial and a translucent spill curtain.
  addMesh(g, new THREE.CylinderGeometry(0.26, 0.4, 1.1, 16), M.stoneSmooth, 0, 0.55, 0);
  addMesh(g, new THREE.CylinderGeometry(0.42, 0.3, 0.12, 16), M.stoneLight, 0, 0.5, 0);
  addMesh(g, new THREE.CylinderGeometry(0.85, 0.32, 0.3, 24), M.stoneRound, 0, 1.25, 0);
  const bowlWater = addMesh(g, new THREE.CircleGeometry(0.8, 24), M.water, 0, 1.405, 0, { cast: false });
  bowlWater.rotation.x = -Math.PI / 2;
  addMesh(g, new THREE.CylinderGeometry(0.07, 0.11, 0.35, 10), M.stoneSmooth, 0, 1.55, 0);
  addMesh(g, new THREE.IcosahedronGeometry(0.11, 2), M.stoneLight, 0, 1.78, 0);
  addMesh(g, new THREE.CylinderGeometry(0.84, 1.02, 0.98, 32, 1, true), M.waterFall, 0, 0.9, 0, { cast: false, receive: false });
  addMesh(g, new THREE.CylinderGeometry(0.025, 0.05, 0.3, 8, 1, true), M.waterFall, 0, 1.98, 0, { cast: false, receive: false });

  // Colliders: basin (stand on the rim at 0.58), pedestal, bowl.
  addRoundCollider(ctx, cx, cz, R, 0, 0.58);
  addCollider(ctx, cx - 0.4, 0, cz - 0.4, cx + 0.4, 1.1, cz + 0.4);
  addRoundCollider(ctx, cx, cz, 0.85, 1.1, 1.4);
}

// ---------------------------------------------------------------------------------------
// Crates, barrels and the low deck (east side jump targets)
// ---------------------------------------------------------------------------------------

function makeCrate(ctx, M, x, y0, z, s) {
  return addBox(ctx, s, s, s, M.crate, x, y0, z);
}

function makeBarrel(ctx, M, x, y0, z) {
  const g = new THREE.Group();
  g.position.set(x, y0, z);
  ctx.scene.add(g);
  const body = new THREE.LatheGeometry([
    new THREE.Vector2(0, 0), new THREE.Vector2(0.3, 0), new THREE.Vector2(0.34, 0.2), new THREE.Vector2(0.36, 0.45),
    new THREE.Vector2(0.34, 0.7), new THREE.Vector2(0.3, 0.9), new THREE.Vector2(0, 0.9),
  ], 16);
  addMesh(g, body, M.staves);
  for (const [y, r] of [[0.12, 0.33], [0.78, 0.33], [0.36, 0.365], [0.54, 0.365]]) {
    addMesh(g, new THREE.CylinderGeometry(r, r, 0.045, 16, 1, true), M.iron, 0, y, 0, { receive: false });
  }
  addCollider(ctx, x - 0.36, y0, z - 0.36, x + 0.36, y0 + 0.9, z + 0.36);
}

function buildCratesAndDeck(ctx, M) {
  // Crate stack near the south-east: 0.6 -> 1.0 -> 1.8 m climb.
  makeCrate(ctx, M, 9.4, 0, 7.6, 0.6);    // top 0.6
  makeCrate(ctx, M, 10.5, 0, 7.0, 1.0);   // top 1.0
  makeCrate(ctx, M, 11.5, 0, 7.0, 1.0);   // top 1.0
  makeCrate(ctx, M, 11.6, 1.0, 6.9, 0.8); // stacked, top 1.8
  makeCrate(ctx, M, 12.0, 0, 8.4, 1.0);   // top 1.0
  makeCrate(ctx, M, 10.6, 0, 5.6, 0.8);   // top 0.8
  makeBarrel(ctx, M, 13.55, 0, 9.6);
  makeBarrel(ctx, M, 13.7, 0, 8.7);

  // Low wooden deck against the east wall: x[10.5,14.6] z[-8,-2.5], top 0.6.
  const x0 = 10.5, x1 = 14.6, z0 = -8, z1 = -2.5, top = 0.6;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0;
  addBox(ctx, w, 0.1, d, M.planks, cx, top - 0.1, cz, { tile: 2.2, collide: false });
  addBox(ctx, w - 0.3, top - 0.1, d - 0.3, M.benchWood, cx, 0, cz, { collide: false });     // skirt
  addBox(ctx, 0.12, 0.1, d, M.benchWood, x0 + 0.06, top - 0.1, cz, { collide: false });    // edge trim
  for (const [px, pz] of [[x0 + 0.1, z0 + 0.1], [x0 + 0.1, z1 - 0.1], [x1 - 0.1, z0 + 0.1], [x1 - 0.1, z1 - 0.1]]) {
    addBox(ctx, 0.16, top - 0.1, 0.16, M.benchWood, px, 0, pz, { collide: false });
  }
  addCollider(ctx, x0, 0, z0, x1, top, z1);
  // a little step box in front of the deck (0.3) for an easy hop
  addBox(ctx, 0.9, 0.3, 1.4, M.planks, x0 - 0.45, 0, -5.25, { tile: 2.2 });

  makeBarrel(ctx, M, 14.0, top, -7.4);
  makeBarrel(ctx, M, 13.2, top, -7.5);
  makeCrate(ctx, M, 13.95, top, -6.3, 0.8);
  makeBench(ctx, M, 14.1, top, -4.4, Math.PI / 2);   // back to the wall, faces west
}

// ---------------------------------------------------------------------------------------
// Props: trees, lamps, benches, planters, birdbath
// ---------------------------------------------------------------------------------------

function makeRoundTree(ctx, M, x, y0, z, s) {
  const g = new THREE.Group();
  g.position.set(x, y0, z);
  ctx.scene.add(g);
  const trunkH = 2.8 * s;
  addMesh(g, new THREE.CylinderGeometry(0.13 * s, 0.24 * s, trunkH, 9), M.trunk, 0, trunkH / 2, 0);
  // root flare + a couple of limbs
  addMesh(g, new THREE.CylinderGeometry(0.24 * s, 0.36 * s, 0.3, 9), M.trunk, 0, 0.15, 0);
  for (const a of [0.6, 2.7, 4.6]) {
    const limb = addMesh(g, new THREE.CylinderGeometry(0.05 * s, 0.09 * s, 1.0 * s, 6), M.trunk, Math.cos(a) * 0.3 * s, trunkH - 0.35 * s, Math.sin(a) * 0.3 * s);
    limb.rotation.set(Math.sin(a) * 0.7, 0, -Math.cos(a) * 0.7);
  }
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const blobs = [
    [0, 3.45, 0, 1.45, M.leafA], [0.95, 3.05, 0.35, 0.95, M.leafB], [-0.85, 3.1, -0.3, 1.0, M.leafC],
    [0.2, 3.15, -0.95, 0.9, M.leafB], [-0.3, 3.2, 0.95, 0.9, M.leafA], [0.25, 4.25, 0.1, 0.9, M.leafB],
  ];
  for (const [bx, by, bz, r, mat] of blobs) {
    const m = addMesh(g, geo, mat, bx * s, by * s, bz * s);
    m.scale.set(r * s * rr(0.95, 1.1), r * s * rr(0.8, 0.95), r * s * rr(0.95, 1.1));
    m.rotation.set(rand() * 3, rand() * 3, rand() * 3);
  }
  addCollider(ctx, x - 0.3 * s, y0, z - 0.3 * s, x + 0.3 * s, y0 + trunkH, z + 0.3 * s);
}

function makePine(ctx, M, x, y0, z, s) {
  const g = new THREE.Group();
  g.position.set(x, y0, z);
  ctx.scene.add(g);
  addMesh(g, new THREE.CylinderGeometry(0.1 * s, 0.22 * s, 3.2 * s, 8), M.trunk, 0, 1.6 * s, 0);
  const tiers = [[1.75, 2.3, 2.0], [1.35, 2.0, 3.1], [0.95, 1.7, 4.1], [0.55, 1.3, 5.0]];
  tiers.forEach(([r, h, base], i) => {
    const cone = addMesh(g, new THREE.ConeGeometry(r * s, h * s, 9), M.pine, 0, (base + h / 2) * s, 0);
    cone.rotation.y = i * 0.7;
  });
  addCollider(ctx, x - 0.3 * s, y0, z - 0.3 * s, x + 0.3 * s, y0 + 3.0 * s, z + 0.3 * s);
}

function makeLamp(ctx, M, x, y0, z) {
  const g = new THREE.Group();
  g.position.set(x, y0, z);
  ctx.scene.add(g);
  addMesh(g, new THREE.CylinderGeometry(0.17, 0.24, 0.4, 8), M.iron, 0, 0.2, 0);
  addMesh(g, new THREE.CylinderGeometry(0.045, 0.06, 2.8, 8), M.iron, 0, 1.8, 0);
  addMesh(g, new THREE.CylinderGeometry(0.08, 0.08, 0.1, 8), M.iron, 0, 3.0, 0);
  // lantern: base plate, glowing glass, four corner posts, pyramid roof, finial
  addMesh(g, new THREE.BoxGeometry(0.3, 0.04, 0.3), M.iron, 0, 3.07, 0);
  addMesh(g, new THREE.BoxGeometry(0.24, 0.34, 0.24), M.bulb, 0, 3.26, 0, { cast: false });
  for (const [px, pz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    addMesh(g, new THREE.BoxGeometry(0.03, 0.36, 0.03), M.iron, px * 0.125, 3.26, pz * 0.125, { receive: false });
  }
  const roof = addMesh(g, new THREE.ConeGeometry(0.25, 0.2, 4), M.iron, 0, 3.53, 0);
  roof.rotation.y = Math.PI / 4;
  addMesh(g, new THREE.IcosahedronGeometry(0.035, 1), M.iron, 0, 3.66, 0);

  const light = new THREE.PointLight(0xffc27a, 14, 14, 2);
  light.position.set(0, 3.2, 0);
  g.add(light);
  addCollider(ctx, x - 0.24, y0, z - 0.24, x + 0.24, y0 + 3.7, z + 0.24);
}

/** Bench: local +Z is the backrest side, sitter faces -Z. rotY turns it. */
function makeBench(ctx, M, x, y0, z, rotY = 0) {
  const g = new THREE.Group();
  g.position.set(x, y0, z);
  g.rotation.y = rotY;
  ctx.scene.add(g);
  for (const sz of [-0.15, 0, 0.15]) addMesh(g, new THREE.BoxGeometry(1.8, 0.05, 0.12), M.benchWood, 0, 0.45, sz);
  for (const [sy, tz] of [[0.65, 0.235], [0.84, 0.26]]) {
    const slat = addMesh(g, new THREE.BoxGeometry(1.8, 0.11, 0.04), M.benchWood, 0, sy, tz);
    slat.rotation.x = -0.14;
  }
  for (const sx of [-0.78, 0.78]) {
    addMesh(g, new THREE.BoxGeometry(0.06, 0.45, 0.06), M.iron, sx, 0.225, -0.18);           // front leg
    addMesh(g, new THREE.BoxGeometry(0.06, 0.94, 0.06), M.iron, sx, 0.47, 0.21).rotation.x = -0.1; // rear leg/back
    addMesh(g, new THREE.BoxGeometry(0.06, 0.04, 0.46), M.iron, sx, 0.42, 0.01);            // seat rail
    addMesh(g, new THREE.BoxGeometry(0.06, 0.04, 0.48), M.iron, sx, 0.64, -0.02);           // armrest
    addMesh(g, new THREE.BoxGeometry(0.05, 0.2, 0.05), M.iron, sx, 0.54, -0.21);            // arm post
  }
  addLocalCollider(ctx, g, -0.9, 0, -0.26, 0.9, 0.48, 0.2);   // seat
  addLocalCollider(ctx, g, -0.9, 0, 0.18, 0.9, 0.95, 0.32);   // backrest
}

function makePlanter(ctx, M, x, y0, z, w, d, h) {
  addBox(ctx, w, h, d, M.ashlar, x, y0, z, { tile: 2 });
  addBox(ctx, w + 0.08, 0.06, d + 0.08, M.stoneSmooth, x, y0 + h, z, { collide: false }); // lip (inside collider height tolerance)
  addBox(ctx, w - 0.14, 0.02, d - 0.14, M.soil, x, y0 + h + 0.01, z, { collide: false, cast: false });
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const shrubR = Math.min(w, d) * 0.36;
  const n = Math.max(1, Math.round((Math.max(w, d) / Math.min(w, d)) * 1.2));
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1) - 0.5;
    const sx = x + (w > d ? t * (w - 2 * shrubR) : 0), sz = z + (d >= w ? t * (d - 2 * shrubR) : 0);
    const sy = y0 + h + shrubR * 0.55;
    const m = addMesh(ctx.scene, geo, rand() < 0.5 ? M.leafB : M.leafA, sx, sy, sz);
    m.scale.set(shrubR, shrubR * 0.8, shrubR);
    m.rotation.set(rand() * 3, rand() * 3, rand() * 3);
    const list = ctx.flowers[(rand() * 3) | 0];
    for (let k = 0; k < 7; k++) {
      const a = rand() * Math.PI * 2, el = rr(0.15, 1.2);
      _dummy.position.set(
        sx + Math.cos(a) * Math.cos(el) * shrubR * 0.98, sy + Math.sin(el) * shrubR * 0.78, sz + Math.sin(a) * Math.cos(el) * shrubR * 0.98);
      _dummy.rotation.set(rand(), rand(), rand());
      _dummy.scale.setScalar(rr(0.8, 1.2));
      _dummy.updateMatrix();
      list.push(_dummy.matrix.clone());
    }
  }
}

const _dummy = new THREE.Object3D();

/** All planter flowers, one InstancedMesh per colour (ctx.flowers filled by makePlanter). */
function buildFlowers(ctx, M) {
  const geo = new THREE.IcosahedronGeometry(0.05, 0);
  [M.flowerPink, M.flowerYellow, M.flowerWhite].forEach((mat, i) => {
    const list = ctx.flowers[i];
    if (!list.length) return;
    const im = shadowed(new THREE.InstancedMesh(geo, mat, list.length), false, true);
    list.forEach((m, k) => im.setMatrixAt(k, m));
    ctx.scene.add(im);
  });
}

function makeBirdbath(ctx, M, x, z) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  ctx.scene.add(g);
  addMesh(g, new THREE.CylinderGeometry(0.28, 0.32, 0.12, 12), M.stoneDark, 0, 0.06, 0);
  addMesh(g, new THREE.CylinderGeometry(0.1, 0.16, 0.75, 12), M.stoneSmooth, 0, 0.48, 0);
  addMesh(g, new THREE.CylinderGeometry(0.48, 0.18, 0.16, 20), M.stoneRound, 0, 0.92, 0);
  const w = addMesh(g, new THREE.CircleGeometry(0.42, 20), M.water, 0, 1.004, 0, { cast: false });
  w.rotation.x = -Math.PI / 2;
  addRoundCollider(ctx, x, z, 0.48, 0, 1.0);
}

// ---------------------------------------------------------------------------------------
// Distant tree line outside the walls (no colliders, fog does the depth)
// ---------------------------------------------------------------------------------------

function buildDistantTrees(scene) {
  const pineGeo = new THREE.ConeGeometry(1, 1, 7);
  pineGeo.translate(0, 0.5, 0);
  const roundGeo = new THREE.IcosahedronGeometry(1, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });
  const pines = new THREE.InstancedMesh(pineGeo, mat, 90);
  const rounds = new THREE.InstancedMesh(roundGeo, mat, 45);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const haze = new THREE.Color(0x7d7186);
  const place = (im, count, isPine) => {
    for (let i = 0; i < count; i++) {
      let x, z;
      do {
        const a = rand() * Math.PI * 2, r = rr(26, 72);
        x = Math.cos(a) * r; z = Math.sin(a) * r;
      } while (Math.max(Math.abs(x), Math.abs(z)) < 18.5);
      if (isPine) {
        const h = rr(4.5, 9.5), rad = h * rr(0.26, 0.34);
        dummy.position.set(x, rr(-0.5, 0.5), z);
        dummy.scale.set(rad, h, rad);
      } else {
        const r = rr(1.8, 3.4);
        dummy.position.set(x, r * 0.7, z);
        dummy.scale.set(r, r * 0.85, r);
      }
      dummy.rotation.set(0, rand() * 6.28, 0);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
      // aerial perspective: farther trees lean toward a muted violet haze
      const far = THREE.MathUtils.smoothstep(Math.hypot(x, z), 26, 72);
      color.setHSL(rr(0.27, 0.4), rr(0.2, 0.3), rr(0.08, 0.12)).lerp(haze, 0.2 + 0.55 * far);
      im.setColorAt(i, color);
    }
  };
  place(pines, 90, true);
  place(rounds, 45, false);
  scene.add(pines, rounds);
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

/**
 * Populate `scene` with the courtyard environment.
 * @param {THREE.Scene} scene
 * @returns {{ colliders: THREE.Box3[], spawn: THREE.Vector3, spawnYaw: number }}
 */
export function buildScene(scene) {
  rand = mulberry32(20261013); // same layout on every call
  const ctx = { scene, colliders: [], flowers: [[], [], []] };
  const M = makeMaterials();

  buildSky(scene);
  buildLights(scene);
  buildGround(ctx, M);
  buildPerimeter(ctx, M);
  buildGardenWallAndGate(ctx, M);
  buildTerrace(ctx, M);
  buildFountain(ctx, M);
  buildCratesAndDeck(ctx, M);

  // Plaza props
  makeRoundTree(ctx, M, -6.5, 0, 9.5, 1.1);
  makeRoundTree(ctx, M, 7.2, 0, -5.8, 1.0);
  makePine(ctx, M, -6.8, 0, -6.5, 1.1);
  makeLamp(ctx, M, -3.2, 0, 5.5);
  makeLamp(ctx, M, 8.5, 0, 10.5);
  makeBench(ctx, M, 2.5, 0, 5.4, 0);                   // faces the fountain
  makePlanter(ctx, M, -8.9, 0, -10.5, 1.0, 1.0, 0.6);
  makePlanter(ctx, M, -8.9, 0, 10.8, 1.0, 1.0, 0.6);
  makePlanter(ctx, M, 6.5, 0, 13.9, 2.4, 0.8, 0.5);    // flower trough by the south wall
  makePlanter(ctx, M, -1.5, 0, 13.9, 2.4, 0.8, 0.5);

  // Secret garden (x[-14.75,-10.25]) — only reachable through the crouch gate.
  makeRoundTree(ctx, M, -12.6, 0, 10.0, 0.95);
  makeLamp(ctx, M, -12.6, 0, -5.0);
  makeBench(ctx, M, -14.1, 0, 2.5, -Math.PI / 2);      // faces east, toward the gate
  makeBirdbath(ctx, M, -12.4, -10.0);
  makePlanter(ctx, M, -14.2, 0, 6.5, 0.8, 2.6, 0.45);  // flower bed along the west wall
  makePlanter(ctx, M, -12.5, 0, -13.9, 2.6, 0.8, 0.45); // flower bed along the north wall

  buildFlowers(ctx, M);
  buildDistantTrees(scene);

  return {
    colliders: ctx.colliders,
    spawn: new THREE.Vector3(2.5, 0, 11.5),
    spawnYaw: 0, // looking north (-Z): fountain, steps and terrace ahead, crates right, gate left
  };
}
