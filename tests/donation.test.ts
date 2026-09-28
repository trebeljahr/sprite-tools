import { describe, expect, it, vi } from "vitest";
import { SUPPORTED_AT_KEY, handleSupportedParam } from "@/lib/donation";

function fakeWindow(href: string, setItem = vi.fn()) {
  return {
    location: { href },
    history: { replaceState: vi.fn() },
    localStorage: { setItem },
  };
}

describe("handleSupportedParam", () => {
  it("stores the timestamp and strips only the supported param", () => {
    const win = fakeWindow(
      "https://sprites.trebeljahr.com/animate?tutorial=1&supported=1&x=2#s=abc",
    );
    expect(handleSupportedParam(win, 1_700_000_000_000)).toBe(true);
    expect(win.localStorage.setItem).toHaveBeenCalledWith(SUPPORTED_AT_KEY, "1700000000000");
    expect(win.history.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/animate?tutorial=1&x=2#s=abc",
    );
  });

  it("leaves a bare path when supported was the only param", () => {
    const win = fakeWindow("https://sprites.trebeljahr.com/?supported=1");
    handleSupportedParam(win, 1);
    expect(win.history.replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it("does nothing without supported=1", () => {
    for (const href of [
      "https://sprites.trebeljahr.com/?x=1",
      "https://sprites.trebeljahr.com/?supported=0",
    ]) {
      const win = fakeWindow(href);
      expect(handleSupportedParam(win)).toBe(false);
      expect(win.localStorage.setItem).not.toHaveBeenCalled();
      expect(win.history.replaceState).not.toHaveBeenCalled();
    }
  });

  it("still cleans the URL when storage throws", () => {
    const win = fakeWindow(
      "https://sprites.trebeljahr.com/?supported=1",
      vi.fn(() => {
        throw new Error("SecurityError");
      }),
    );
    expect(handleSupportedParam(win)).toBe(true);
    expect(win.history.replaceState).toHaveBeenCalledWith(null, "", "/");
  });
});
