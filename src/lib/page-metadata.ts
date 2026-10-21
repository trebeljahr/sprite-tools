import type { Metadata } from "next";

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
      siteName: "sprite-tools",
      url: path,
      title: metadata.title,
      description: metadata.description,
      images: [
        { url: "/opengraph-image", width: 1200, height: 630, alt: "sprite-tools social preview" },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: metadata.title,
      description: metadata.description,
      images: [{ url: "/twitter-image", alt: "sprite-tools social preview" }],
    },
  };
}
