import { clipFor, type AnimationSet, type Role } from "./set";

export interface BridgeState {
  route: number;
  sourceFrame: number;
  steps: number;
  leadSeconds: number;
}
export interface PoseFrame {
  role: Role;
  frame: number;
  clipId?: string;
}
export const clipSeconds = (set: AnimationSet, id: string) =>
  set.clips[id].durations.reduce((a, b) => a + b, 0) / 1000;
export function sampleClip(set: AnimationSet, id: string, seconds: number) {
  const clip = set.clips[id];
  let ms = Math.max(0, seconds * 1000);
  for (let i = 0; i < clip.count; i++) {
    if (ms < clip.durations[i]) return i;
    ms -= clip.durations[i];
  }
  return clip.count - 1;
}
export function idleEntrySeconds(set: AnimationSet, route: number) {
  const entry = set.controller!.idleTransitions![route].idleFrame;
  return (
    clipFor(set, "idle")
      .clip.durations.slice(0, entry)
      .reduce((a, b) => a + b, 0) / 1000
  );
}
export function chooseIdleBridge(
  set: AnimationSet,
  from: Role,
  sourceFrame: number,
): BridgeState | null {
  const clip = clipFor(set, from).clip;
  const candidates = (set.controller?.idleTransitions ?? [])
    .map((r, route) => ({ r, route, steps: (r.exitFrame - sourceFrame + clip.count) % clip.count }))
    .filter(({ r }) => r.from === from && r.enabled)
    .sort((a, b) => a.steps - b.steps);
  const selected = candidates[0];
  if (!selected) return null;
  let nativeMs = 0;
  for (let i = 0; i < selected.steps; i++)
    nativeMs += clip.durations[(sourceFrame + i) % clip.count];
  return {
    route: selected.route,
    sourceFrame,
    steps: selected.steps,
    leadSeconds: Math.min(nativeMs, selected.r.leadMs) / 1000,
  };
}
function recoveryStart(set: AnimationSet, route: number) {
  const r = set.controller!.idleTransitions![route];
  return set.clips[r.clip].durations.slice(0, r.entryFrame).reduce((a, b) => a + b, 0) / 1000;
}
function recoverySeconds(set: AnimationSet, route: number) {
  return clipSeconds(set, set.controller!.idleTransitions![route].clip) - recoveryStart(set, route);
}
export function bridgeSeconds(set: AnimationSet, state: BridgeState) {
  return state.leadSeconds + recoverySeconds(set, state.route);
}
export function bridgeFrame(set: AnimationSet, state: BridgeState, seconds: number): PoseFrame {
  const route = set.controller!.idleTransitions![state.route];
  if (seconds < state.leadSeconds) {
    const clip = clipFor(set, route.from).clip;
    const step = Math.min(
      state.steps,
      Math.floor((seconds / state.leadSeconds) * (state.steps + 1)),
    );
    return { role: route.from, frame: (state.sourceFrame + step) % clip.count };
  }
  return {
    role: "idle",
    clipId: route.clip,
    frame: sampleClip(
      set,
      route.clip,
      recoveryStart(set, state.route) + seconds - state.leadSeconds,
    ),
  };
}
/** Isolated endpoint/bridge/idle review. Source and target use exact saved frames. */
export function reviewBridgeSeconds(set: AnimationSet, index: number) {
  return 0.2 + recoverySeconds(set, index) + 0.8;
}
export function reviewBridgeFrame(set: AnimationSet, index: number, seconds: number): PoseFrame {
  const route = set.controller!.idleTransitions![index],
    duration = recoverySeconds(set, index);
  const t = Math.min(Math.max(0, seconds), reviewBridgeSeconds(set, index));
  if (t < 0.2) return { role: route.from, frame: route.exitFrame };
  if (t < 0.2 + duration)
    return {
      role: "idle",
      clipId: route.clip,
      frame: sampleClip(set, route.clip, recoveryStart(set, index) + t - 0.2),
    };
  const idle = clipFor(set, "idle");
  return {
    role: "idle",
    frame: sampleClip(
      set,
      idle.id,
      (idleEntrySeconds(set, index) + t - 0.2 - duration) % clipSeconds(set, idle.id),
    ),
  };
}
