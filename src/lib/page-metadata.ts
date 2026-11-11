import type { Metadata } from "next";

// A page that sets its own openGraph/twitter loses the file-convention images
// of src/app/, so every page names them. Same text as opengraph-image.alt.txt.
const SOCIAL_IMAGE_ALT =
  "Sprite Tools: a sprite of a mouse in a coat with its traced collision polygon, beside the line Collision polygons, plus pivots, tags and Godot or Unity files";
const OG_IMAGE = {
  url: "/opengraph-image.jpg",
  type: "image/jpeg",
  width: 1200,
  height: 630,
  alt: SOCIAL_IMAGE_ALT,
};
const TWITTER_IMAGE = { ...OG_IMAGE, url: "/twitter-image.jpg" };

// Each exported route needs its own canonical and social URL. A canonical in
// the root layout alone is inherited by every child, including documentation.
export function pageMetadata(
  path: string,
  metadata: { title: string; description: string },
): Metadata {
  return {
    ...metadata,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: "Sprite Tools",
      url: path,
      title: metadata.title,
      description: metadata.description,
      images: [OG_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: metadata.title,
      description: metadata.description,
      images: [TWITTER_IMAGE],
    },
  };
}
