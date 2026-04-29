// Browser ImageData shim for Node. The algorithms in src/lib/** construct
// `new ImageData(w, h)` to return results; Node doesn't ship the class
// globally, so we install a minimal spec-compatible implementation before
// any library code runs.

declare global {
  var ImageData: typeof globalThis.ImageData;
}

if (typeof globalThis.ImageData === "undefined") {
  class ImageDataShim {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
    readonly colorSpace = "srgb" as const;

    constructor(
      dataOrWidth: Uint8ClampedArray | number,
      widthOrHeight: number,
      heightOrOpts?: number,
    ) {
      if (typeof dataOrWidth === "number") {
        this.width = dataOrWidth;
        this.height = widthOrHeight;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      } else {
        this.data = dataOrWidth;
        this.width = widthOrHeight;
        this.height =
          typeof heightOrOpts === "number" ? heightOrOpts : dataOrWidth.length / 4 / widthOrHeight;
      }
    }
  }
  (globalThis as Record<string, unknown>).ImageData = ImageDataShim;
}

export {};
