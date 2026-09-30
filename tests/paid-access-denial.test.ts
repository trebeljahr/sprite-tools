import { afterEach, expect, it, vi } from "vitest";
import { checkStatusAction, generateVideoAction } from "../src/app/actions";
import { generateVideo, PAID_VIDEO_UNAVAILABLE, pollVideoStatus } from "../src/lib/xai";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([undefined, "fake-test-key"])(
  "denies paid actions regardless of configured key (%s)",
  async (key) => {
    vi.stubEnv("XAI_API_KEY", key);
    vi.stubEnv("NEXT_PUBLIC_ENABLE_AI", "true");
    const fetch = vi.fn(() => {
      throw new Error("Network must never be reached");
    });
    vi.stubGlobal("fetch", fetch);
    const form = new FormData();
    const read = vi.spyOn(form, "get").mockImplementation(() => {
      throw new Error("Upload must not be read");
    });
    expect(await generateVideoAction(form)).toEqual({
      success: false,
      error: PAID_VIDEO_UNAVAILABLE,
    });
    expect(await checkStatusAction("../untrusted-id")).toEqual({
      success: false,
      error: PAID_VIDEO_UNAVAILABLE,
    });
    await expect(generateVideo("invalid-image", "test")).rejects.toThrow(PAID_VIDEO_UNAVAILABLE);
    await expect(pollVideoStatus("../untrusted-id")).rejects.toThrow(PAID_VIDEO_UNAVAILABLE);
    expect(read).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);
