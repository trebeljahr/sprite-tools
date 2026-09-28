// ricos.site/donate sends people back to `/?supported=1` after a payment.
// Record when that happened so a future inline ask can stay quiet for a
// while, then drop the param so a reload or shared link doesn't re-trigger.
// Nothing reads the timestamp yet.

export const SUPPORTED_AT_KEY = "donation-supported-at";

type SupportedWindow = {
  location: { href: string };
  history: Pick<History, "replaceState">;
  localStorage: Pick<Storage, "setItem">;
};

/** Returns true when `?supported=1` was present and handled. */
export function handleSupportedParam(win: SupportedWindow, now = Date.now()): boolean {
  const url = new URL(win.location.href);
  if (url.searchParams.get("supported") !== "1") return false;
  try {
    win.localStorage.setItem(SUPPORTED_AT_KEY, String(now));
  } catch {
    // Storage blocked (privacy mode, quota) — still clean the URL.
  }
  url.searchParams.delete("supported");
  win.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return true;
}
