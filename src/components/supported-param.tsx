"use client";

import { useEffect } from "react";
import { handleSupportedParam } from "@/lib/donation";

export function SupportedParam() {
  useEffect(() => {
    handleSupportedParam(window);
  }, []);
  return null;
}
