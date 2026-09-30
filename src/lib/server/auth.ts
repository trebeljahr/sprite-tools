import "server-only";
import { betterAuth } from "better-auth";
import { headers } from "next/headers";
import { getDatabase } from "./db";
import { projectSesReady, sendProjectSesEmail, type ProjectSesConfig } from "./ses-email";

function sesConfig(): ProjectSesConfig {
  const value = (key: string) => process.env[key] ?? "";
  return {
    SES_PROJECT_ACCESS_KEY_ID: value("SES_PROJECT_ACCESS_KEY_ID"),
    SES_PROJECT_SECRET_ACCESS_KEY: value("SES_PROJECT_SECRET_ACCESS_KEY"),
    SES_PROJECT_REGION: value("SES_PROJECT_REGION"),
    SES_PROJECT_IDENTITY_ARN: value("SES_PROJECT_IDENTITY_ARN"),
    SES_PROJECT_TENANT: value("SES_PROJECT_TENANT"),
    SES_PROJECT_CONFIGURATION_SET: value("SES_PROJECT_CONFIGURATION_SET"),
    SES_PROJECT_FROM_EMAIL: value("SES_PROJECT_FROM_EMAIL"),
    EMAIL_TEST_RECIPIENT: value("EMAIL_TEST_RECIPIENT"),
    isProduction: process.env.NODE_ENV === "production",
    isTest: process.env.NODE_ENV === "test",
  };
}

// Adapted from Hatchkit's Better Auth starter. No fallback logs for auth links.
async function sendAccountEmail(to: string, subject: string, url: string) {
  if (process.env.EMAIL_TRANSPORT === "ses") {
    await sendProjectSesEmail({ to, subject, text: `${subject}: ${url}` }, sesConfig());
    return;
  }
  const base = new URL(process.env.LISTMONK_URL!);
  if (base.protocol !== "https:") throw new Error("Email requires HTTPS");
  const escapeHtml = (s: string) =>
    s
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const response = await fetch(new URL("/api/tx", base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${process.env.LISTMONK_API_USER}:${process.env.LISTMONK_API_TOKEN}`).toString("base64")}`,
    },
    body: JSON.stringify({
      subscriber_email: to,
      subscriber_mode: "external",
      template_id: Number(process.env.LISTMONK_TX_TEMPLATE_ID),
      from_email: process.env.LISTMONK_FROM_EMAIL,
      data: { subject, body: `<p><a href="${escapeHtml(url)}">${escapeHtml(subject)}</a></p>` },
      content_type: "html",
    }),
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error("Account email could not be sent");
}

function createAuth() {
  const secret = process.env.BETTER_AUTH_SECRET;
  const baseURL = process.env.BETTER_AUTH_URL;
  if (!secret || secret.length < 32 || !baseURL) throw new Error("Accounts are not configured");
  const origin = new URL(baseURL);
  if (
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    (origin.protocol !== "https:" &&
      !(
        process.env.NODE_ENV !== "production" &&
        origin.protocol === "http:" &&
        origin.hostname === "127.0.0.1"
      ))
  ) {
    throw new Error("Invalid account origin");
  }
  if (process.env.EMAIL_TRANSPORT === "ses") {
    if (!projectSesReady(sesConfig())) throw new Error("Account email is not configured");
  } else {
    if (process.env.EMAIL_TRANSPORT && process.env.EMAIL_TRANSPORT !== "listmonk")
      throw new Error("Unknown email transport");
    for (const key of [
      "LISTMONK_URL",
      "LISTMONK_API_USER",
      "LISTMONK_API_TOKEN",
      "LISTMONK_TX_TEMPLATE_ID",
      "LISTMONK_FROM_EMAIL",
    ]) {
      if (!process.env[key]) throw new Error("Account email is not configured");
    }
  }
  return betterAuth({
    database: getDatabase(),
    secret,
    baseURL: origin.origin,
    trustedOrigins: [origin.origin],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) =>
        sendAccountEmail(user.email, "Reset your Sprite Tools password", url),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) =>
        sendAccountEmail(user.email, "Verify your Sprite Tools email", url),
    },
    account: { accountLinking: { enabled: false } },
    session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 30 },
    advanced: { useSecureCookies: origin.protocol === "https:" },
    logger: { disabled: true },
  });
}

let auth: ReturnType<typeof createAuth> | undefined;
export function getAuth() {
  auth ??= createAuth();
  return auth;
}

export async function requireAccount() {
  const session = await getAuth().api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true },
  });
  if (!session?.user.emailVerified) throw new Error("Sign in with a verified account");
  return session.user;
}
