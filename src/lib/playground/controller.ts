import { clipFor, frameAt, roleDuration, type AnimationSet, type Role } from "./set";
export interface Input {
  axis: number;
  sprint: boolean;
  jump: boolean;
  roll: boolean;
  attack: boolean;
}
export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  grounded: boolean;
  motion: Role | "land";
  time: number;
  jumpAge: number;
  attack: number;
  queuedStab: boolean;
  attackBuffer: number;
  jumpBuffer: number;
  rollCooldown: number;
}
export const WORLD = {
  width: 1280,
  height: 600,
  ground: 500,
  platforms: [
    { x: 310, y: 410, width: 170 },
    { x: 795, y: 340, width: 190 },
  ],
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
    time: 0,
    jumpAge: 0,
    attack: 0,
    queuedStab: false,
    attackBuffer: 0,
    jumpBuffer: 0,
    rollCooldown: 0,
  };
}
const attackRole = (n: number): Role => `attack${(n % 3) + 1}` as Role;
const attacking = (s: Body) => s.motion.startsWith("attack");
function begin(s: Body, role: Role | "land") {
  s.motion = role;
  s.time = 0;
}
function startAttack(s: Body, stab = false) {
  begin(s, stab ? "attack2" : attackRole(s.attack++));
  if (stab) s.attack = 2;
  s.attackBuffer = 0;
}
const approach = (a: number, b: number, delta: number) =>
  a < b ? Math.min(b, a + delta) : Math.max(b, a - delta);
export function stepBody(previous: Body, input: Input, delta: number, set: AnimationSet): Body {
  const s = { ...previous };
  const dt = Math.max(0, Math.min(delta, 1 / 30));
  if (!dt) return s;
  s.time += dt;
  s.jumpAge += dt;
  s.rollCooldown = Math.max(0, s.rollCooldown - dt);
  s.attackBuffer = Math.max(0, s.attackBuffer - dt);
  s.jumpBuffer = Math.max(0, s.jumpBuffer - dt);
  if (input.jump) s.jumpBuffer = 0.13;
  if (input.attack) {
    if (s.motion === "roll") s.queuedStab = true;
    else s.attackBuffer = 0.18;
  }
  const axis = Math.sign(input.axis);
  if (s.motion !== "roll" && !attacking(s) && axis) s.facing = axis as 1 | -1;
  if (s.motion === "roll" && s.time >= roleDuration(set, "roll")) {
    s.rollCooldown = 0.15;
    if (s.queuedStab) {
      s.queuedStab = false;
      startAttack(s, true);
    } else begin(s, s.grounded ? "idle" : "jump");
  } else if (attacking(s) && s.time >= roleDuration(set, s.motion as Role)) {
    if (s.attackBuffer > 0) startAttack(s);
    else begin(s, s.grounded ? "idle" : "jump");
  } else if (s.motion === "land" && s.time >= 0.14) begin(s, "idle");
  const locked = s.motion === "roll" || attacking(s);
  if (!locked) {
    if (s.jumpBuffer > 0 && s.grounded) {
      s.vy = -610;
      s.grounded = false;
      s.jumpBuffer = 0;
      s.jumpAge = 0;
      begin(s, "jump");
    } else if (input.roll && s.grounded && !s.rollCooldown) {
      begin(s, "roll");
      s.queuedStab = input.attack;
      if (input.attack) s.attackBuffer = 0;
    }
    if (s.motion !== "roll" && s.attackBuffer > 0) startAttack(s);
  }
  if (s.motion === "roll") s.vx = s.facing * 410;
  else {
    const target = axis * (input.sprint ? 310 : 155) * (attacking(s) ? 0.32 : 1);
    s.vx = approach(s.vx, target, (s.grounded ? 1850 : 600) * dt);
  }
  const oldY = s.y;
  s.x = Math.max(110, Math.min(WORLD.width - 110, s.x + s.vx * dt));
  s.vy += 1650 * dt;
  s.y += s.vy * dt;
  s.grounded = false;
  const floors = [...WORLD.platforms, { x: 0, y: WORLD.ground, width: WORLD.width }];
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
  if (!previous.grounded && s.grounded && !attacking(s) && s.motion !== "roll") begin(s, "land");
  if (s.motion !== "roll" && !attacking(s) && s.motion !== "land") {
    const next: Role = !s.grounded
      ? "jump"
      : Math.abs(s.vx) > 12
        ? input.sprint
          ? "run"
          : "walk"
        : "idle";
    if (s.motion !== next) begin(s, next);
  }
  return s;
}
export function bodyFrame(s: Body, set: AnimationSet) {
  const role: Role = s.motion === "land" ? "jump" : s.motion,
    { clip } = clipFor(set, role);
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
      const q = Math.max(0, Math.min(1, (s.vy + 610) / 1220));
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
