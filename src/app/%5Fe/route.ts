import { createEnvelopeTunnel } from "@/lib/envelope-tunnel";
import { getSiteUrl } from "@/lib/site-url";

// %5F keeps the public URL /_e while avoiding Next's private-folder convention.
// The same build-time public DSN configures both the browser SDK and this tunnel.
export const POST = createEnvelopeTunnel(() => process.env.NEXT_PUBLIC_GLITCHTIP_DSN, getSiteUrl);
