// Classic pixel-art palettes. Colors are hex strings; pages convert to RGB.
//
// These are hand-curated to match the look of their reference systems; they
// aren't exhaustive hardware dumps.

export interface PalettePreset {
  id: string;
  name: string;
  colors: string[];
  description: string;
}

export const PALETTES: PalettePreset[] = [
  {
    id: "none",
    name: "No palette",
    description: "Only quantize if color count is set; don't snap.",
    colors: [],
  },
  {
    id: "gameboy",
    name: "Game Boy",
    description: "4-shade green DMG screen.",
    colors: ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"],
  },
  {
    id: "gameboy-pocket",
    name: "Game Boy Pocket",
    description: "4-shade neutral gray LCD.",
    colors: ["#1a1a1a", "#555555", "#aaaaaa", "#e6e6e6"],
  },
  {
    id: "mono",
    name: "Monochrome",
    description: "Pure black and white.",
    colors: ["#000000", "#ffffff"],
  },
  {
    id: "pico8",
    name: "PICO-8",
    description: "16-color fantasy-console palette.",
    colors: [
      "#000000",
      "#1d2b53",
      "#7e2553",
      "#008751",
      "#ab5236",
      "#5f574f",
      "#c2c3c7",
      "#fff1e8",
      "#ff004d",
      "#ffa300",
      "#ffec27",
      "#00e436",
      "#29adff",
      "#83769c",
      "#ff77a8",
      "#ffccaa",
    ],
  },
  {
    id: "cga",
    name: "CGA (16)",
    description: "IBM CGA 16-color EGA-era palette.",
    colors: [
      "#000000",
      "#0000aa",
      "#00aa00",
      "#00aaaa",
      "#aa0000",
      "#aa00aa",
      "#aa5500",
      "#aaaaaa",
      "#555555",
      "#5555ff",
      "#55ff55",
      "#55ffff",
      "#ff5555",
      "#ff55ff",
      "#ffff55",
      "#ffffff",
    ],
  },
  {
    id: "nes",
    name: "NES (32)",
    description: "Reduced NES/Famicom palette.",
    colors: [
      "#000000",
      "#fcfcfc",
      "#f8f8f8",
      "#bcbcbc",
      "#7c7c7c",
      "#a4e4fc",
      "#3cbcfc",
      "#0078f8",
      "#0000fc",
      "#b8b8f8",
      "#6888fc",
      "#0058f8",
      "#0000bc",
      "#d8b8f8",
      "#9878f8",
      "#6844fc",
      "#4428bc",
      "#f8b8f8",
      "#f878f8",
      "#d800cc",
      "#940084",
      "#f8a4c0",
      "#f85898",
      "#e40058",
      "#a80020",
      "#f0d0b0",
      "#f87858",
      "#f83800",
      "#a81000",
      "#b8f878",
      "#58d854",
      "#00b800",
    ],
  },
];

export function paletteById(id: string): PalettePreset {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}
