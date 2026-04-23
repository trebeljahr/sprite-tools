// Twitter/X wants a slightly taller aspect than OG. Next.js lets us alias
// the opengraph renderer here so we don't keep two nearly-identical files
// in sync.
export { default } from "./opengraph-image";
export { size, alt, contentType } from "./opengraph-image";
