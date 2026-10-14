import * as THREE from 'three';

// ---- Tuning -------------------------------------------------------------
const GRAVITY = -20;            // m/s²
const JUMP_VELOCITY = 7.5;      // m/s  (apex ≈ 1.4 m)
const TERMINAL_VELOCITY = -40;  // m/s
const WALK_SPEED = 5;           // m/s
const CROUCH_SPEED = 2.5;       // m/s
const GROUND_ACCEL = 14;        // 1/s, exponential approach to target velocity on the ground
const AIR_ACCEL = 3;            // 1/s, reduced air control
const COYOTE_TIME = 0.1;        // s, jump grace after walking off a ledge
const JUMP_BUFFER = 0.1;        // s, jump pressed slightly before landing still fires

const HALF_WIDTH = 0.3;         // player AABB is 0.6 x height x 0.6
const STAND_HEIGHT = 1.8;
const CROUCH_HEIGHT = 1.0;
const EYE_OFFSET = 0.1;         // eye = height - 0.1
const CROUCH_LERP = 12;         // 1/s, height smoothing rate

const LOOK_SENSITIVITY = 0.0022; // rad per pixel
const PITCH_LIMIT = Math.PI / 2 - 0.01;
const MAX_MOUSE_DELTA = 250;     // px, drop browser pointer-lock spikes

const BOB_RATE = 1.5;           // phase radians per metre travelled
const BOB_AMP_Y = 0.035;        // m, vertical bob at full walk speed
const BOB_AMP_X = 0.018;        // m, lateral sway at full walk speed
const BOB_FADE = 8;             // 1/s, bob amplitude fade in/out
const LAND_DIP_PER_MS = 0.012;  // m of camera dip per m/s of impact speed
const LAND_DIP_MAX = 0.12;      // m
const LAND_DIP_RECOVER = 10;    // 1/s

const MAX_SUBSTEP_DIST = 0.2;   // m, substep so fast falls can't tunnel thin boxes
const EPS = 1e-5;
const SKIN = 1e-4;

const MOVE_KEYS = {
  KeyW: 'f', ArrowUp: 'f',
  KeyS: 'b', ArrowDown: 'b',
  KeyA: 'l', ArrowLeft: 'l',
  KeyD: 'r', ArrowRight: 'r',
};

const _box = new THREE.Box3();
const _right = new THREE.Vector3();

/**
 * First-person controller: pointer-lock look, WASD, jump, crouch, AABB collision.
 * Dispatches 'lock' and 'unlock' events.
 */
export class FirstPersonController extends EventTarget {
  constructor(camera, domElement, { colliders = [], spawn, spawnYaw = 0 } = {}) {
    super();
    this.camera = camera;
    this.domElement = domElement;
    this.colliders = colliders;

    this.position = spawn ? spawn.clone() : new THREE.Vector3(); // feet
    this.velocity = new THREE.Vector3();
    this.yaw = spawnYaw;  // rotation about +Y; 0 looks down -Z
    this.pitch = 0;

    this.height = STAND_HEIGHT;
    this._crouched = false;
    this.grounded = false;
    this._coyote = 0;
    this._jumpBuffer = 0;

    this._bobPhase = 0;
    this._bobAmp = 0;
    this._landDip = 0;

    this._keys = { f: false, b: false, l: false, r: false };
    this._crouchHeld = false;
    this._locked = false;
    this._skipMouse = false;

    camera.rotation.order = 'YXZ';

    this._onMouseMove = this._onMouseMove.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onLockChange = this._onLockChange.bind(this);
    this._onBlur = this._clearInput.bind(this);

    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('pointerlockchange', this._onLockChange);
    window.addEventListener('blur', this._onBlur);

    this._resolveStartOverlap();
    this._applyCamera();
  }

  get isLocked() { return this._locked; }
  get isCrouching() { return this._crouched; }

  lock() {
    if (this._locked) return;
    try {
      const p = this.domElement.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* browser refused; overlay stays up */ }
  }

  unlock() {
    if (this._locked) document.exitPointerLock();
  }

  dispose() {
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    window.removeEventListener('blur', this._onBlur);
  }

  // ---- input --------------------------------------------------------------

  _onLockChange() {
    const locked = document.pointerLockElement === this.domElement;
    if (locked === this._locked) return;
    this._locked = locked;
    if (locked) this._skipMouse = true;
    else this._clearInput();
    this.dispatchEvent(new Event(locked ? 'lock' : 'unlock'));
  }

  _onMouseMove(e) {
    if (!this._locked) return;
    if (this._skipMouse) { this._skipMouse = false; return; }
    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    if (Math.abs(dx) > MAX_MOUSE_DELTA || Math.abs(dy) > MAX_MOUSE_DELTA) return;
    this.yaw -= dx * LOOK_SENSITIVITY;
    this.pitch -= dy * LOOK_SENSITIVITY;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
  }

  _onKeyDown(e) {
    if (!this._locked) return;
    const dir = MOVE_KEYS[e.code];
    if (dir) { this._keys[dir] = true; e.preventDefault(); return; }
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) this._jumpBuffer = JUMP_BUFFER;
      return;
    }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this._crouchHeld = true;
  }

  _onKeyUp(e) {
    const dir = MOVE_KEYS[e.code];
    if (dir) { this._keys[dir] = false; return; }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this._crouchHeld = false;
  }

  _clearInput() {
    this._keys.f = this._keys.b = this._keys.l = this._keys.r = false;
    this._crouchHeld = false;
    this._jumpBuffer = 0;
  }

  // ---- simulation -----------------------------------------------------------

  update(dt) {
    if (!(dt > 0)) return;
    const pos = this.position;
    const vel = this.velocity;

    // Crouch (hold). Releasing only stands up once there is room overhead.
    const headroom = this._headroom();
    if (this._crouchHeld) this._crouched = true;
    else if (this._crouched && headroom >= STAND_HEIGHT - EPS) this._crouched = false;
    const targetHeight = this._crouched ? CROUCH_HEIGHT : STAND_HEIGHT;
    let nextHeight = this.height + (targetHeight - this.height) * (1 - Math.exp(-CROUCH_LERP * dt));
    if (Math.abs(targetHeight - nextHeight) < 1e-3) nextHeight = targetHeight;
    if (nextHeight > this.height) nextHeight = Math.min(nextHeight, Math.max(this.height, headroom - SKIN));
    this.height = nextHeight;

    // Desired horizontal velocity from input, relative to yaw.
    const k = this._keys;
    let ix = (k.r ? 1 : 0) - (k.l ? 1 : 0);
    let iz = (k.f ? 1 : 0) - (k.b ? 1 : 0);
    const len = Math.hypot(ix, iz);
    if (len > 0) { ix /= len; iz /= len; }
    const speed = this._crouched ? CROUCH_SPEED : WALK_SPEED;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // forward = (-sin, 0, -cos), right = (cos, 0, -sin)
    const tx = (ix * cos - iz * sin) * speed;
    const tz = (-ix * sin - iz * cos) * speed;
    const accel = this.grounded ? GROUND_ACCEL : AIR_ACCEL;
    const a = 1 - Math.exp(-accel * dt);
    vel.x += (tx - vel.x) * a;
    vel.z += (tz - vel.z) * a;

    // Jump (buffered, with coyote time).
    this._coyote = this.grounded ? COYOTE_TIME : Math.max(0, this._coyote - dt);
    this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);
    if (this._jumpBuffer > 0 && this._coyote > 0) {
      vel.y = JUMP_VELOCITY;
      this._jumpBuffer = 0;
      this._coyote = 0;
      this.grounded = false;
    }

    vel.y = Math.max(TERMINAL_VELOCITY, vel.y + GRAVITY * dt);

    // Integrate with per-axis collision, substepped against tunnelling.
    const wasGrounded = this.grounded;
    const impactSpeed = -vel.y;
    const maxDist = Math.max(Math.abs(vel.x), Math.abs(vel.y), Math.abs(vel.z)) * dt;
    const steps = Math.min(8, Math.max(1, Math.ceil(maxDist / MAX_SUBSTEP_DIST)));
    const h = dt / steps;
    this.grounded = false;
    for (let i = 0; i < steps; i++) {
      pos.x += vel.x * h; this._resolve(0);
      pos.z += vel.z * h; this._resolve(2);
      pos.y += vel.y * h; this._resolve(1);
      if (pos.y <= 0) {
        pos.y = 0;
        if (vel.y < 0) vel.y = 0;
        this.grounded = true;
      }
    }

    if (this.grounded && !wasGrounded && impactSpeed > 4) {
      this._landDip = Math.min(LAND_DIP_MAX, Math.max(this._landDip, impactSpeed * LAND_DIP_PER_MS));
    }
    this._landDip *= Math.exp(-LAND_DIP_RECOVER * dt);

    // Head bob: only while walking on the ground.
    const hSpeed = Math.hypot(vel.x, vel.z);
    const moving = this.grounded && hSpeed > 0.5;
    const ampTarget = moving ? Math.min(1, hSpeed / WALK_SPEED) : 0;
    this._bobAmp += (ampTarget - this._bobAmp) * (1 - Math.exp(-BOB_FADE * dt));
    if (moving) this._bobPhase += hSpeed * BOB_RATE * dt;

    this._applyCamera();
  }

  // Push the player out of any collider along one axis (0=x, 1=y, 2=z).
  _resolve(axis) {
    const pos = this.position;
    const vel = this.velocity;
    this._playerBox(_box);
    for (const c of this.colliders) {
      if (!overlaps(_box, c)) continue;
      if (axis === 0) {
        const pushLeft = vel.x > 0 || (vel.x === 0 && pos.x < (c.min.x + c.max.x) / 2);
        pos.x = pushLeft ? c.min.x - HALF_WIDTH - SKIN : c.max.x + HALF_WIDTH + SKIN;
        vel.x = 0;
      } else if (axis === 2) {
        const pushBack = vel.z > 0 || (vel.z === 0 && pos.z < (c.min.z + c.max.z) / 2);
        pos.z = pushBack ? c.min.z - HALF_WIDTH - SKIN : c.max.z + HALF_WIDTH + SKIN;
        vel.z = 0;
      } else {
        if (vel.y > 0) {
          pos.y = c.min.y - this.height - SKIN; // bonk head
        } else {
          pos.y = c.max.y;                       // land on top
          this.grounded = true;
        }
        vel.y = 0;
      }
      this._playerBox(_box);
    }
  }

  _playerBox(out) {
    const p = this.position;
    out.min.set(p.x - HALF_WIDTH, p.y, p.z - HALF_WIDTH);
    out.max.set(p.x + HALF_WIDTH, p.y + this.height, p.z + HALF_WIDTH);
    return out;
  }

  // Vertical clearance above the feet before the nearest overhead collider.
  _headroom() {
    const p = this.position;
    let ceiling = Infinity;
    for (const c of this.colliders) {
      if (c.max.x <= p.x - HALF_WIDTH + EPS || c.min.x >= p.x + HALF_WIDTH - EPS) continue;
      if (c.max.z <= p.z - HALF_WIDTH + EPS || c.min.z >= p.z + HALF_WIDTH - EPS) continue;
      if (c.max.y <= p.y + EPS) continue; // below the feet (e.g. the box we stand on)
      if (c.min.y < ceiling) ceiling = c.min.y;
    }
    return ceiling - p.y;
  }

  // If spawn lands inside geometry, lift the player onto whatever it overlaps.
  _resolveStartOverlap() {
    for (let i = 0; i < 8; i++) {
      this._playerBox(_box);
      let moved = false;
      for (const c of this.colliders) {
        if (overlaps(_box, c)) { this.position.y = c.max.y; moved = true; break; }
      }
      if (!moved) break;
    }
    if (this.position.y < 0) this.position.y = 0;
  }

  _applyCamera() {
    const cam = this.camera;
    cam.rotation.set(this.pitch, this.yaw, 0);
    const bobY = Math.sin(this._bobPhase * 2) * BOB_AMP_Y * this._bobAmp;
    const bobX = Math.sin(this._bobPhase) * BOB_AMP_X * this._bobAmp;
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    cam.position.copy(this.position);
    cam.position.y += this.height - EYE_OFFSET + bobY - this._landDip;
    cam.position.addScaledVector(_right, bobX);
  }
}

function overlaps(a, b) {
  return a.min.x < b.max.x - EPS && a.max.x > b.min.x + EPS &&
         a.min.y < b.max.y - EPS && a.max.y > b.min.y + EPS &&
         a.min.z < b.max.z - EPS && a.max.z > b.min.z + EPS;
}
