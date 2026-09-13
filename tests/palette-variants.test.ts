// Ramp detection, OKLCH re-tinting and variant generation.
//
// The contractual invariants here are all *structural*: a remapped ramp has to
// keep the artist's shading intact, not merely end up "a bit bluer". So the
// fixtures below use deliberately UNEVEN lightness steps (a real sprite ramp
// has a wider shadow gap than highlight gap) — an implementation that quietly
// redistributes lightness evenly would pass an "ordering is preserved" test but
// fails the ratio assertions here.

import { describe, expect, it } from "vitest";
import { applyPaletteSwap, extractPalette, hexToRgb, rgbToHex } from "@/lib/palette/extract";
import { hueDelta, hueDistance, oklchToRgb, rgbToOklch, rotateHue } from "@/lib/palette/oklab";
import { detectRamps, type Ramp, rampBaseColor, remapRamp } from "@/lib/palette/ramps";
import type { RGB } from "@/lib/pixel-art/pixelate";
import {
  describeRamps,
  hueShiftVariants,
  parseVariantSet,
  resolveVariant,
  slugifyVariantName,
  variantFileName,
} from "@/lib/palette/variants";

/**
 * A red shirt ramp with uneven lightness spacing (Oklab L gaps ~0.091, 0.080,
 * 0.198, 0.161) and the usual hand-authored hue drift: shadows pulled toward
 * magenta, the highlight toward yellow. Generated once from OKLCH targets and
 * frozen as hex so the fixture can't drift with the conversion code.
 */
const RED_RAMP = ["#3f121d", "#681a27", "#8d242a", "#cb6855", "#e7ab90"];
/** Blue armour + a grey ramp, none of which may move when the reds are re-tinted. */
const BLUE_RAMP = ["#12304a", "#255a86", "#4e9bd1"];
const GREYS = ["#141414", "#7e7e7e", "#e8e8e8"];
const SPRITE_PALETTE_HEX = [...RED_RAMP, ...BLUE_RAMP, ...GREYS];

function palette(hex: string[] = SPRITE_PALETTE_HEX): RGB[] {
  return hex.map(hexToRgb);
}

function rampContaining(ramps: Ramp[], hex: string): Ramp {
  const ramp = ramps.find((r) => r.colors.some((c) => rgbToHex(c) === hex));
  if (!ramp) throw new Error(`no ramp contains ${hex}`);
  return ramp;
}

/** Apply a swap list to a ramp's colours, in the ramp's own (ascending-L) order. */
function applySwapsToRamp(ramp: Ramp, swaps: { from: RGB; to: RGB }[]): RGB[] {
  const map = new Map(swaps.map((s) => [rgbToHex(s.from), s.to]));
  return ramp.colors.map((c) => map.get(rgbToHex(c)) ?? c);
}

function lightnesses(colors: RGB[]): number[] {
  return colors.map((c) => rgbToOklch(c).l);
}

function gaps(values: number[]): number[] {
  return values.slice(1).map((v, i) => v - values[i]);
}

/** Ratio of each consecutive-gap pair — the shape of the ramp, scale-free. */
function gapRatios(values: number[]): number[] {
  const g = gaps(values);
  return g.slice(1).map((v, i) => v / g[i]);
}

/**
 * One opaque pixel-column per palette colour, with the bottom row transparent
 * so every colour also appears behind alpha 0.
 */
function stripe(colors: RGB[], transparentRow = true): ImageData {
  const img = new ImageData(colors.length * 2, 4);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const c = colors[Math.floor(x / 2)];
      const i = (y * img.width + x) * 4;
      img.data[i] = c.r;
      img.data[i + 1] = c.g;
      img.data[i + 2] = c.b;
      img.data[i + 3] = transparentRow && y === img.height - 1 ? 0 : 255;
    }
  }
  return img;
}

describe("remapRamp — structure preservation", () => {
  // Contractual: a re-tint moves the ramp, it does not reshape it.
  const targets = ["#4d7faf", "#2f8f3a", "#8f7f20"];

  it.each(targets)("preserves L ordering and relative step sizes (-> %s)", (target) => {
    const ramps = detectRamps(palette());
    const red = rampContaining(ramps, "#8d242a");
    expect(red.colors.map(rgbToHex)).toEqual(RED_RAMP);

    const before = lightnesses(red.colors);
    const after = lightnesses(applySwapsToRamp(red, remapRamp(red, hexToRgb(target))));

    // Ordering: strictly ascending, no two shades collapsing onto each other.
    for (let i = 1; i < after.length; i++) expect(after[i]).toBeGreaterThan(after[i - 1]);

    // Shape: the ratios between consecutive L gaps survive. The source ramp is
    // uneven on purpose (~0.88, 2.47, 0.82), so an implementation that evenly
    // respaced the shades would land on ratios of 1 and blow this up.
    const ratiosBefore = gapRatios(before);
    const ratiosAfter = gapRatios(after);
    expect(ratiosBefore).not.toEqual([1, 1, 1]);
    for (let i = 0; i < ratiosBefore.length; i++) {
      expect(ratiosAfter[i]).toBeCloseTo(ratiosBefore[i], 1);
      expect(Math.abs(ratiosAfter[i] - ratiosBefore[i])).toBeLessThan(0.05);
    }

    // Stronger form of the same claim: the L offset is uniform across the ramp.
    // The residual is 8-bit output quantization, not the transform.
    const offsets = after.map((v, i) => v - before[i]);
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThan(3e-3);
  });

  it("keeps the intra-ramp hue drift, rigidly rotated", () => {
    const red = rampContaining(detectRamps(palette()), "#8d242a");
    const after = applySwapsToRamp(red, remapRamp(red, hexToRgb("#4d7faf")));

    const anchorBefore = rgbToOklch(red.colors[red.anchorIndex]).h;
    const anchorAfter = rgbToOklch(after[red.anchorIndex]).h;
    for (let i = 0; i < red.colors.length; i++) {
      const driftBefore = hueDelta(anchorBefore, rgbToOklch(red.colors[i]).h);
      const driftAfter = hueDelta(anchorAfter, rgbToOklch(after[i]).h);
      // The applied rotation is exactly rigid; the ~1.4 degree residual is
      // 8-bit output rounding, worst on the darkest, least saturated shade
      // where one channel LSB is a big fraction of the chroma vector.
      expect(Math.abs(driftAfter - driftBefore)).toBeLessThan(2);
    }
    // And the drift is real, not a flat ramp that passes trivially.
    const spread = red.colors.map((c) => rgbToOklch(c).h);
    expect(hueDistance(Math.min(...spread), Math.max(...spread))).toBeGreaterThan(20);
  });

  it("emits nothing when a ramp is remapped onto its own base", () => {
    for (const ramp of detectRamps(palette())) {
      expect(remapRamp(ramp, rampBaseColor(ramp))).toEqual([]);
    }
  });

  it("tints a grey ramp via an additive chroma offset", () => {
    const ramps = detectRamps(palette());
    const greys = rampContaining(ramps, "#7e7e7e");
    expect(greys.achromatic).toBe(true);

    const after = applySwapsToRamp(greys, remapRamp(greys, hexToRgb("#4d7faf")));
    // A ratio against a zero-chroma anchor would explode, so the fallback adds
    // chroma instead: every shade that still has lightness to carry it comes
    // back tinted rather than grey.
    const lch = after.map((c) => rgbToOklch(c));
    expect(lch.filter((v) => v.l > 0).length).toBeGreaterThan(1);
    for (const v of lch) if (v.l > 0) expect(v.c).toBeGreaterThan(0.02);
    // And the shades stay separated — no two collapse onto each other.
    for (let i = 1; i < lch.length; i++) expect(lch[i].l).toBeGreaterThan(lch[i - 1].l);
  });

  it("leaves every other ramp untouched", () => {
    const ramps = detectRamps(palette());
    const red = rampContaining(ramps, "#8d242a");
    const moved = new Set(remapRamp(red, hexToRgb("#4d7faf")).map((s) => rgbToHex(s.from)));

    expect(moved).toEqual(new Set(RED_RAMP));
    for (const hex of [...BLUE_RAMP, ...GREYS]) expect(moved.has(hex)).toBe(false);
  });
});

describe("detectRamps", () => {
  it("clusters a ramp that straddles the 0/360 hue wrap", () => {
    // Hues 350.6, 355.9, 1.6, 8.6, 14.2. A plain arithmetic hue mean would walk
    // the cluster centre out to ~179 and split this into three ramps.
    const wrapping = ["#4a1a33", "#792f4f", "#ad4c6c", "#cd7e8c", "#e7acb0"];
    const ramps = detectRamps(palette(wrapping), { hueTolerance: 20 });
    expect(ramps.length).toBe(1);
    expect(ramps[0].colors.map(rgbToHex)).toEqual(wrapping);
  });

  it("partitions the palette — every colour in exactly one ramp", () => {
    const pal = palette();
    const ramps = detectRamps(pal);
    const seen = ramps.flatMap((r) => r.colors.map(rgbToHex));

    expect(seen.length).toBe(pal.length);
    expect(new Set(seen).size).toBe(pal.length);
    expect([...seen].sort()).toEqual([...SPRITE_PALETTE_HEX].sort());
  });

  it("sorts each ramp by ascending lightness and indexes result order", () => {
    const ramps = detectRamps(palette());
    ramps.forEach((ramp, i) => {
      expect(ramp.index).toBe(i);
      const l = lightnesses(ramp.colors);
      for (let k = 1; k < l.length; k++) expect(l[k]).toBeGreaterThanOrEqual(l[k - 1]);
    });
  });

  it("anchors a chromatic ramp on its most saturated shade", () => {
    const red = rampContaining(detectRamps(palette()), "#8d242a");
    const chromas = red.colors.map((c) => rgbToOklch(c).c);
    expect(chromas[red.anchorIndex]).toBe(Math.max(...chromas));
    expect(rgbToHex(rampBaseColor(red))).toBe("#8d242a");
  });

  it("returns [] for an empty palette", () => {
    expect(detectRamps([])).toEqual([]);
  });

  it("describeRamps mirrors the detected ramps as hex", () => {
    const ramps = detectRamps(palette());
    const described = describeRamps(ramps);
    expect(described.map((d) => d.index)).toEqual(ramps.map((r) => r.index));
    expect(described.map((d) => d.colors.length)).toEqual(ramps.map((r) => r.colors.length));
    expect(described[0].base).toBe(rgbToHex(rampBaseColor(ramps[0])));
  });
});

describe("OKLCH conversion", () => {
  it("round-trips 8-bit sRGB exactly", () => {
    for (let r = 0; r <= 255; r += 17) {
      for (let g = 0; g <= 255; g += 17) {
        for (let b = 0; b <= 255; b += 17) {
          expect(oklchToRgb(rgbToOklch({ r, g, b }))).toEqual({ r, g, b });
        }
      }
    }
  });

  it("gamut-maps impossible chroma back into 0..255 integers", () => {
    for (const l of [0, 0.05, 0.35, 0.5, 0.85, 0.95, 1]) {
      for (let h = 0; h < 360; h += 7) {
        const out = oklchToRgb({ l, c: 0.9, h });
        for (const v of [out.r, out.g, out.b]) {
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  it("hueDelta takes the shortest signed arc, hueDistance its magnitude", () => {
    expect(hueDelta(350, 10)).toBeCloseTo(20, 10);
    expect(hueDelta(10, 350)).toBeCloseTo(-20, 10);
    expect(hueDelta(0, 180)).toBeCloseTo(180, 10);
    expect(hueDistance(350, 10)).toBeCloseTo(20, 10);
    expect(hueDistance(10, 350)).toBeCloseTo(20, 10);
  });
});

describe("rotateHue — full turns are identity", () => {
  const probes = ["#000000", "#ffffff", "#808080", "#8d242a", "#0cc821", "#4d7faf", "#fcfc00"];

  it.each([0, 360, -360, 720, -1080, 1080.0])("is bit-exact at %s degrees", (deg) => {
    for (const hex of probes) {
      const c = hexToRgb(hex);
      expect(rotateHue(c, deg)).toEqual(c);
    }
  });

  it("actually moves colours at a non-multiple of 360", () => {
    expect(rotateHue(hexToRgb("#8d242a"), 120)).not.toEqual(hexToRgb("#8d242a"));
  });
});

describe("resolveVariant", () => {
  const pal = palette();
  const ramps = detectRamps(pal);

  it("matches a ramp by any member hex, not just the anchor", () => {
    const viaMember = resolveVariant(
      { name: "v", ramps: [{ base: "#3f121d", to: "#4d7faf" }] },
      pal,
      ramps,
    );
    const viaAnchor = resolveVariant(
      { name: "v", ramps: [{ base: "#8d242a", to: "#4d7faf" }] },
      pal,
      ramps,
    );
    expect(viaMember).toEqual(viaAnchor);
    expect(new Set(viaMember.map((s) => rgbToHex(s.from)))).toEqual(new Set(RED_RAMP));
  });

  it("touches only the targeted ramp", () => {
    const swaps = resolveVariant(
      { name: "v", ramps: [{ base: "#255a86", to: "#a94d4d" }] },
      pal,
      ramps,
    );
    const moved = swaps.map((s) => rgbToHex(s.from));
    expect([...moved].sort()).toEqual([...BLUE_RAMP].sort());
  });

  it("lets an explicit swap override the ramp and hue stages", () => {
    const swaps = resolveVariant(
      {
        name: "v",
        hueShift: 90,
        ramps: [{ base: "#255a86", to: "#a94d4d" }],
        swaps: { "#255a86": "#00ff00" },
      },
      pal,
      ramps,
    );
    const entry = swaps.find((s) => rgbToHex(s.from) === "#255a86");
    expect(entry && rgbToHex(entry.to)).toBe("#00ff00");
    // The rest of the palette still went through the hue shift.
    expect(swaps.length).toBeGreaterThan(1);
  });

  it("returns no swaps for a full-turn hue shift or a self-remap", () => {
    expect(resolveVariant({ name: "v", hueShift: 360 }, pal, ramps)).toEqual([]);
    expect(resolveVariant({ name: "v", hueShift: 0 }, pal, ramps)).toEqual([]);
    expect(
      resolveVariant({ name: "v", ramps: [{ base: "#3f121d", to: "#8d242a" }] }, pal, ramps),
    ).toEqual([]);
  });

  it("skips a ramp base that matches no ramp of an empty palette", () => {
    expect(
      resolveVariant({ name: "v", ramps: [{ base: "#123456", to: "#654321" }] }, [], []),
    ).toEqual([]);
  });
});

describe("variant generation over an ImageData", () => {
  const pal = palette();
  const ramps = detectRamps(pal);

  /** The whole pipeline a CLI/web variant run performs for one frame. */
  function renderVariant(
    src: ImageData,
    spec: Parameters<typeof resolveVariant>[0],
    p = pal,
    r = ramps,
  ): ImageData {
    return applyPaletteSwap(src, p, resolveVariant(spec, p, r));
  }

  it("is bit-exact identity end-to-end at 360 degrees", () => {
    const src = stripe(pal);
    // Palette extracted from the image, as the real surfaces do it.
    const extracted = extractPalette(src, 11);
    const extractedRamps = detectRamps(extracted);

    for (const deg of [0, 360, -360, 720]) {
      const out = renderVariant(src, { name: "id", hueShift: deg }, extracted, extractedRamps);
      expect(out.width).toBe(src.width);
      expect(out.height).toBe(src.height);
      expect(Array.from(out.data)).toEqual(Array.from(src.data));
    }

    // Guard against a vacuous test: a real rotation must change these pixels.
    const shifted = renderVariant(src, { name: "s", hueShift: 90 }, extracted, extractedRamps);
    expect(Array.from(shifted.data)).not.toEqual(Array.from(src.data));
  });

  it("leaves transparent pixels transparent and unpainted", () => {
    const src = stripe(pal);
    const out = renderVariant(src, { name: "v", ramps: [{ base: "#8d242a", to: "#4d7faf" }] });

    const bottom = src.height - 1;
    for (let x = 0; x < src.width; x++) {
      const i = (bottom * src.width + x) * 4;
      expect(src.data[i + 3]).toBe(0);
      expect(out.data[i + 3]).toBe(0);
      // The swap target must not have been painted into a transparent pixel.
      const target = hexToRgb("#4d7faf");
      expect([out.data[i], out.data[i + 1], out.data[i + 2]]).not.toEqual([
        target.r,
        target.g,
        target.b,
      ]);
    }
  });

  it("leaves colours outside the targeted ramp byte-identical", () => {
    const src = stripe(pal, false);
    const out = renderVariant(src, { name: "v", ramps: [{ base: "#8d242a", to: "#4d7faf" }] });

    const untouched = new Set([...BLUE_RAMP, ...GREYS]);
    let changed = 0;
    for (let x = 0; x < src.width; x++) {
      const hex = SPRITE_PALETTE_HEX[Math.floor(x / 2)];
      for (let y = 0; y < src.height; y++) {
        const i = (y * src.width + x) * 4;
        const before = [src.data[i], src.data[i + 1], src.data[i + 2]];
        const after = [out.data[i], out.data[i + 1], out.data[i + 2]];
        if (untouched.has(hex)) expect(after).toEqual(before);
        else if (String(after) !== String(before)) changed++;
      }
    }
    expect(changed).toBe(RED_RAMP.length * 2 * src.height);
  });

  // Regression: the assertions above hand applyPaletteSwap a palette whose
  // entries are the sprite's exact colours, so every pixel resolves to its own
  // bucket at distance 0 and "unchanged" cannot fail. The real surfaces derive
  // the palette from the image instead, and nearest-bucket lookup is only safe
  // if extraction actually separates the materials. It did not: median-cut
  // splits boxes by pixel count, so a big flat shirt claimed several boxes that
  // averaged to the same hex while the small skin tones fell into the shirt's
  // buckets — re-tinting the shirt turned the face blue.
  it("does not drag unrelated materials along when the palette is extracted from the image", () => {
    // Distinct shirt / skin / metal ramps, with the skin deliberately close in
    // hue to the shirt — the case that collapsed.
    const SHIRT = ["#3a1c2e", "#7a2f3a", "#b8474a", "#e8887a"];
    const SKIN = ["#7a4a38", "#c08050", "#f0c090"];
    const METAL = ["#2a3038", "#5a6672", "#98a4b0", "#d8e0e8"];
    const all = [...SHIRT, ...SKIN, ...METAL].map(hexToRgb);

    // Weight the shirt heavily: median-cut spends boxes where the pixels are,
    // which is exactly what starved the skin of a bucket of its own.
    const widths = all.map((_, i) => (i < SHIRT.length ? 12 : 2));
    const total = widths.reduce((a, b) => a + b, 0);
    const src = new ImageData(total, 3);
    let x0 = 0;
    all.forEach((c, ci) => {
      for (let x = x0; x < x0 + widths[ci]; x++) {
        for (let y = 0; y < src.height; y++) {
          const i = (y * src.width + x) * 4;
          src.data[i] = c.r;
          src.data[i + 1] = c.g;
          src.data[i + 2] = c.b;
          src.data[i + 3] = 255;
        }
      }
      x0 += widths[ci];
    });

    const extracted = extractPalette(src, all.length + 2);
    // Every distinct colour must survive extraction as its own entry, or
    // nearest-bucket lookup will fold two materials together.
    expect(new Set(extracted.map(rgbToHex)).size).toBe(extracted.length);
    for (const hex of [...SHIRT, ...SKIN, ...METAL]) {
      expect(extracted.map(rgbToHex)).toContain(hex);
    }

    const extractedRamps = detectRamps(extracted);
    const shirt = rampContaining(extractedRamps, "#b8474a");
    const out = applyPaletteSwap(
      src,
      extracted,
      resolveVariant(
        { name: "blue", ramps: [{ base: "#b8474a", to: "#4d7faf" }] },
        extracted,
        extractedRamps,
      ),
    );

    const moved = shirt.colors.map(rgbToHex);
    const untouched = [...SKIN, ...METAL].filter((h) => !moved.includes(h));
    expect(untouched.length).toBeGreaterThan(0);

    // Walk the image and compare each column against the colour it started as.
    x0 = 0;
    all.forEach((c, ci) => {
      const hex = rgbToHex(c);
      for (let x = x0; x < x0 + widths[ci]; x++) {
        const i = x * 4;
        const after = rgbToHex({ r: out.data[i], g: out.data[i + 1], b: out.data[i + 2] });
        if (untouched.includes(hex)) expect(after).toBe(hex);
      }
      x0 += widths[ci];
    });
  });
});

describe("hueShiftVariants", () => {
  it("emits exactly `count` variants including the 0-degree entry", () => {
    const variants = hueShiftVariants(8);
    expect(variants.map((v) => v.name)).toEqual([
      "hue000",
      "hue045",
      "hue090",
      "hue135",
      "hue180",
      "hue225",
      "hue270",
      "hue315",
    ]);
    expect(variants.map((v) => v.hueShift)).toEqual([0, 45, 90, 135, 180, 225, 270, 315]);
  });

  it("honours stepDeg, startDeg and prefix, wrapping into [0,360)", () => {
    const variants = hueShiftVariants(3, { stepDeg: 150, startDeg: 300, prefix: "team" });
    expect(variants.map((v) => v.name)).toEqual(["team300", "team090", "team240"]);
    expect(variants.map((v) => v.hueShift)).toEqual([300, 90, 240]);
  });

  it("returns [] for a non-positive or non-finite count", () => {
    expect(hueShiftVariants(0)).toEqual([]);
    expect(hueShiftVariants(-3)).toEqual([]);
    expect(hueShiftVariants(Number.NaN)).toEqual([]);
  });
});

describe("parseVariantSet", () => {
  const ok = { version: 1, variants: [{ name: "Team Red", swaps: { B22233: "ffffff" } }] };

  it("normalizes hex to lowercase #rrggbb and trims names", () => {
    const parsed = parseVariantSet({
      version: 1,
      colors: 8,
      variants: [{ name: "  Team Red  ", swaps: { B22233: "FFFFFF" } }],
    });
    expect(parsed).toEqual({
      version: 1,
      colors: 8,
      variants: [{ name: "Team Red", swaps: { "#b22233": "#ffffff" } }],
    });
  });

  it("accepts a well-formed set unchanged in shape", () => {
    expect(parseVariantSet(ok).variants.length).toBe(1);
  });

  it.each([
    [{ ...ok, version: 2 }, /Unsupported variant set version 2/],
    [{ version: 1, variants: [] }, /"variants" must be a non-empty array/],
    [{ version: 1 }, /"variants" must be a non-empty array/],
    ["nope", /must be a JSON object/],
    [
      {
        version: 1,
        variants: [
          { name: "A b", hueShift: 10 },
          { name: "a-B", hueShift: 20 },
        ],
      },
      /duplicate variant name "a-B" \(collides with "A b" as "a-b"\)/,
    ],
    [
      { version: 1, variants: [{ name: "x", swaps: { zzz: "#ffffff" } }] },
      /variants\[0\]\.swaps key: "zzz" is not a valid hex color/,
    ],
    [
      { version: 1, variants: [{ name: "x", swaps: { "#ffffff": "#fff" } }] },
      /is not a valid hex color/,
    ],
    [
      { version: 1, variants: [{ name: "x" }] },
      /variant "x" is empty — needs at least one of swaps, ramps, hueShift/,
    ],
    [{ version: 1, variants: [{ name: "x", swaps: {}, ramps: [] }] }, /variant "x" is empty/],
    [{ version: 1, variants: [{ name: "  " }] }, /"name" must be a non-empty string/],
    [
      { version: 1, variants: [{ name: "x", hueShift: "90" }] },
      /hueShift: must be a finite number of degrees/,
    ],
    [{ version: 1, colors: 0, variants: [{ name: "x", hueShift: 1 }] }, /positive integer/],
  ])("rejects bad input with a precise message (case %#)", (input, message) => {
    expect(() => parseVariantSet(input)).toThrow(message);
  });
});

describe("slugifyVariantName / variantFileName", () => {
  it.each([
    ["Team Red", "team-red"],
    ["  Ünsafe  Name!! ", "nsafe-name"],
    ["a---b", "a-b"],
    ["-lead-and-trail-", "lead-and-trail"],
    ["!!!", "variant"],
    ["", "variant"],
    ["HUE045", "hue045"],
  ])("slugifies %j to %j", (input, expected) => {
    expect(slugifyVariantName(input)).toBe(expected);
  });

  it("builds sortable, extension-aware filenames", () => {
    expect(variantFileName("hero", "Team Red")).toBe("hero_team-red.png");
    expect(variantFileName("hero", "hue045")).toBe("hero_hue045.png");
    expect(variantFileName("hero", "Team Red", "json")).toBe("hero_team-red.json");
  });
});
