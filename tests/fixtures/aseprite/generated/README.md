# Generated `.aseprite` fixtures

Synthetic `.aseprite` files written by `scripts/gen-ase-fixtures.mjs`, not by Aseprite.

They exist because the real Aseprite files we can legally vendor
(`../excalibur/`) all come out of the same "draw a beetle, hit save" workflow,
so whole branches of the format are never exercised by them: raw (uncompressed)
cels, ping-pong-reverse tags, non-zero cel z-index, background layers, named
palette entries, group layers, non-Normal blend modes, sub-255 layer opacity,
non-uniform frame durations, old-style palette packets with a non-zero skip,
reference layers, and palettes that change between frames.

**This file is the test contract.** Every value below was read back out of the
emitted bytes by an independent reader, so tests can assert them literally.

## Regenerating

```
node scripts/gen-ase-fixtures.mjs
```

Output is deterministic — no randomness, no timestamps, no unordered iteration —
so `git diff` after a regenerate should be empty and a regenerate-and-diff check
is a meaningful guard against accidental encoder drift.

That includes the compressed cel data. It is written by a small fixed-Huffman
deflate encoder inside the generator, not by `node:zlib`, because zlib output
differs between the zlib builds that different Node versions ship. The same
bytes come out on every supported Node version. Each stream is round-tripped
through `zlib.inflateSync` before it is written. Tests should still assert
decoded values, never file hashes: the hashes describe the encoder, not the
format.

## Common to every fixture

| Field | Value |
| --- | --- |
| Canvas | 8 x 8 |
| Pixel ratio | 1:1 (`pixel width` = `pixel height` = 1) |
| Grid | x 0, y 0, 16 x 16 |
| Header `flags` | 1, except `layers-blend.aseprite` which is 3 |
| Colour profile chunk | `0x2007`, type 1 (sRGB), no fixed gamma — matches what real Aseprite writes |

Quadrant naming used throughout, for an 8 x 8 canvas:

| Name | x range | y range |
| --- | --- | --- |
| TL | 0–3 | 0–3 |
| TR | 4–7 | 0–3 |
| BL | 0–3 | 4–7 |
| BR | 4–7 | 4–7 |

Five of the fixtures carry a filler 4-entry `0x2019` palette that is *not* under
test (they are RGBA files; the palette is inert). `indexed-palette-per-frame.aseprite`
starts from the same four entries. It is always:

| Index | RGBA |
| --- | --- |
| 0 | `0, 0, 0, 255` |
| 1 | `255, 0, 0, 255` |
| 2 | `0, 255, 0, 255` |
| 3 | `0, 0, 255, 255` |

---

## A. `rgba-durations.aseprite`

Per-frame durations, and a frame with no cel at all.

**Header** — depth 32, 4 frames, `transparentIndex` 0, 4 colours, header
`speed` = **1000**.

The header speed is deliberately unlike every real frame duration. A reader that
falls back to the deprecated field reports 1000 ms for all four frames.

**Frames**

| Frame | `durationMs` | Chunks | Cel |
| --- | --- | --- | --- |
| 0 | **100** | 4 | yes |
| 1 | **250** | 1 | yes |
| 2 | **40** | 1 | yes |
| 3 | **33** | **0** | **none** |

Frame 3 has zero chunks — both the old `WORD` count and the new `DWORD` count
are 0. It must still parse, still report `durationMs === 33`, and composite to a
fully transparent 8 x 8 frame.

**Layers** — one: index 0, `"Layer 1"`, image, normal, opacity 255, visible.

**Cels** — frames 0–2, layer 0, origin `(0, 0)`, 8 x 8, cel type 2
(compressed), cel opacity 255, `zIndex` 0. Frame 3 has none.

**Pixels** — solid quadrants, rotating one step per frame:

| Frame | TL | TR | BL | BR |
| --- | --- | --- | --- | --- |
| 0 | `255,0,0,255` | `0,255,0,255` | `0,0,255,255` | `255,255,0,255` |
| 1 | `255,255,0,255` | `255,0,0,255` | `0,255,0,255` | `0,0,255,255` |
| 2 | `0,0,255,255` | `255,255,0,255` | `255,0,0,255` | `0,255,0,255` |
| 3 | `0,0,0,0` | `0,0,0,0` | `0,0,0,0` | `0,0,0,0` |

**Assert**

- `doc.frames.map(f => f.durationMs)` is `[100, 250, 40, 33]`.
- `findCel(doc, 3, 0)` is `undefined`; frame 3 composites to all-zero RGBA.
- Frame 0 composite at `(1,1)` = `255,0,0,255`; `(5,1)` = `0,255,0,255`;
  `(1,5)` = `0,0,255,255`; `(5,5)` = `255,255,0,255`.
- Frame 2 composite at `(1,1)` = `0,0,255,255` (proves frames are not aliased).

---

## B. `rgba-linked-and-raw.aseprite`

All three cel types, plus clipping off both the left and right canvas edges.

**Header** — depth 32, 3 frames, `transparentIndex` 0, 4 colours, `speed` 100.
All three frames are 100 ms.

**Layers** — one: index 0, `"Layer 1"`, image, normal, opacity 255, visible.

**Cels** — all three share the geometry `x = -2, y = 1, width = 12, height = 4`,
cel opacity 255, `zIndex` 0.

| Frame | Cel type | |
| --- | --- | --- |
| 0 | **2** | compressed image |
| 1 | **0** | **raw / uncompressed** — no real fixture covers this |
| 2 | **1** | **linked**, `Frame position to link with` = 0 |

The linked cel chunk also carries `x = -2, y = 1, opacity 255, zIndex 0`, exactly
as real Aseprite mirrors the source cel's fields, so "inherit everything from the
source" and "trust the local header fields" agree here.

**Pixels**, in cel-local coordinates `(c, r)` with `c` 0–11 and `r` 0–3:

- `c === 6` → `0, 0, 0, 0` (fully transparent column)
- otherwise frame 0 → `c*20, r*60, 0, 255`
- otherwise frame 1 → `c*20, r*60, 200, 255`
- frame 2 resolves to frame 0's pixels

**Canvas mapping** — `c = x + 2`, `r = y - 1`. Cel columns `c = 0, 1` fall off
the left edge and `c = 10, 11` off the right; cel rows cover canvas `y` 1–4 only.

Frame 0 (and, identically, frame 2) composites to:

| Canvas x | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| red channel | 40 | 60 | 80 | 100 | — | 140 | 160 | 180 |

| Canvas y | 0 | 1 | 2 | 3 | 4 | 5–7 |
| --- | --- | --- | --- | --- | --- | --- |
| green channel | — | 0 | 60 | 120 | 180 | — |

so e.g. frame 0 `(0,1)` = `40,0,0,255`, `(7,4)` = `180,180,0,255`,
`(4,2)` = `0,0,0,0`, `(0,0)` = `0,0,0,0`, `(3,5)` = `0,0,0,0`.

Frame 1 is the same with blue 200: `(0,1)` = `40,0,200,255`,
`(7,4)` = `180,180,200,255`.

**Assert**

- All three cels report `x === -2`, `y === 1`, `width === 12`, `height === 4`.
- Frame 2's resolved pixels are byte-equal to frame 0's.
- Frame 1's pixel at cel-local `(2,0)` is `40,0,200,255` — the raw path decoded.
- Clipping guard: in the frame 0 composite, no opaque pixel has a red channel of
  0, 20, 200 or 220. Those are exactly the clipped columns `c = 0, 1, 10, 11`;
  seeing one means the compositor wrapped or mis-offset instead of clipping.

---

## C. `indexed-transparent.aseprite`

Indexed depth, a non-zero transparent index, a background layer, and a
variable-stride palette.

**Header** — depth **8**, 1 frame (100 ms), `transparentIndex` = **3**,
4 colours.

**Palette** — new-style `0x2019`, 4 entries, `first` 0, `last` 3. Entry 1 sets
the has-name bit, so entries 2 and 3 only decode correctly if the reader advanced
past the name `STRING`.

| Index | RGBA | Name |
| --- | --- | --- |
| 0 | `0,0,0,255` | — |
| 1 | `255,0,0,255` | **`hero-red`** |
| 2 | `0,255,0,255` | — |
| 3 | `0,0,255,255` | — |

**Layers**

| Index | Name | Flags | Notes |
| --- | --- | --- | --- |
| 0 | `Background` | 11 = 1\|2\|8 | `background === true`, visible |
| 1 | `Sprite` | 3 = 1\|2 | `background === false`, visible |

**Cels** — both 8 x 8 at `(0, 0)`, cel type 2, opacity 255, `zIndex` 0.

- Layer 0 indices: `3` where `x < 4`, `0` where `x >= 4`.
- Layer 1 indices: `3` where `y < 4`; otherwise `1` where `x < 4`, `2` where `x >= 4`.

**Decoded cel RGBA** — index 3 is the transparent index, so the *same* byte
decodes differently per layer:

| Cel | Region | RGBA |
| --- | --- | --- |
| layer 0 (background) | `x < 4` | `0,0,255,255` — **opaque**, index 3 ignored |
| layer 0 (background) | `x >= 4` | `0,0,0,255` |
| layer 1 (sprite) | `y < 4` | `0,0,0,0` — **transparent** |
| layer 1 (sprite) | `x < 4, y >= 4` | `255,0,0,255` |
| layer 1 (sprite) | `x >= 4, y >= 4` | `0,255,0,255` |

**Composite**

| Coordinate | RGBA |
| --- | --- |
| `(1,1)` | `0,0,255,255` |
| `(5,1)` | `0,0,0,255` |
| `(1,5)` | `255,0,0,255` |
| `(5,5)` | `0,255,0,255` |

**Assert**

- `doc.transparentIndex === 3`.
- `doc.palette` has exactly 4 entries with the RGBA values above. The document
  model has no per-entry name field, so the named entry is tested indirectly:
  entries 2 and 3 must still be `0,255,0,255` and `0,0,255,255`. A reader that
  assumes a fixed 6-byte entry stride reads the name bytes as colour and gets
  garbage here.
- `doc.layers[0].background === true`, `doc.layers[1].background === false`.
- The two composite pixels `(1,1)` and `(1,5)` are both fully opaque — proof the
  transparent index was applied on one layer and not the other.

---

## D. `grayscale-oldpalette.aseprite`

Grayscale depth with **only** a deprecated `0x0004` palette chunk — no `0x2019`
anywhere in the file, mirroring what real Aseprite emits for grayscale sprites.

**Header** — depth **16**, 1 frame (100 ms), `transparentIndex` 0,
`Number of colors` 6.

**Palette** — `0x0004`, two packets. The second packet's non-zero skip is the
part no real fixture exercises.

| Packet | `skip` | Count | Lands on indices |
| --- | --- | --- | --- |
| 0 | 0 | 3 | 0, 1, 2 |
| 1 | **1** | 2 | **4, 5** |

| Index | RGB |
| --- | --- |
| 0 | `0,0,0` |
| 1 | `64,64,64` |
| 2 | `128,128,128` |
| 3 | **never written by any packet** |
| 4 | `200,10,20` |
| 5 | `30,200,40` |

`0x0004` entries carry no alpha; the expected decoded alpha is 255. Index 3 is
genuinely unspecified by the file — **do not assert anything about it**; assert
indices 0, 1, 2, 4, 5. A reader that ignores the `skip` byte puts `200,10,20` at
index 3 and `30,200,40` at index 4, which the index-4 and index-5 assertions
catch.

**Layers** — one: index 0, `"Layer 1"`, image, normal, opacity 255, visible.

**Cels** — one, 8 x 8 at `(0, 0)`, cel type 2, opacity 255, `zIndex` 0.
Grayscale `(value, alpha)` = `(x * 32, y < 4 ? 255 : 128)`.

**Composite** — RGBA at `(x, y)` is `x*32, x*32, x*32, (y < 4 ? 255 : 128)`.

| Coordinate | RGBA |
| --- | --- |
| `(0,0)` | `0,0,0,255` |
| `(4,0)` | `128,128,128,255` |
| `(7,0)` | `224,224,224,255` |
| `(0,6)` | `0,0,0,128` |
| `(4,6)` | `128,128,128,128` |
| `(7,7)` | `224,224,224,128` |

**Assert**

- `doc.colorDepth === 16`.
- The grayscale value is replicated across R, G and B, and the second byte
  becomes alpha (not the other way round — a byte-swap gives `(255,255,255,0)`
  at `(7,0)`).
- `doc.palette[4]` is `200,10,20,255` and `doc.palette[5]` is `30,200,40,255`.

---

## E. `layers-blend.aseprite`

Blend modes, sub-255 layer opacity, a hidden layer, a group with a child, and
non-zero cel z-indices.

**Header** — depth 32, 1 frame (100 ms), header `flags` = **3** (1 = layer
opacity valid, 2 = blend/opacity valid for groups too), `transparentIndex` 0,
4 colours.

**Layers** — file order is the layer index (spec NOTE.2), so the group consumes
index 3 and its child is index 4.

| Index | Name | Type | `childLevel` | Flags | `visible` | Blend | Opacity |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | `Base` | image | 0 | 3 | true | `normal` (0) | 255 |
| 1 | `Mult` | image | 0 | 3 | true | **`multiply` (1)** | **128** |
| 2 | `Hidden` | image | 0 | **2** | **false** | `normal` (0) | 255 |
| 3 | `Group` | **group** | 0 | 3 | true | `normal` (0) | 255 |
| 4 | `Add` | image | **1** | 3 | true | **`addition` (16)** | 255 |

Layer 4's `parentIndex` is 3; every other layer's is `null`.

**Cels** — all cel opacity 255, all cel type 2.

| Layer | Origin | Size | `zIndex` | Solid colour |
| --- | --- | --- | --- | --- |
| 0 | `(0,0)` | 8 x 8 | 0 | per-quadrant, below |
| 1 | `(4,4)` (BR) | 4 x 4 | **-1** | `255,128,64,255` |
| 2 | `(4,0)` (TR) | 4 x 4 | 0 | `255,0,255,255` |
| 4 | `(0,4)` (BL) | 4 x 4 | **+2** | `50,40,30,255` |

Layer 3 (the group) has no cel.

Base layer quadrants:

| TL | TR | BL | BR |
| --- | --- | --- | --- |
| `100,150,200,255` | `200,100,50,255` | `50,200,100,255` | `180,180,180,255` |

**Render order** — by spec NOTE.5, sort ascending on `layerIndex + zIndex`, then
ascending on `zIndex`. Layer 2 is dropped (not visible):

| Cel | `layerIndex + zIndex` | `zIndex` |
| --- | --- | --- |
| layer 1 (`Mult`) | 0 | -1 |
| layer 0 (`Base`) | 0 | 0 |
| layer 4 (`Add`) | 6 | +2 |

so back-to-front the order is **`Mult`, `Base`, `Add`** — the multiply layer
renders *underneath* the fully opaque base and is therefore invisible.

**Composite**

| Quadrant | RGBA | Why |
| --- | --- | --- |
| TL | `100,150,200,255` | base only |
| TR | `200,100,50,255` | hidden layer suppressed |
| BL | `100,240,130,255` | addition: `50+50, 200+40, 100+30`, opacity 255 |
| BR | `180,180,180,255` | multiply layer occluded by z-order |

The BL value is identical under Aseprite's legacy and "new" blend methods
(verified against `blend_funcs.cpp` transcribed to JS), because both source and
backdrop are fully opaque and the effective opacity is 255.

**Assert**

- `doc.layers[3].type === "group"`, `doc.layers[4].childLevel === 1`,
  `doc.layers[4].parentIndex === 3`.
- `doc.layers[1].blendMode === "multiply"` and `doc.layers[1].opacity === 128`;
  `doc.layers[4].blendMode === "addition"`.
- `doc.layers[2].visible === false` and `effectivelyVisible === false`.
- The four composite quadrant values above.

**Failure signatures** — each wrong answer identifies the bug:

| Observed | Bug |
| --- | --- |
| TR = `255,0,255,255` | the hidden layer was drawn |
| BR = `180,135,113,255` | `zIndex` ignored, `Mult` drawn on top of `Base` |
| BL = `50,200,100,255` | the group's child cel was dropped |

---

## F. `tags-directions.aseprite`

All four loop directions including ping-pong-reverse, a non-zero repeat, and tag
colours carried in trailing user data.

**Header** — depth 32, **12 frames**, all 100 ms, `transparentIndex` 0,
4 colours.

**Layers** — one: index 0, `"Layer 1"`, image, normal, opacity 255, visible.

**Cels** — every frame `f` has one 8 x 8 cel at `(0, 0)`, cel type 2, opacity
255, `zIndex` 0, solid `10 + f*20, 0, 0, 255`:

| Frame | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| red | 10 | 30 | 50 | 70 | 90 | 110 | 130 | 150 | 170 | 190 | 210 | 230 |

so any frame is identifiable from a single pixel.

**Tags** — one `0x2018` chunk with four tags, followed immediately by four
`0x2020` user data chunks (spec special case 1: same order as the tags).

| # | Name | From | To | Direction id | `direction` | `repeat` | Colour |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | `forward` | 0 | 3 | 0 | `forward` | 0 | `#ff0000` |
| 1 | `reverse` | 4 | 7 | 1 | `reverse` | **3** | `#00ff00` |
| 2 | `pingpong` | 8 | 10 | 2 | `pingpong` | 0 | `#0000ff` |
| 3 | `pingpong_reverse` | 11 | 11 | 3 | **`pingpong-reverse`** | 0 | `#ffff00` |

The deprecated per-tag RGB bytes inside the tags chunk are all `0,0,0` — exactly
as Aseprite leaves them. A reader that trusts that field instead of the trailing
user data reports `#000000` for all four tags.

The chunk order in frame 0 is: colour profile, palette, tags, 4 x user data,
layer, cel. The user data chunks sit between the tags chunk and the layer chunk,
so a reader that attaches user data to "the last read chunk" without the
tags special case will hang all four onto the tags chunk itself, or onto the
layer, and the tag colours come back `undefined`.

**Assert**

- `doc.tags` has length 4, in the order above, with the exact `from`/`to`.
- `doc.tags[3].direction === "pingpong-reverse"` — the case most third-party
  readers get wrong.
- `doc.tags[1].repeat === 3`; the other three are `0`.
- `doc.tags.map(t => t.color)` is `["#ff0000", "#00ff00", "#0000ff", "#ffff00"]`.
- `doc.frameCount === 12`, and frame `f`'s composite at `(0,0)` has red
  `10 + f*20` with `g = b = 0` and `a = 255`.

---

## G. `rgba-reference-layer.aseprite`

A reference layer (Layer Chunk flag 64). Aseprite shows reference layers in the
editor only and never renders them into a saved or exported image
(`render.cpp`: "Ignore reference layers" unless the editor's show-reference
flag is set).

**Header** — depth 32, 1 frame (100 ms), `transparentIndex` 0, 4 colours
(the filler palette).

**Layers**

| Index | Name | Flags | `visible` | `reference` |
| --- | --- | --- | --- | --- |
| 0 | `Art` | 3 = 1\|2 | true | false |
| 1 | `Reference` | **67** = 1\|2\|64 | true | **true** |

**Cels** — cel type 2, opacity 255, `zIndex` 0.

| Layer | Origin | Size | Solid colour |
| --- | --- | --- | --- |
| 0 | `(0,0)` | 4 x 8 (left half) | `255,0,0,255` |
| 1 | `(0,0)` | 8 x 8 | `0,0,255,255` |

**Composite** — the reference layer contributes nothing, with or without
`includeHiddenLayers`:

| Coordinate | RGBA |
| --- | --- |
| `(1,1)` | `255,0,0,255` |
| `(5,1)` | `0,0,0,0` |

32 opaque pixels in total.

**Failure signature** — `(1,1)` and `(5,1)` both `0,0,255,255`: the reference
layer was composited.

---

## H. `indexed-palette-per-frame.aseprite`

A palette that changes between frames, as in palette-cycling animation.

**Header** — depth **8**, 3 frames (100 ms each), `transparentIndex` 0,
4 colours.

**Layers** — one: index 0, `"Layer 1"`, image, normal, opacity 255, visible.

**Chunks per frame**

| Frame | Palette chunk | Cel |
| --- | --- | --- |
| 0 | `0x2019` size 4, entries 0–3 = the filler palette (index 1 = **red**) | type 2, 8 x 8 at `(0,0)` |
| 1 | `0x2019` size 4, `first` = `last` = **1**, entry 1 = `0,0,255,255` (**blue**) | type 2, same indices |
| 2 | none — inherits frame 1's palette | type **1**, linked to frame 0 |

Every cel stores index `1` where `x < 4` and index `2` where `x >= 4`.

**Palette in effect**

| Frame | Index 1 | Index 2 |
| --- | --- | --- |
| 0 | `255,0,0,255` | `0,255,0,255` |
| 1 | `0,0,255,255` | `0,255,0,255` |
| 2 | `0,0,255,255` | `0,255,0,255` |

**Composite**

| Frame | `(1,1)` | `(5,1)` |
| --- | --- | --- |
| 0 | `255,0,0,255` | `0,255,0,255` |
| 1 | `0,0,255,255` | `0,255,0,255` |
| 2 | `0,0,255,255` | `0,255,0,255` |

Frame 2 is a link to frame 0's index image but is drawn with frame 2's palette,
which is what Aseprite renders: a linked cel shares the image, and the renderer
looks up the palette of the frame being drawn.

**Assert**

- `doc.palette` is the frame-0 palette (index 1 red), not the last one written.
- The three composites above. Frame 0's cel pixels stay red at `(1,1)` after
  frame 2's link is resolved.

**Failure signatures**

| Observed | Bug |
| --- | --- |
| frame 0 `(1,1)` = `0,0,255,255` | one global palette; the last chunk recoloured every frame |
| frame 2 `(1,1)` = `255,0,0,255` | the link reused the source frame's colours |
| frame 1 `(5,1)` = `0,0,0,0` | the partial update truncated or reset the palette |
