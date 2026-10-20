import { afterEach, describe, expect, it, vi } from "vitest";
import { track } from "@/lib/analytics";

describe("track", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the event without waiting for a consent choice", () => {
    const plausible = vi.fn();
    vi.stubGlobal("window", { plausible });
    track("export", { tool: "gif", frames: 4 });
    expect(plausible).toHaveBeenCalledWith("export", { props: { tool: "gif", frames: 4 } });
  });

  it("does nothing where Plausible is not loaded", () => {
    vi.stubGlobal("window", {});
    expect(() => track("sample_loaded")).not.toThrow();
  });
});
