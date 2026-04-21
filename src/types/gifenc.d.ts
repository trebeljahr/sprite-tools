declare module "gifenc" {
  export interface GIFEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: {
        palette?: number[][];
        delay?: number;
        transparent?: boolean;
        transparentIndex?: number;
        dispose?: number;
        first?: boolean;
        repeat?: number;
      },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    buffer: ArrayBuffer;
    stream(): { bytes: Uint8Array };
  }

  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): GIFEncoderInstance;

  export type QuantizeFormat = "rgb565" | "rgb444" | "rgba4444";

  export function quantize(
    data: Uint8ClampedArray | Uint8Array,
    maxColors: number,
    opts?: { format?: QuantizeFormat; oneBitAlpha?: boolean | number; clearAlpha?: boolean; clearAlphaThreshold?: number; clearAlphaColor?: number },
  ): number[][];

  export function applyPalette(
    data: Uint8ClampedArray | Uint8Array,
    palette: number[][],
    format?: QuantizeFormat,
  ): Uint8Array;

  export function nearestColorIndex(palette: number[][], pixel: number[]): number;
}
