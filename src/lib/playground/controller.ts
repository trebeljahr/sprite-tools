import {
  bridgeFrame,
  bridgeSeconds,
  chooseIdleBridge,
  idleEntrySeconds,
  type BridgeState,
  type PoseFrame,
} from "./transitions";
import { clipFor, frameAt, roleDuration, type AnimationSet, type Role } from "./set";
export interface Input {
  axis: number;
  sprint: boolean;
  jump: boolean;
  roll: boolean;
  attack: boolean;
  crouch?: boolean;
  lowAttack?: boolean;
}
export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  grounded: boolean;
  motion: Role | "land" | "settle" | "transition" | "hold";
  heldPose: (PoseFrame & { time: number }) | null;
  bridge: BridgeState | null;
  time: number;
  jumpAge: number;
  attack: number;
  queuedStab: boolean;
  queuedCrouchAttack: boolean;
  attackBuffer: number;
  jumpBuffer: number;
  rollCooldown: number;
  gaitPhase: number;
  settleFrom: { role: Role; frame: number; time: number } | null;
}
export const IDLE_BLEND_SECONDS = 0.24;
export const VIEWPORT = { width: 1280, height: 600 };
export const WORLD = {
  left: -3200,
  width: 7680,
  height: 600,
  ground: 500,
  platforms: [
    { x: 310, y: 320, width: 220 },
    { x: 795, y: 200, width: 260 },
    { x: -1490, y: 320, width: 220 },
    { x: -1005, y: 200, width: 260 },
    { x: -2700, y: 340, width: 260 },
    { x: 2110, y: 320, width: 220 },
    { x: 2595, y: 200, width: 260 },
    { x: 3800, y: 340, width: 260 },
  ],
};
const movement = {
  walk: 350,
  run: 1600,
  roll: 720,
  jump: 820,
  gravity: 1650,
  groundAcceleration: 2600,
  runAcceleration: 10000,
  airAcceleration: 800,
};
export function createBody(): Body {
  return {
    x: 180,
    y: 500,
    vx: 0,
    vy: 0,
    facing: 1,
    grounded: true,
    motion: "idle",
    heldPose: null,
    bridge: null,
    time: 0,
    jumpAge: 0,
    attack: 0,
    queuedStab: false,
    queuedCrouchAttack: false,
    attackBuffer: 0,
    jumpBuffer: 0,
    rollCooldown: 0,
    gaitPhase: 0,
    settleFrom: null,
  };
}
const attackRole = (n: number): Role => `attack${(n % 3) + 1}` as Role;
const attacking = (s: Body) =>
  s.motion.startsWith("attack") || s.motion === "lowAttack" || s.motion === "crouchAttack";
const crouching = (s: Body) =>
  s.motion === "crouchDown" ||
  s.motion === "crouch" ||
  s.motion === "crouchUp" ||
  s.motion === "crouchAttack";
function begin(s: Body, role: Body["motion"]) {
  s.motion = role;
  s.time = 0;
  if (role !== "hold") s.heldPose = null;
  if (role !== "transition") s.bridge = null;
  if (role !== "settle") s.settleFrom = null;
}
function startAttack(s: Body, stab = false) {
  begin(s, stab ? "attack2" : attackRole(s.attack++));
  if (stab) s.attack = 2;
  s.attackBuffer = 0;
}
function holdPose(s: Body, set: AnimationSet) {
  const pose = { ...bodyFrame(s, set), time: s.time };
  begin(s, "hold");
  s.heldPose = pose;
}
function startIdleBridge(s: Body, set: AnimationSet, role: Role) {
  if (set.controller?.restPose === "hold") return false;
  const bridge = chooseIdleBridge(set, role, bodyFrame(s, set).frame);
  if (!bridge) return false;
  begin(s, "transition");
  s.bridge = bridge;
  return true;
}
function settleIntoIdle(s: Body, set: AnimationSet) {
  if (set.controller?.restPose === "hold") {
    holdPose(s, set);
    return;
  }
  const source = bodyFrame(s, set).role;
  if (startIdleBridge(s, set, source)) return;
  const from = { ...bodyFrame(s, set), time: s.time };
  begin(s, "settle");
  s.settleFrom = from;
}
const approach = (a: number, b: number, delta: number) =>
  a < b ? Math.min(b, a + delta) : Math.max(b, a - delta);
export function stepBody(previous: Body, input: Input, delta: number, set: AnimationSet): Body {
  const s = { ...previous };
  const dt = Math.max(0, Math.min(delta, 1 / 30));
  if (!dt) return s;
  s.time += dt;
  if (set.controller?.restPose === "hold") {
    // A resting character needs no new artwork or intermediate image blend.
    if (s.motion === "idle" || s.motion === "settle" || s.motion === "transition") holdPose(s, set);
  } else if (s.motion === "hold") begin(s, "idle");
  s.jumpAge += dt;
  s.rollCooldown = Math.max(0, s.rollCooldown - dt);
  s.attackBuffer = Math.max(0, s.attackBuffer - dt);
  s.jumpBuffer = Math.max(0, s.jumpBuffer - dt);
  const canCrouch = !!(set.bindings.crouchDown && set.bindings.crouch && set.bindings.crouchUp);
  const wantsCrouch = !!input.crouch && s.grounded && canCrouch;
  if (input.jump)
    s.jumpBuffer = crouching(s)
      ? roleDuration(set, "crouchUp") +
        (s.motion === "crouchDown" ? Math.max(0, roleDuration(set, "crouchDown") - s.time) : 0) +
        0.15
      : 0.13;
  if (input.attack) {
    if (
      (wantsCrouch ||
        s.motion === "crouchDown" ||
        s.motion === "crouch" ||
        s.motion === "crouchAttack") &&
      set.bindings.crouchAttack
    )
      s.queuedCrouchAttack = true;
    else if (s.motion === "roll") s.queuedStab = true;
    else s.attackBuffer = 0.18;
  }
  const axis = Math.sign(input.axis);
  if (s.motion !== "roll" && !attacking(s) && axis) s.facing = axis as 1 | -1;
  if (s.motion === "crouchDown" && s.time >= roleDuration(set, "crouchDown")) begin(s, "crouch");
  if (s.motion === "crouchAttack" && s.time >= roleDuration(set, "crouchAttack")) {
    begin(s, "crouch");
  }
  if (s.motion === "crouch") {
    if (s.queuedCrouchAttack && set.bindings.crouchAttack && !s.jumpBuffer) {
      s.queuedCrouchAttack = false;
      s.attackBuffer = 0;
      begin(s, "crouchAttack");
    } else if (!wantsCrouch || s.jumpBuffer > 0) {
      s.queuedCrouchAttack = false;
      begin(s, "crouchUp");
    }
  } else if (s.motion === "crouchUp" && s.time >= roleDuration(set, "crouchUp")) {
    s.queuedCrouchAttack = false;
    settleIntoIdle(s, set);
  }
  if (s.motion === "transition" && s.bridge) {
    const end = bridgeSeconds(set, s.bridge);
    if (s.time >= end) {
      const route = set.controller!.idleTransitions![s.bridge.route];
      if (route.from === "walk" || route.from === "run") {
        const clip = clipFor(set, route.from).clip;
        const elapsed = clip.durations
          .slice(0, route.resumeFrame ?? route.exitFrame)
          .reduce((a, b) => a + b, 0);
        s.gaitPhase =
          (elapsed / clip.durations.reduce((a, b) => a + b, 0) -
            (clip.locomotion?.phaseOffset ?? 0) +
            1) %
          1;
      }
      const idleTime = idleEntrySeconds(set, s.bridge.route) + s.time - end;
      begin(s, "idle");
      s.time = idleTime;
      if (!axis) s.vx = 0;
    } else if (axis) begin(s, s.grounded ? (input.sprint ? "run" : "walk") : "jump");
  }
  if (s.motion === "roll" && s.time >= roleDuration(set, "roll")) {
    s.rollCooldown = 0.15;
    if (s.queuedStab) {
      s.queuedStab = false;
      startAttack(s, true);
    } else if (s.grounded) settleIntoIdle(s, set);
    else begin(s, "jump");
  } else if (attacking(s) && s.time >= roleDuration(set, s.motion as Role)) {
    if (s.attackBuffer > 0) startAttack(s);
    else if (s.grounded) settleIntoIdle(s, set);
    else begin(s, "jump");
  } else if (s.motion === "land" && s.time >= 0.14) settleIntoIdle(s, set);
  else if (s.motion === "settle" && s.time >= IDLE_BLEND_SECONDS) {
    // Idle has already been playing during the blend. Keep its clock running.
    s.motion = "idle";
    s.settleFrom = null;
  }
  const locked = s.motion === "roll" || attacking(s) || crouching(s);
  if (!locked) {
    if (s.jumpBuffer > 0 && s.grounded) {
      s.vy = -movement.jump;
      s.grounded = false;
      s.jumpBuffer = 0;
      s.jumpAge = 0;
      begin(s, "jump");
    } else if (input.roll && s.grounded && !s.rollCooldown) {
      begin(s, "roll");
      s.queuedStab = input.attack;
      if (input.attack) s.attackBuffer = 0;
    }
    if (s.motion !== "roll" && s.grounded && wantsCrouch && !s.jumpBuffer) {
      begin(s, "crouchDown");
      s.attackBuffer = 0;
    } else if (s.motion !== "roll" && input.lowAttack && set.bindings.lowAttack) {
      begin(s, "lowAttack");
      s.attackBuffer = 0;
    } else if (s.motion !== "roll" && s.attackBuffer > 0) startAttack(s);
  }
  if (s.grounded && !axis && (s.motion === "walk" || s.motion === "run"))
    startIdleBridge(s, set, s.motion);
  if (s.motion === "roll") s.vx = s.facing * movement.roll;
  else {
    const target = crouching(s)
      ? 0
      : axis * (input.sprint ? runSpeedFor(set) : movement.walk) * (attacking(s) ? 0.32 : 1);
    const groundAcceleration =
      input.sprint || Math.abs(s.vx) > movement.walk
        ? movement.runAcceleration
        : movement.groundAcceleration;
    s.vx = approach(
      s.vx,
      target,
      (s.grounded ? groundAcceleration : movement.airAcceleration) * dt,
    );
  }
  const oldY = s.y;
  const left = WORLD.left + 340,
    right = WORLD.left + WORLD.width - 340;
  s.x = Math.max(left, Math.min(right, s.x + s.vx * dt));
  if ((s.x === left && s.vx < 0) || (s.x === right && s.vx > 0)) s.vx = 0;
  s.vy += movement.gravity * dt;
  s.y += s.vy * dt;
  s.grounded = false;
  const floors = [...WORLD.platforms, { x: WORLD.left, y: WORLD.ground, width: WORLD.width }];
  if (s.vy >= 0)
    for (const floor of floors) {
      if (
        s.x >= floor.x &&
        s.x <= floor.x + floor.width &&
        oldY <= floor.y + 0.001 &&
        s.y >= floor.y
      ) {
        s.y = floor.y;
        s.vy = 0;
        s.grounded = true;
        break;
      }
    }
  if (!previous.grounded && s.grounded && !attacking(s) && s.motion !== "roll") {
    if (!startIdleBridge(s, set, "jump")) begin(s, "land");
  }
  if (
    s.motion !== "roll" &&
    !attacking(s) &&
    !crouching(s) &&
    s.motion !== "land" &&
    s.motion !== "transition" &&
    (s.motion !== "settle" || axis !== 0 || !s.grounded) &&
    (s.motion !== "hold" || axis !== 0 || !s.grounded)
  ) {
    const next: Role = !s.grounded
      ? "jump"
      : Math.abs(s.vx) > 12
        ? !axis && (s.motion === "walk" || s.motion === "run")
          ? s.motion
          : input.sprint
            ? "run"
            : "walk"
        : "idle";
    if (s.motion !== next) {
      if (next === "idle" && (s.motion === "walk" || s.motion === "run")) {
        settleIntoIdle(s, set);
      } else begin(s, next);
    }
  }
  if (s.grounded && (s.motion === "walk" || s.motion === "run")) {
    // Run cadence has its own clock rate; changing travel speed must not quicken the feet.
    const stride =
      s.motion === "run" ? (runSpeedFor(set) * runCycleMsFor(set)) / 1000 : strideFor(set, "walk");
    s.gaitPhase = (s.gaitPhase + Math.abs(s.x - previous.x) / stride) % 1;
  }
  if (s.motion === "transition" && !s.grounded) begin(s, "jump");
  return s;
}
export function runSpeedFor(set: AnimationSet) {
  return set.controller?.runSpeed ?? movement.run;
}
export function runCycleMsFor(set: AnimationSet) {
  return set.controller?.runCycleMs ?? roleDuration(set, "run") * 1000;
}
export function strideFor(set: AnimationSet, role: "walk" | "run") {
  return clipFor(set, role).clip.locomotion?.stridePixels ?? (role === "run" ? 260 : 220);
}
export function bodyFrame(s: Body, set: AnimationSet): PoseFrame {
  if (s.motion === "hold" && s.heldPose) {
    const { role, frame, clipId } = s.heldPose;
    return clipId ? { role, frame, clipId } : { role, frame };
  }
  if (s.motion === "transition" && s.bridge) return bridgeFrame(set, s.bridge, s.time);
  const role: Role =
      s.motion === "land"
        ? "jump"
        : s.motion === "settle" || s.motion === "transition" || s.motion === "hold"
          ? "idle"
          : s.motion,
    { clip } = clipFor(set, role);
  if (s.motion === "walk" || s.motion === "run") {
    const phase = (s.gaitPhase + (clip.locomotion?.phaseOffset ?? 0)) % 1;
    return { role, frame: frameAt(set, role, phase * roleDuration(set, role), true) };
  }
  if ((s.motion === "jump" || s.motion === "land") && set.bindings.jump) {
    const p = clip.phase;
    if (s.motion === "land" && p?.land)
      return {
        role,
        frame: Math.round(p.land.from + Math.min(1, s.time / 0.14) * (p.land.to - p.land.from)),
      };
    if (s.jumpAge < 0.1 && p?.takeoff)
      return {
        role,
        frame: Math.floor(p.takeoff.from + (s.jumpAge / 0.1) * (p.takeoff.to - p.takeoff.from)),
      };
    if (p?.air) {
      const q = Math.max(0, Math.min(1, (s.vy + movement.jump) / (movement.jump * 2)));
      return { role, frame: Math.round(p.air.from + q * (p.air.to - p.air.from)) };
    }
  }
  return {
    role,
    frame: frameAt(set, role, s.time, clip.loop && !attacking(s) && s.motion !== "roll"),
  };
}
export interface Preview {
  role: Role;
  time: number;
  queued: Role | null;
}
export function stepPreview(prev: Preview, dt: number, set: AnimationSet): Preview {
  const s = { ...prev, time: prev.time + Math.max(0, Math.min(dt, 0.1)) };
  const length = roleDuration(set, s.role);
  if (s.time >= length) {
    if (s.queued) {
      s.role = s.queued;
      s.queued = null;
      s.time = 0;
    } else if (clipFor(set, s.role).clip.loop || s.role === "run" || s.role === "roll")
      s.time %= length;
    else {
      s.role = "idle";
      s.time = 0;
    }
  }
  return s;
}
