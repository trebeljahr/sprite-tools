"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Mode = "sign-in" | "sign-up" | "forgot" | "reset";
export default function AccountPage() {
  const { data: session, isPending, error: sessionError } = authClient.useSession();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [credits, setCredits] = useState<number | null>(null);
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("token");
    if (value) {
      setToken(value);
      setMode("reset");
      window.history.replaceState(null, "", "/account");
    }
  }, []);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    fetch("/api/account", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then((value) => setCredits(value.credits))
      .catch(() => setCredits(null));
    return () => controller.abort();
  }, [session]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    try {
      if (mode === "sign-in") {
        const result = await authClient.signIn.email({ email, password });
        setMessage(
          result.error ? "Sign-in failed. Check your details and verify your email." : "Signed in.",
        );
      } else if (mode === "sign-up") {
        const result = await authClient.signUp.email({
          name: String(form.get("name") ?? ""),
          email,
          password,
          callbackURL: "/account",
        });
        setMessage(
          result.error
            ? "Could not create an account. Try again later."
            : "Check your email to verify your account, then sign in.",
        );
      } else if (mode === "forgot") {
        await authClient.requestPasswordReset({ email, redirectTo: "/account" });
        setMessage("If an account exists, you will receive a reset email.");
      } else {
        const result = await authClient.resetPassword({ newPassword: password, token });
        if (result.error) setMessage("Reset link is invalid or expired. Request a new one.");
        else {
          setToken("");
          setMode("sign-in");
          setMessage("Password changed. Sign in again.");
        }
      }
    } catch {
      setMessage("Accounts are temporarily unavailable. Try again later.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-md space-y-6 px-4 py-14">
      <h1 className="text-3xl font-semibold">Your account</h1>
      {isPending ? (
        <p>Loading account…</p>
      ) : session && mode !== "reset" ? (
        <>
          <p>Signed in as {session.user.email}.</p>
          <p>
            {credits === null
              ? "Credit balance unavailable."
              : `${credits} generation credits available.`}
          </p>
          <p className="text-sm text-muted-foreground">
            Paid generation is not available yet. Your other sprite tools remain free.
          </p>
          <Button
            onClick={async () => {
              setBusy(true);
              try {
                const result = await authClient.signOut();
                if (result.error) setMessage("Sign-out failed. Try again.");
              } catch {
                setMessage("Sign-out failed. Try again.");
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
          >
            Sign out
          </Button>
        </>
      ) : (
        <>
          {sessionError && <p role="status">Accounts are temporarily unavailable.</p>}
          <form onSubmit={submit} className="space-y-4">
            {mode === "sign-up" && (
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" required maxLength={100} autoComplete="name" />
              </div>
            )}
            {mode !== "reset" && (
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" required autoComplete="email" />
              </div>
            )}
            {mode !== "forgot" && (
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  minLength={12}
                  maxLength={128}
                  required
                  autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                />
              </div>
            )}
            <Button type="submit" disabled={busy}>
              {busy
                ? "Please wait…"
                : mode === "sign-in"
                  ? "Sign in"
                  : mode === "sign-up"
                    ? "Create account"
                    : mode === "forgot"
                      ? "Send reset email"
                      : "Set new password"}
            </Button>
          </form>
          <div className="flex flex-wrap gap-4 text-sm">
            {(
              [
                ["sign-in", "Sign in"],
                ["sign-up", "Create account"],
                ["forgot", "Forgot password?"],
              ] as const
            )
              .filter(([value]) => value !== mode)
              .map(([value, label]) => (
                <button
                  type="button"
                  className="underline"
                  key={value}
                  onClick={() => {
                    setMode(value);
                    setMessage("");
                  }}
                >
                  {label}
                </button>
              ))}
          </div>
          <p className="text-sm text-muted-foreground">
            Accounts start with zero generation credits. No payment is taken when you sign up.
          </p>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </main>
  );
}
