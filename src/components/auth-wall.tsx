"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";

// UI convenience only. All paid operations remain denied on the server.
export function AuthWall({
  feature,
  description,
}: {
  feature: string;
  description: string;
  costHint?: string;
  children: ReactNode;
}) {
  const { data: session, isPending } = authClient.useSession();
  return (
    <main className="mx-auto max-w-xl space-y-4 px-4 py-12">
      <h1 className="text-2xl font-semibold">{feature}</h1>
      <p>{description}</p>
      <p>
        {isPending
          ? "Loading account…"
          : session
            ? "Paid generation is not available yet."
            : "Sign in to manage your account. Paid generation is not available yet."}
      </p>
      <Link className="underline" href="/account">
        {session ? "Your account" : "Sign in or create an account"}
      </Link>
      <p className="text-sm text-muted-foreground">
        All other sprite tools work without an account.
      </p>
    </main>
  );
}
