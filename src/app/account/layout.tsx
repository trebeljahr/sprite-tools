import { pageMetadata } from "@/lib/page-metadata";

export const metadata = {
  ...pageMetadata("/account", {
    title: "Your account",
    description: "Sign in to manage your Sprite Tools account and AI credit.",
  }),
  robots: { index: false, follow: true },
};

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return children;
}
