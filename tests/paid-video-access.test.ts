import { afterEach, describe, expect, it, vi } from "vitest";
import { checkStatusAction, generateVideoAction } from "@/app/actions";
import { generateVideo, PAID_VIDEO_UNAVAILABLE, pollVideoStatus } from "@/lib/xai";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("paid video containment", () => {
  for (const configured of [false, true]) {
    it(`denies every entry point with provider configuration ${configured}`, async () => {
      vi.stubEnv("XAI_API_KEY", configured ? "fake-test-key" : undefined);
      vi.stubEnv("NEXT_PUBLIC_ENABLE_AI", "true");
      const fetch = vi.fn(() => {
        throw new Error("Unexpected network access");
      });
      vi.stubGlobal("fetch", fetch);
      const get = vi.fn(() => {
        throw new Error("Disabled action must not read uploads");
      });
      const form = { get } as unknown as FormData;
      const failure = { success: false, error: PAID_VIDEO_UNAVAILABLE };

      expect(await generateVideoAction(form)).toEqual(failure);
      expect(await checkStatusAction("another-users-job")).toEqual(failure);
      await expect(generateVideo("unused-image", "unused-prompt")).rejects.toThrow(
        PAID_VIDEO_UNAVAILABLE,
      );
      await expect(pollVideoStatus("another-users-job")).rejects.toThrow(PAID_VIDEO_UNAVAILABLE);
      expect(get).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });
  }

  it("rejects absent arguments without reading them", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await generateVideoAction(null as unknown as FormData)).toEqual({
      success: false,
      error: PAID_VIDEO_UNAVAILABLE,
    });
    expect(await checkStatusAction(null as unknown as string)).toEqual({
      success: false,
      error: PAID_VIDEO_UNAVAILABLE,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
