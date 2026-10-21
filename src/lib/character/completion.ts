import type { Pixels } from "./types";

const backgrounds = ["#00ff00", "#ff00ff", "#00ffff", "#ff8000"];
const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

/** Choose a chroma background least likely to remove this sprite's actual colours. */
export function completionBackground(source: Pixels): string {
  let best = backgrounds[0],
    least = Infinity;
  for (const color of backgrounds) {
    const c = rgb(color);
    let count = 0;
    for (let i = 0; i < source.data.length; i += 4)
      if (
        source.data[i + 3] &&
        Math.max(
          Math.abs(source.data[i] - c[0]),
          Math.abs(source.data[i + 1] - c[1]),
          Math.abs(source.data[i + 2] - c[2]),
        ) < 90
      )
        count++;
    if (count < least) {
      best = color;
      least = count;
    }
  }
  return best;
}

/** Key only provider-generated candidates; original and manually imported art stay untouched. */
export function removeCompletionBackground(candidate: Pixels, color: string): Pixels {
  const c = rgb(color),
    data = new Uint8ClampedArray(candidate.data);
  for (let i = 0; i < data.length; i += 4) {
    const distance = Math.max(
      Math.abs(data[i] - c[0]),
      Math.abs(data[i + 1] - c[1]),
      Math.abs(data[i + 2] - c[2]),
    );
    if (distance < 80) data.fill(0, i, i + 4);
  }
  return { width: candidate.width, height: candidate.height, data };
}
