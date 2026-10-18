/** Locate a frame on a variable-hold timeline, including wraparound. */
export function frameAtTime(durations: readonly number[], elapsedMs: number): number {
  const total = durations.reduce((sum, ms) => sum + ms, 0);
  if (total <= 0) return 0;
  let position = ((elapsedMs % total) + total) % total;
  for (let i = 0; i < durations.length; i++) {
    position -= durations[i];
    if (position < 0) return i;
  }
  return 0;
}
