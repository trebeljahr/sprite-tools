import { describe, it, expect } from "vitest";
import {
  upscale,
  upscaleNearestBy,
  scale2x,
  scale3x,
  eagle2x,
  xbr2x,
  nativeScalesFor,
  upscaleAlgorithmById,
  UPSCALE_ALGORITHMS,
  DEFAULT_UPSCALE_OPTIONS,
  type ImageDataLike,
  type UpscaleAlgorithm,
} from "@/lib/pixel-art/upscale";

// ---------------------------------------------------------------------------
// Local fixture builders (tests/helpers.ts is shared; nothing here belongs there)
// ---------------------------------------------------------------------------

type RGBA = [number, number, number, number];

const BLACK: RGBA = [0, 0, 0, 255];
const WHITE: RGBA = [255, 255, 255, 255];
const RED: RGBA = [220, 30, 40, 255];
const BLUE: RGBA = [20, 60, 200, 255];
const CLEAR: RGBA = [0, 0, 0, 0];
/** Fully transparent but with garbage colour channels, like a real PNG encoder leaves. */
const GARBAGE_CLEAR: RGBA = [255, 0, 255, 0];

/**
 * Builds an image from rows of single-character keys.
 *   grid(["KL", "LK"], { K: BLACK, L: WHITE })
 */
function grid(rows: string[], map: Record<string, RGBA>): ImageData {
  const h = rows.length;
  const w = rows[0].length;
  const img = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    if (rows[y].length !== w) throw new Error(`ragged grid row ${y}`);
    for (let x = 0; x < w; x++) {
      const c = map[rows[y][x]];
      if (!c) throw new Error(`unmapped grid char "${rows[y][x]}"`);
      const i = (y * w + x) * 4;
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
      img.data[i + 3] = c[3];
    }
  }
  return img;
}

function solid(w: number, h: number, color: RGBA): ImageData {
  const img = new ImageData(w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = color[0];
    img.data[i + 1] = color[1];
    img.data[i + 2] = color[2];
    img.data[i + 3] = color[3];
  }
  return img;
}

function setPx(img: ImageData, x: number, y: number, color: RGBA): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = color[0];
  img.data[i + 1] = color[1];
  img.data[i + 2] = color[2];
  img.data[i + 3] = color[3];
}

function px(img: ImageDataLike, x: number, y: number): RGBA {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

/** Every distinct RGBA in an image, as "r,g,b,a" strings. */
function colorSet(img: ImageDataLike): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < img.data.length; i += 4) {
    s.add(`${img.data[i]},${img.data[i + 1]},${img.data[i + 2]},${img.data[i + 3]}`);
  }
  return s;
}

/** Rows of "r,g,b,a" strings — readable diffs when an exact assertion fails. */
function block(img: ImageDataLike, x0: number, y0: number, w: number, h: number): string[][] {
  const out: string[][] = [];
  for (let y = y0; y < y0 + h; y++) {
    const row: string[] = [];
    for (let x = x0; x < x0 + w; x++) row.push(px(img, x, y).join(","));
    out.push(row);
  }
  return out;
}

/** Collapses every alpha===0 pixel to (0,0,0,0) — the module's own comparison key. */
function canonical(img: ImageDataLike): Uint8ClampedArray {
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] === 0) continue;
    out[i] = img.data[i];
    out[i + 1] = img.data[i + 1];
    out[i + 2] = img.data[i + 2];
    out[i + 3] = img.data[i + 3];
  }
  return out;
}

const ALGORITHMS: UpscaleAlgorithm[] = ["nearest", "scale2x", "scale3x", "eagle", "xbr"];

const STEPS: Record<string, (src: ImageDataLike) => ImageData> = {
  scale2x,
  scale3x,
  eagle: eagle2x,
  xbr: xbr2x,
  nearest: (s) => upscaleNearestBy(s, 2),
};

/**
 * The shared two-colour diagonal step used for the exact per-pixel assertions.
 * K = black, L = white.
 *
 *      x: 0 1 2 3
 *   y=0:  K K L L
 *   y=1:  K K K L
 *   y=2:  K K K K
 *   y=3:  K K K K
 */
function stepImage(): ImageData {
  return grid(["KKLL", "KKKL", "KKKK", "KKKK"], { K: BLACK, L: WHITE });
}

/**
 * A pixel whose guard must FAIL on the `D != F` half alone.
 * M = red, so it is distinguishable from both K and L.
 *
 *      x: 0 1 2 3 4
 *   y=0:  K K K K K
 *   y=1:  K K K K K
 *   y=2:  L L M L L
 *   y=3:  L L L L L
 *   y=4:  L L L L L
 *
 * At E = (2,2): B = K, H = L, so B != H is TRUE, but D = F = L so D != F is
 * FALSE. `&&` means the guard fails and the pixel is copied as a plain block.
 * An implementation that used `||` would fire the rules and pull L into the
 * bottom half — which is exactly what the assertion below rules out.
 */
function guardImage(): ImageData {
  return grid(["KKKKK", "KKKKK", "LLMLL", "LLLLL", "LLLLL"], {
    K: BLACK,
    L: WHITE,
    M: RED,
  });
}

/**
 * A corner that exercises the rule clauses the plain diagonal never reaches:
 * Scale2x's E3, and the *second* clause of Scale3x's E5 / E7.
 *
 *      x: 0 1 2 3 4
 *   y=0:  K K K K K
 *   y=1:  K K K L K
 *   y=2:  K K K L K
 *   y=3:  K K L K K
 *   y=4:  K K K K K
 *
 * Around E = (2,2):  A=K B=K C=L / D=K E=K F=L / G=K H=L I=K
 */
function cornerImage(): ImageData {
  return grid(["KKKKK", "KKKLK", "KKKLK", "KKLKK", "KKKKK"], { K: BLACK, L: WHITE });
}

const K = BLACK.join(",");
const L = WHITE.join(",");
const M = RED.join(",");

// ---------------------------------------------------------------------------

describe("upscale dimensions", () => {
  it("multiplies a non-square input by the requested scale, for every algorithm", () => {
    const src = solid(7, 5, RED);
    setPx(src, 3, 2, BLUE); // make sure the filters have something to chew on
    for (const algorithm of ALGORITHMS) {
      for (let scale = 1; scale <= 8; scale++) {
        const out = upscale(src, { algorithm, scale });
        expect(`${algorithm}@${scale} ${out.width}x${out.height}`).toBe(
          `${algorithm}@${scale} ${7 * scale}x${5 * scale}`,
        );
      }
    }
  });

  it("scale2x @6 on 7x5 is 42x30 (one native pass plus a nearest x3 remainder)", () => {
    const out = upscale(solid(7, 5, RED), { algorithm: "scale2x", scale: 6 });
    expect([out.width, out.height]).toEqual([42, 30]);
  });

  it("scale3x @9 on 7x5 is 63x45 (two native passes, no remainder)", () => {
    const out = upscale(solid(7, 5, RED), { algorithm: "scale3x", scale: 9 });
    expect([out.width, out.height]).toEqual([63, 45]);
  });

  it("scale=1 is a faithful copy for every algorithm", () => {
    const src = stepImage();
    for (const algorithm of ALGORITHMS) {
      const out = upscale(src, { algorithm, scale: 1 });
      expect([out.width, out.height]).toEqual([src.width, src.height]);
      expect(Array.from(out.data)).toEqual(Array.from(src.data));
      // …and a copy, not the same buffer.
      expect(out.data).not.toBe(src.data);
    }
  });

  it("floors and clamps a non-integer or negative scale to >= 1", () => {
    const src = stepImage();
    expect(upscale(src, { algorithm: "scale2x", scale: 2.9 }).width).toBe(8);
    expect(upscale(src, { algorithm: "scale2x", scale: 0 }).width).toBe(4);
    expect(upscale(src, { algorithm: "scale2x", scale: -3 }).width).toBe(4);
    expect(upscale(src, { algorithm: "scale2x", scale: 0.5 }).width).toBe(4);
  });

  it("defaults to scale2x @2", () => {
    const src = stepImage();
    expect(DEFAULT_UPSCALE_OPTIONS).toEqual({ algorithm: "scale2x", scale: 2 });
    expect(Array.from(upscale(src).data)).toEqual(Array.from(scale2x(src).data));
  });

  it("single-step exports produce their native factor", () => {
    const src = stepImage();
    expect([scale2x(src).width, scale2x(src).height]).toEqual([8, 8]);
    expect([scale3x(src).width, scale3x(src).height]).toEqual([12, 12]);
    expect([eagle2x(src).width, eagle2x(src).height]).toEqual([8, 8]);
    expect([xbr2x(src).width, xbr2x(src).height]).toEqual([8, 8]);
    expect(upscaleNearestBy(src, 5).width).toBe(20);
    expect(upscaleNearestBy(src, 1).width).toBe(4);
  });
});

describe("flat regions stay flat", () => {
  // A 12x12 image whose outer 2-pixel ring is BLUE and whose inside is RED.
  // Source pixels with x,y in [4,8) have their whole 5x5 neighbourhood (xBR
  // reaches 2 out) inside the RED region, so nothing here is about clamping.
  function ringed(): ImageData {
    const img = solid(12, 12, BLUE);
    for (let y = 2; y < 10; y++) for (let x = 2; x < 10; x++) setPx(img, x, y, RED);
    return img;
  }

  it("an interior solid region upscales to the identical solid RGBA", () => {
    const src = ringed();
    for (const algorithm of ALGORITHMS) {
      for (const scale of [2, 3, 4]) {
        const out = upscale(src, { algorithm, scale });
        for (let y = 4 * scale; y < 8 * scale; y++) {
          for (let x = 4 * scale; x < 8 * scale; x++) {
            expect(`${algorithm}@${scale} (${x},${y}) ${px(out, x, y).join(",")}`).toBe(
              `${algorithm}@${scale} (${x},${y}) ${RED.join(",")}`,
            );
          }
        }
      }
    }
  });

  it("a whole-image solid stays solid, which exercises border clamping", () => {
    const src = solid(6, 4, RED);
    for (const algorithm of ALGORITHMS) {
      for (const scale of [2, 3, 4]) {
        const out = upscale(src, { algorithm, scale });
        expect(`${algorithm}@${scale}: ${[...colorSet(out)].join(" | ")}`).toBe(
          `${algorithm}@${scale}: ${RED.join(",")}`,
        );
      }
    }
  });
});

describe("scale2x exact rules on a known diagonal", () => {
  //     A B C
  //     D E F     guard: B != H && D != F
  //     G H I
  //   E0 = D==B ? D : E;  E1 = B==F ? F : E;  E2 = D==H ? D : E;  E3 = H==F ? F : E;
  //
  // Source (K = black, L = white):
  //     K K L L
  //     K K K L
  //     K K K K
  //     K K K K

  it("interior pixel (2,1): only the top-right sub-pixel flips to white", () => {
    // Neighbourhood of E = (2,1) = K:
    //   A=(1,0)=K  B=(2,0)=L  C=(3,0)=L
    //   D=(1,1)=K  E=(2,1)=K  F=(3,1)=L
    //   G=(1,2)=K  H=(2,2)=K  I=(3,2)=K
    // guard: B(L) != H(K) ok, D(K) != F(L) ok  -> rules fire.
    //   E0 = D==B ? D : E  ->  K==L false -> E = K
    //   E1 = B==F ? F : E  ->  L==L true  -> F = L
    //   E2 = D==H ? D : E  ->  K==K true  -> D = K
    //   E3 = H==F ? F : E  ->  K==L false -> E = K
    const out = scale2x(stepImage());
    expect(block(out, 4, 2, 2, 2)).toEqual([
      [K, L],
      [K, K],
    ]);
  });

  it("top-edge pixel (2,0): clamped B row makes the bottom-left sub-pixel black", () => {
    // Borders replicate, so row -1 is row 0.
    //   A=(1,0)=K  B=(2,0)=L  C=(3,0)=L
    //   D=(1,0)=K  E=(2,0)=L  F=(3,0)=L
    //   G=(1,1)=K  H=(2,1)=K  I=(3,1)=L
    // guard: B(L) != H(K) ok, D(K) != F(L) ok  -> rules fire.
    //   E0 = D==B ? D : E  ->  K==L false -> E = L
    //   E1 = B==F ? F : E  ->  L==L true  -> F = L
    //   E2 = D==H ? D : E  ->  K==K true  -> D = K
    //   E3 = H==F ? F : E  ->  K==L false -> E = L
    const out = scale2x(stepImage());
    expect(block(out, 4, 0, 2, 2)).toEqual([
      [L, L],
      [K, L],
    ]);
  });

  it("a pixel whose guard fails is reproduced as a plain 2x2 block", () => {
    // E = (1,2) = K:  B=(1,1)=K  H=(1,3)=K  ->  B == H, guard fails.
    const out = scale2x(stepImage());
    expect(block(out, 2, 4, 2, 2)).toEqual([
      [K, K],
      [K, K],
    ]);
  });

  it("the guard needs BOTH halves — one failing half is enough to skip the rules", () => {
    // guardImage, E = (2,2) = M:  A=K B=K C=K / D=L E=M F=L / G=L H=L I=L
    //   B != H  ->  K != L  ->  TRUE
    //   D != F  ->  L != L  ->  FALSE
    // `&&` fails, so all four sub-pixels are M. With `||` the rules would run:
    //   E2 = D==H ? D : E  ->  L==L -> L,  E3 = H==F ? F : E  ->  L==L -> L
    // and the bottom row would come out white.
    const out = scale2x(guardImage());
    expect(block(out, 4, 4, 2, 2)).toEqual([
      [M, M],
      [M, M],
    ]);
  });

  it("corner pixel: E3 takes F", () => {
    // cornerImage, E = (2,2) = K:  A=K B=K C=L / D=K E=K F=L / G=K H=L I=K
    // guard: B(K) != H(L) ok, D(K) != F(L) ok -> rules fire.
    //   E0 = D==B ? D : E  ->  K==K true  -> D = K
    //   E1 = B==F ? F : E  ->  K==L false -> E = K
    //   E2 = D==H ? D : E  ->  K==L false -> E = K
    //   E3 = H==F ? F : E  ->  L==L true  -> F = L
    const out = scale2x(cornerImage());
    expect(block(out, 4, 4, 2, 2)).toEqual([
      [K, K],
      [K, L],
    ]);
  });
});

describe("scale3x exact rules on a known diagonal", () => {
  //     A B C        E0 E1 E2
  //     D E F   ->   E3 E4 E5
  //     G H I        E6 E7 E8
  //   guard: B != H && D != F
  //   E0 = D==B ? D : E
  //   E1 = (D==B && E!=C) || (B==F && E!=A) ? B : E
  //   E2 = B==F ? F : E
  //   E3 = (D==B && E!=G) || (D==H && E!=A) ? D : E
  //   E4 = E
  //   E5 = (B==F && E!=I) || (H==F && E!=C) ? F : E
  //   E6 = D==H ? D : E
  //   E7 = (D==H && E!=I) || (H==F && E!=G) ? H : E
  //   E8 = H==F ? F : E

  it("interior pixel (2,1): only E2 flips to white", () => {
    // E = (2,1) = K.  A=K B=L C=L / D=K E=K F=L / G=K H=K I=K
    // guard: L != K ok, K != L ok.
    //   E0 = D==B ? -> K==L false                                  -> E = K
    //   E1 = (K==L && …) || (B==F: L==L && E!=A: K!=K false)        -> E = K
    //   E2 = B==F ? -> L==L true                                    -> F = L
    //   E3 = (K==L && …) || (D==H: K==K && E!=A: K!=K false)         -> E = K
    //   E4 = E                                                      -> K
    //   E5 = (B==F: true && E!=I: K!=K false) || (H==F: K==L false)  -> E = K
    //   E6 = D==H ? -> K==K true                                     -> D = K
    //   E7 = (D==H: true && E!=I: false) || (H==F: false)            -> E = K
    //   E8 = H==F ? -> K==L false                                    -> E = K
    const out = scale3x(stepImage());
    expect(block(out, 6, 3, 3, 3)).toEqual([
      [K, K, L],
      [K, K, K],
      [K, K, K],
    ]);
  });

  it("top-edge pixel (2,0): clamped row gives the full corner-rounding pattern", () => {
    // Row -1 clamps to row 0.  A=K B=L C=L / D=K E=L F=L / G=K H=K I=L
    // guard: B(L) != H(K) ok, D(K) != F(L) ok.
    //   E0 = D==B ? -> K==L false                                     -> E = L
    //   E1 = (D==B false) || (B==F: L==L true && E!=A: L!=K true)      -> B = L
    //   E2 = B==F ? -> true                                            -> F = L
    //   E3 = (D==B false) || (D==H: K==K true && E!=A: L!=K true)       -> D = K
    //   E4 = E                                                         -> L
    //   E5 = (B==F true && E!=I: L!=L false) || (H==F: K==L false)      -> E = L
    //   E6 = D==H ? -> K==K true                                        -> D = K
    //   E7 = (D==H true && E!=I: false) || (H==F: false)                -> E = L
    //   E8 = H==F ? -> K==L false                                       -> E = L
    const out = scale3x(stepImage());
    expect(block(out, 6, 0, 3, 3)).toEqual([
      [L, L, L],
      [K, L, L],
      [K, L, L],
    ]);
  });

  it("corner pixel: E5 and E8 fire through the H==F clause", () => {
    // cornerImage, E = (2,2) = K:  A=K B=K C=L / D=K E=K F=L / G=K H=L I=K
    // guard: B(K) != H(L) ok, D(K) != F(L) ok.
    //   E0 = D==B ? -> K==K true                                       -> D = K
    //   E1 = (D==B true && E!=C: K!=L true)                             -> B = K
    //   E2 = B==F ? -> K==L false                                       -> E = K
    //   E3 = (D==B true && E!=G: K!=K FALSE) || (D==H: K==L false)      -> E = K
    //   E4 = E                                                          -> K
    //   E5 = (B==F: false) || (H==F: L==L true && E!=C: K!=L true)       -> F = L
    //   E6 = D==H ? -> K==L false                                        -> E = K
    //   E7 = (D==H false) || (H==F true && E!=G: K!=K FALSE)             -> E = K
    //   E8 = H==F ? -> L==L true                                         -> F = L
    // E5 is the one that matters: it is reachable ONLY through the second
    // clause here, since B==F is false.
    const out = scale3x(cornerImage());
    expect(block(out, 6, 6, 3, 3)).toEqual([
      [K, K, K],
      [K, K, L],
      [K, K, L],
    ]);
  });

  it("the guard needs BOTH halves, same as scale2x", () => {
    // guardImage, E = (2,2) = M: B != H is true but D != F is false.
    const out = scale3x(guardImage());
    expect(block(out, 6, 6, 3, 3)).toEqual([
      [M, M, M],
      [M, M, M],
      [M, M, M],
    ]);
  });
});

describe("eagle exact rules on a known diagonal", () => {
  //     S T U        1 2
  //     V C W   ->   3 4
  //     X Y Z
  //   1 = (V==S && S==T) ? S : C
  //   2 = (T==U && U==W) ? U : C
  //   3 = (V==X && X==Y) ? X : C
  //   4 = (W==Z && Z==Y) ? Z : C

  it("interior pixel (2,1): only the top-right sub-pixel flips to white", () => {
    // C = (2,1) = K.  S=(1,0)=K T=(2,0)=L U=(3,0)=L
    //                 V=(1,1)=K         W=(3,1)=L
    //                 X=(1,2)=K Y=(2,2)=K Z=(3,2)=K
    //   1: V==S (K==K) && S==T (K==L) -> false          -> C = K
    //   2: T==U (L==L) && U==W (L==L) -> true           -> U = L
    //   3: V==X (K==K) && X==Y (K==K) -> true           -> X = K
    //   4: W==Z (L==K) -> false                         -> C = K
    const out = eagle2x(stepImage());
    expect(block(out, 4, 2, 2, 2)).toEqual([
      [K, L],
      [K, K],
    ]);
  });

  it("top-edge pixel (2,0): clamped row makes the bottom-left sub-pixel black", () => {
    // C = (2,0) = L.  S=(1,0)=K T=(2,0)=L U=(3,0)=L
    //                 V=(1,0)=K         W=(3,0)=L
    //                 X=(1,1)=K Y=(2,1)=K Z=(3,1)=L
    //   1: V==S (K==K) && S==T (K==L) -> false          -> C = L
    //   2: T==U (L==L) && U==W (L==L) -> true           -> U = L
    //   3: V==X (K==K) && X==Y (K==K) -> true           -> X = K
    //   4: W==Z (L==L) && Z==Y (L==K) -> false          -> C = L
    const out = eagle2x(stepImage());
    expect(block(out, 4, 0, 2, 2)).toEqual([
      [L, L],
      [K, L],
    ]);
  });

  it("outer corner: rule 1 fires and rounds the corner off", () => {
    // The step image only ever fires rules 2 and 3, so this covers rule 1 (and
    // rule 4, firing with the centre's own colour).
    //     L L L L L
    //     L L L L L
    //     L L K K K
    //     L L K K K
    //     L L K K K
    // C = (2,2) = K:  S=(1,1)=L T=(2,1)=L U=(3,1)=L
    //                 V=(1,2)=L         W=(3,2)=K
    //                 X=(1,3)=L Y=(2,3)=K Z=(3,3)=K
    //   1: V==S (L==L) && S==T (L==L) -> true           -> S = L
    //   2: T==U (L==L) && U==W (L==K) -> false          -> C = K
    //   3: V==X (L==L) && X==Y (L==K) -> false          -> C = K
    //   4: W==Z (K==K) && Z==Y (K==K) -> true           -> Z = K
    const src = grid(["LLLLL", "LLLLL", "LLKKK", "LLKKK", "LLKKK"], {
      K: BLACK,
      L: WHITE,
    });
    const out = eagle2x(src);
    expect(block(out, 4, 4, 2, 2)).toEqual([
      [L, K],
      [K, K],
    ]);
  });

  it("swallows an isolated single pixel — Eagle's documented flaw", () => {
    // 3x3, white centre on black. For C = (1,1) every neighbour is K, so all
    // four L-tests pass and all four outputs take a black neighbour.
    const src = grid(["KKK", "KLK", "KKK"], { K: BLACK, L: WHITE });
    const out = eagle2x(src);
    expect(block(out, 2, 2, 2, 2)).toEqual([
      [K, K],
      [K, K],
    ]);
    // The white pixel is gone from the whole output.
    expect([...colorSet(out)]).toEqual([K]);
  });
});

describe("no invented colours", () => {
  const src = grid(["KLRBK..", "LKRB..K", "RRKKLLB", "BB..RRK", "K.L.R.B"], {
    K: BLACK,
    L: WHITE,
    R: RED,
    B: BLUE,
    ".": GARBAGE_CLEAR,
  });

  it("every output RGBA is one of the input RGBAs, for every algorithm and scale", () => {
    const allowed = colorSet(src);
    for (const algorithm of ALGORITHMS) {
      for (const scale of [2, 3, 4, 6]) {
        const out = upscale(src, { algorithm, scale });
        const extra = [...colorSet(out)].filter((c) => !allowed.has(c));
        expect(`${algorithm}@${scale}: ${extra.join(" | ")}`).toBe(`${algorithm}@${scale}: `);
      }
    }
  });

  it("holds for each single-step filter directly", () => {
    const allowed = colorSet(src);
    for (const [name, step] of Object.entries(STEPS)) {
      const out = step(src);
      const extra = [...colorSet(out)].filter((c) => !allowed.has(c));
      expect(`${name}: ${extra.join(" | ")}`).toBe(`${name}: `);
    }
  });
});

describe("transparency", () => {
  it("a fully transparent input stays fully transparent", () => {
    const src = new ImageData(6, 5); // all zeros
    for (const algorithm of ALGORITHMS) {
      for (const scale of [2, 3, 4]) {
        const out = upscale(src, { algorithm, scale });
        let opaque = 0;
        for (let i = 3; i < out.data.length; i += 4) if (out.data[i] !== 0) opaque++;
        expect(`${algorithm}@${scale} opaque=${opaque}`).toBe(`${algorithm}@${scale} opaque=0`);
      }
    }
  });

  it("an opaque shape on a transparent background never produces a partial alpha", () => {
    const src = grid([".......", "..KK...", ".KKLK..", "..KKK..", "...K..."], {
      K: BLACK,
      L: WHITE,
      ".": CLEAR,
    });
    const allowed = new Set([CLEAR.join(","), BLACK.join(","), WHITE.join(",")]);
    for (const algorithm of ALGORITHMS) {
      for (const scale of [2, 3]) {
        const out = upscale(src, { algorithm, scale });
        const bad = [...colorSet(out)].filter((c) => !allowed.has(c));
        expect(`${algorithm}@${scale}: ${bad.join(" | ")}`).toBe(`${algorithm}@${scale}: `);
        // No half-transparent in-between anywhere.
        for (let i = 3; i < out.data.length; i += 4) {
          expect(out.data[i] === 0 || out.data[i] === 255).toBe(true);
        }
      }
    }
  });

  describe("garbage RGB under transparent pixels", () => {
    // A PNG encoder leaves arbitrary — and, crucially, *varying* — colour bytes
    // underneath fully-transparent pixels. A uniform garbage colour would not
    // test anything here: raw RGBA comparison would still call two transparent
    // pixels equal. So every transparent pixel below gets its own RGB.
    //
    // The filters must canonicalise alpha===0 to one key before comparing.
    // If they compared raw RGBA, no two background pixels would ever match and
    // rules like `E1 = B==F ? F : E` would stop firing at the shape's convex
    // corners — a black pixel would survive where a transparent one belongs.
    const shape = ["......", ".KKK..", ".KKK..", ".KKKK.", "......"];

    /** Same geometry, but each transparent pixel gets a distinct non-zero RGB. */
    function noisyClear(): ImageData {
      const img = grid(shape, { K: BLACK, ".": CLEAR });
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          if (px(img, x, y)[3] !== 0) continue;
          const n = y * img.width + x;
          setPx(img, x, y, [(29 + n * 37) % 256, (211 - n * 53) & 255, (7 + n * 101) % 256, 0]);
        }
      }
      return img;
    }

    const noisy = noisyClear();
    const clean = grid(shape, { K: BLACK, ".": CLEAR });

    it("gives the same result as a clean rgba(0,0,0,0) background", () => {
      // Compared in canonical form: the garbage RGB rides along on the copied
      // transparent pixels, so only alpha placement and opaque colour can match.
      for (const algorithm of ALGORITHMS) {
        for (const scale of [2, 3, 4]) {
          const a = canonical(upscale(noisy, { algorithm, scale }));
          const b = canonical(upscale(clean, { algorithm, scale }));
          expect(`${algorithm}@${scale}: ${a.join(",")}`).toBe(
            `${algorithm}@${scale}: ${b.join(",")}`,
          );
        }
      }
    });

    it("holds for each single-step filter directly", () => {
      for (const [name, step] of Object.entries(STEPS)) {
        const a = canonical(step(noisy));
        const b = canonical(step(clean));
        expect(`${name}: ${a.join(",")}`).toBe(`${name}: ${b.join(",")}`);
      }
    });

    it("never bleeds the shape colour into a transparent pixel, or vice versa", () => {
      const clearRgbs = new Set([...colorSet(noisy)].filter((c) => c.endsWith(",0")));
      for (const algorithm of ALGORITHMS) {
        for (const scale of [2, 3]) {
          const out = upscale(noisy, { algorithm, scale });
          for (const c of colorSet(out)) {
            // Every output pixel is either exactly the shape colour, or one of
            // the input's transparent pixels carried over byte for byte.
            const ok = c === BLACK.join(",") || clearRgbs.has(c);
            expect(`${algorithm}@${scale} ${c} ok=${ok}`).toBe(
              `${algorithm}@${scale} ${c} ok=true`,
            );
          }
        }
      }
    });

    it("keeps the interior of the transparent region transparent", () => {
      // Source (0,0) is transparent and every neighbour out to 2 is transparent
      // too (clamped), so no filter has an edge to act on there.
      const corner = px(noisy, 0, 0).join(",");
      for (const algorithm of ALGORITHMS) {
        const out = upscale(noisy, { algorithm, scale: 2 });
        expect(`${algorithm} ${px(out, 0, 0).join(",")}`).toBe(`${algorithm} ${corner}`);
      }
    });

    it("a convex corner of the shape rounds off into transparency", () => {
      // This is the pixel that proves canonicalisation. E = (3,1), the shape's
      // top-right corner:
      //   A=(2,0)=clear  B=(3,0)=clear  C=(4,0)=clear
      //   D=(2,1)=K      E=(3,1)=K      F=(4,1)=clear
      //   G=(2,2)=K      H=(3,2)=K      I=(4,2)=clear
      // guard: B(clear) != H(K) ok, D(K) != F(clear) ok -> rules fire.
      //   E1 = B==F ? F : E  ->  clear == clear -> F, i.e. TRANSPARENT.
      // With raw-RGBA comparison B and F carry different garbage, E1 would
      // stay black and the corner would never round.
      const out = scale2x(noisy);
      expect(px(out, 7, 2)[3]).toBe(0);
      // …and the other three sub-pixels of that source pixel stay black.
      expect(px(out, 6, 2)).toEqual(BLACK);
      expect(px(out, 6, 3)).toEqual(BLACK);
      expect(px(out, 7, 3)).toEqual(BLACK);
    });
  });
});

describe("xbr2x specifics", () => {
  it("is a no-op on a flat field", () => {
    const src = solid(6, 5, RED);
    expect(Array.from(xbr2x(src).data)).toEqual(Array.from(upscaleNearestBy(src, 2).data));
  });

  it("is a no-op on a flat field with a transparent background", () => {
    const src = solid(6, 5, GARBAGE_CLEAR);
    expect(Array.from(xbr2x(src).data)).toEqual(Array.from(upscaleNearestBy(src, 2).data));
  });

  // A clean 45-degree edge, white above-left of black.
  const diagonal = () =>
    grid(["LLLLKK", "LLLKKK", "LLKKKK", "LKKKKK", "KKKKKK", "KKKKKK"], {
      K: BLACK,
      L: WHITE,
    });

  /** Renders a two-colour image as one string per row, "L" for white, "K" for black. */
  function rows(img: ImageDataLike): string[] {
    const out: string[] = [];
    for (let y = 0; y < img.height; y++) {
      let r = "";
      for (let x = 0; x < img.width; x++) r += px(img, x, y).join(",") === K ? "K" : "L";
      out.push(r);
    }
    return out;
  }

  it("thins nearest's 2-pixel staircase into a 1-pixel staircase", () => {
    // Nearest doubles every step, so a 45-degree source edge comes out as a
    // staircase two output pixels wide. xBR's edge-detection rule fires along
    // that edge and shaves one pixel off each tread, which is the whole point
    // of the filter. If `fx` were left as the shader's strict `> 0.5` the rule
    // would never fire at 2x and this output would equal the nearest one.
    expect(rows(upscaleNearestBy(diagonal(), 2))).toEqual([
      "LLLLLLLLKKKK",
      "LLLLLLLLKKKK",
      "LLLLLLKKKKKK",
      "LLLLLLKKKKKK",
      "LLLLKKKKKKKK",
      "LLLLKKKKKKKK",
      "LLKKKKKKKKKK",
      "LLKKKKKKKKKK",
      "KKKKKKKKKKKK",
      "KKKKKKKKKKKK",
      "KKKKKKKKKKKK",
      "KKKKKKKKKKKK",
    ]);
    expect(rows(xbr2x(diagonal()))).toEqual([
      "LLLLLLLLKKKK",
      "LLLLLLLKKKKK",
      "LLLLLLLKKKKK",
      "LLLLLKKKKKKK",
      "LLLLLKKKKKKK",
      "LLLKKKKKKKKK",
      "LLLKKKKKKKKK",
      "LKKKKKKKKKKK",
      "KKKKKKKKKKKK",
      "KKKKKKKKKKKK",
      "KKKKKKKKKKKK",
      "KKKKKKKKKKKK",
    ]);
  });

  it("differs from nearest at exactly the pixels on the diagonal edge", () => {
    const xbr = xbr2x(diagonal());
    const near = upscaleNearestBy(diagonal(), 2);
    const diffs: string[] = [];
    for (let y = 0; y < xbr.height; y++) {
      for (let x = 0; x < xbr.width; x++) {
        if (px(xbr, x, y).join(",") !== px(near, x, y).join(",")) diffs.push(`${x},${y}`);
      }
    }
    // One shaved pixel per tread, walking down the edge.
    expect(diffs).toEqual(["7,1", "6,2", "5,3", "4,4", "3,5", "2,6", "1,7"]);

    // Spot-check one of them explicitly: output (7,1) is the bottom-right
    // quadrant of source (3,0)=white, whose F=(4,0) and H=(3,1) are both black,
    // so the rule replaces it with a black neighbour.
    expect(px(near, 7, 1)).toEqual(WHITE);
    expect(px(xbr, 7, 1)).toEqual(BLACK);
  });
});

describe("nativeScalesFor", () => {
  it("lists every exact factor for a 2x filter", () => {
    expect(nativeScalesFor("scale2x")).toEqual([1, 2, 4, 8]);
    expect(nativeScalesFor("eagle")).toEqual([1, 2, 4, 8]);
    expect(nativeScalesFor("xbr")).toEqual([1, 2, 4, 8]);
  });

  it("goes up to 9 for the 3x filter", () => {
    expect(nativeScalesFor("scale3x")).toEqual([1, 3, 9]);
  });

  it("treats every integer factor as exact for nearest", () => {
    expect(nativeScalesFor("nearest")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("every listed factor is reachable and exact", () => {
    for (const algorithm of ALGORITHMS) {
      for (const scale of nativeScalesFor(algorithm)) {
        const out = upscale(solid(5, 3, RED), { algorithm, scale });
        expect([out.width, out.height]).toEqual([5 * scale, 3 * scale]);
      }
    }
  });
});

describe("pass composition", () => {
  const src = stepImage();

  it("a native factor is repeated passes of the filter, byte for byte", () => {
    expect(Array.from(upscale(src, { algorithm: "scale2x", scale: 4 }).data)).toEqual(
      Array.from(scale2x(scale2x(src)).data),
    );
    expect(Array.from(upscale(src, { algorithm: "scale2x", scale: 8 }).data)).toEqual(
      Array.from(scale2x(scale2x(scale2x(src))).data),
    );
    expect(Array.from(upscale(src, { algorithm: "scale3x", scale: 9 }).data)).toEqual(
      Array.from(scale3x(scale3x(src)).data),
    );
    expect(Array.from(upscale(src, { algorithm: "eagle", scale: 4 }).data)).toEqual(
      Array.from(eagle2x(eagle2x(src)).data),
    );
    expect(Array.from(upscale(src, { algorithm: "xbr", scale: 4 }).data)).toEqual(
      Array.from(xbr2x(xbr2x(src)).data),
    );
  });

  it("a remainder is covered by nearest, applied after the native passes", () => {
    // scale2x @6 = one scale2x pass, then nearest x3.
    expect(Array.from(upscale(src, { algorithm: "scale2x", scale: 6 }).data)).toEqual(
      Array.from(upscaleNearestBy(scale2x(src), 3).data),
    );
    // scale2x @2 with an odd remainder of 5 -> no native pass at all.
    expect(Array.from(upscale(src, { algorithm: "scale2x", scale: 5 }).data)).toEqual(
      Array.from(upscaleNearestBy(src, 5).data),
    );
    // scale3x @6 = one scale3x pass, then nearest x2.
    expect(Array.from(upscale(src, { algorithm: "scale3x", scale: 6 }).data)).toEqual(
      Array.from(upscaleNearestBy(scale3x(src), 2).data),
    );
  });

  it("the nearest algorithm is plain block scaling at every factor", () => {
    for (let scale = 1; scale <= 8; scale++) {
      expect(Array.from(upscale(src, { algorithm: "nearest", scale }).data)).toEqual(
        Array.from(upscaleNearestBy(src, scale).data),
      );
    }
  });

  it("an unknown algorithm id falls back to nearest", () => {
    const out = upscale(src, { algorithm: "hq2x" as UpscaleAlgorithm, scale: 3 });
    expect(Array.from(out.data)).toEqual(Array.from(upscaleNearestBy(src, 3).data));
  });
});

describe("upscaleAlgorithmById", () => {
  it("returns the matching entry for every known id", () => {
    for (const info of UPSCALE_ALGORITHMS) {
      expect(upscaleAlgorithmById(info.id)).toBe(info);
    }
  });

  it("falls back to nearest for anything unknown", () => {
    expect(upscaleAlgorithmById("hq2x").id).toBe("nearest");
    expect(upscaleAlgorithmById("").id).toBe("nearest");
    expect(upscaleAlgorithmById("Scale2x").id).toBe("nearest"); // case-sensitive
  });

  it("exposes the documented metadata in declaration order", () => {
    expect(UPSCALE_ALGORITHMS.map((a) => a.id)).toEqual([
      "nearest",
      "scale2x",
      "scale3x",
      "eagle",
      "xbr",
    ]);
    expect(UPSCALE_ALGORITHMS.map((a) => a.nativeFactor)).toEqual([1, 2, 3, 2, 2]);
    for (const info of UPSCALE_ALGORITHMS) {
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(0);
    }
  });
});
