import { composite, insidePolygon, pixels } from "./core";
import type { CharacterPlan, CharacterPart, Pixels } from "./types";
/** An authored, offline test figure. No provider calls or generated-image claims. */
export function characterDemo() {
  const rect = (x: number, y: number, w: number, h: number) => [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
  const part = (
    id: string,
    name: string,
    parent: string | null,
    x: number,
    y: number,
    poly: CharacterPart["polygon"],
    tip = { x, y: y + 50 },
  ): CharacterPart => ({
    id,
    name,
    parent,
    pivot: { x, y },
    tip,
    polygon: poly,
    description: "Offline joint-test figure",
  });
  const plan: CharacterPlan = {
    version: 1,
    width: 384,
    height: 512,
    origin: { x: 192, y: 470 },
    notes: ["Authored offline example. AI planning has not run."],
    parts: [
      part(
        "rear-arm",
        "Rear arm",
        "torso",
        156,
        186,
        [
          { x: 148, y: 180 },
          { x: 172, y: 195 },
          { x: 133, y: 304 },
          { x: 104, y: 291 },
        ],
        { x: 119, y: 294 },
      ),
      part("rear-leg", "Rear thigh", "torso", 170, 307, rect(141, 292, 46, 102), {
        x: 158,
        y: 378,
      }),
      part("rear-shin", "Rear shin", "rear-leg", 158, 378, rect(138, 368, 35, 98), {
        x: 153,
        y: 460,
      }),
      part("rear-foot", "Rear foot", "rear-shin", 153, 455, rect(130, 450, 60, 20), {
        x: 183,
        y: 465,
      }),
      part(
        "torso",
        "Coat / torso",
        null,
        192,
        310,
        [
          { x: 149, y: 161 },
          { x: 232, y: 161 },
          { x: 248, y: 325 },
          { x: 135, y: 325 },
        ],
        { x: 192, y: 170 },
      ),
      part(
        "head",
        "Head",
        "torso",
        193,
        169,
        [
          { x: 158, y: 158 },
          { x: 143, y: 109 },
          { x: 161, y: 64 },
          { x: 207, y: 54 },
          { x: 239, y: 83 },
          { x: 280, y: 114 },
          { x: 230, y: 137 },
          { x: 220, y: 165 },
        ],
        { x: 205, y: 96 },
      ),
      part(
        "front-leg",
        "Front thigh",
        "torso",
        215,
        309,
        [
          { x: 195, y: 295 },
          { x: 231, y: 289 },
          { x: 260, y: 382 },
          { x: 218, y: 396 },
        ],
        { x: 239, y: 384 },
      ),
      part(
        "front-shin",
        "Front shin",
        "front-leg",
        239,
        384,
        [
          { x: 220, y: 375 },
          { x: 252, y: 374 },
          { x: 265, y: 461 },
          { x: 234, y: 466 },
        ],
        { x: 250, y: 459 },
      ),
      part("front-foot", "Front foot", "front-shin", 250, 457, rect(234, 448, 72, 22), {
        x: 299,
        y: 460,
      }),
      part(
        "upper-arm",
        "Upper arm",
        "torso",
        222,
        190,
        [
          { x: 209, y: 180 },
          { x: 239, y: 180 },
          { x: 256, y: 249 },
          { x: 223, y: 261 },
        ],
        { x: 242, y: 250 },
      ),
      part(
        "forearm",
        "Forearm",
        "upper-arm",
        242,
        250,
        [
          { x: 227, y: 237 },
          { x: 251, y: 234 },
          { x: 286, y: 270 },
          { x: 267, y: 293 },
        ],
        { x: 277, y: 279 },
      ),
      part("hand", "Hand", "forearm", 277, 279, rect(264, 263, 35, 35), { x: 294, y: 279 }),
    ],
  };
  const colors = [
    [95, 78, 69],
    [52, 64, 78],
    [139, 111, 86],
    [76, 65, 56],
    [143, 61, 49],
    [183, 147, 102],
    [56, 69, 87],
    [170, 136, 96],
    [86, 72, 58],
    [153, 67, 54],
    [160, 75, 59],
    [190, 152, 110],
  ];
  const completions: Record<string, Pixels> = {};
  const images = plan.parts.map((p, i) => {
    const im = pixels(plan.width, plan.height);
    for (let y = 0; y < im.height; y++)
      for (let x = 0; x < im.width; x++)
        if (insidePolygon(x + 0.5, y + 0.5, p.polygon)) {
          const k = (y * im.width + x) * 4;
          im.data.set([...colors[i], 255], k);
        }
    completions[p.id] = im;
    return im;
  });
  // Eye and coat buttons are part of the source artwork and must survive extraction byte-for-byte.
  const head = images[5];
  for (let y = 93; y < 102; y++)
    for (let x = 216; x < 224; x++) head.data.set([38, 31, 28, 255], (y * 384 + x) * 4);
  const coat = images[4];
  for (const cy of [215, 247, 279])
    for (let y = cy - 3; y < cy + 3; y++)
      for (let x = 190; x < 196; x++) coat.data.set([218, 184, 112, 255], (y * 384 + x) * 4);
  return { source: composite(images), plan, completions };
}
