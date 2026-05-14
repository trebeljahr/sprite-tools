const PRODUCTION_SITE_URL = "https://sprites.trebeljahr.com";
const LOCAL_SITE_URL = "http://localhost:3471";

export function getSiteUrl() {
  const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();

  if (configuredSiteUrl) {
    return configuredSiteUrl.replace(/\/+$/, "");
  }

  return (process.env.NODE_ENV === "production" ? PRODUCTION_SITE_URL : LOCAL_SITE_URL).replace(
    /\/+$/,
    "",
  );
}
