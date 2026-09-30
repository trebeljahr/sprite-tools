"use server";

import { PAID_VIDEO_UNAVAILABLE, type GenerationResponse } from "@/lib/xai";

// Deny before reading uploads. The client-side AuthWall is only a UI placeholder.
// Re-enabling requires server authentication, job ownership, and atomic budgets.
export async function generateVideoAction(
  _formData: FormData,
): Promise<{ success: boolean; id?: string; error?: string }> {
  return { success: false, error: PAID_VIDEO_UNAVAILABLE };
}

export async function checkStatusAction(
  _id: string,
): Promise<{ success: boolean; data?: GenerationResponse; error?: string }> {
  return { success: false, error: PAID_VIDEO_UNAVAILABLE };
}
