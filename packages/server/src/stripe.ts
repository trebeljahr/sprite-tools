import { createHmac, timingSafeEqual } from "node:crypto";
import { MICROS_PER_USD } from "./image-generation.js";

// Buying AI credit through Stripe Checkout. Plain REST calls, so the server
// needs no Stripe SDK. Buying stays off until both secrets are set:
//   STRIPE_SECRET_KEY      sk_test_… while testing, the live key once ready
//   STRIPE_WEBHOOK_SECRET  whsec_… of the endpoint that points at
//                          /api/credits/stripe-webhook
//   STRIPE_AUTOMATIC_TAX   "true" to let Stripe Tax add VAT/sales tax
//                          (needs Stripe Tax set up in the dashboard)

/** The amounts someone can buy, in US dollars. No bonus credit on any of them. */
export const CREDIT_AMOUNTS_USD = [5, 10, 20] as const;
export const CHECKOUT_PURPOSE = "sprite-tools-ai-credit";
const STRIPE_API = "https://api.stripe.com/v1";
const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  automaticTax: boolean;
}

export function stripeConfig(): StripeConfig | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) return null;
  return { secretKey, webhookSecret, automaticTax: process.env.STRIPE_AUTOMATIC_TAX === "true" };
}

export function isCreditAmount(value: unknown): value is (typeof CREDIT_AMOUNTS_USD)[number] {
  return CREDIT_AMOUNTS_USD.includes(value as (typeof CREDIT_AMOUNTS_USD)[number]);
}

/** Start a Checkout Session for `amountUsd` of credit and return its URL. */
export async function createCheckoutSession(
  config: StripeConfig,
  input: { ownerId: string; email: string; amountUsd: number; siteOrigin: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const form = new URLSearchParams({
    mode: "payment",
    success_url: `${input.siteOrigin}/account?purchase=done`,
    cancel_url: `${input.siteOrigin}/account?purchase=cancelled`,
    client_reference_id: input.ownerId,
    customer_email: input.email,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(input.amountUsd * 100),
    "line_items[0][price_data][product_data][name]": `sprite-tools AI credit, $${input.amountUsd}`,
    // Ricos Labs tags every Stripe object with its project.
    "metadata[project]": "sprite-tools",
    "payment_intent_data[metadata][project]": "sprite-tools",
    "metadata[purpose]": CHECKOUT_PURPOSE,
    "metadata[owner_id]": input.ownerId,
    "metadata[credit_micros]": String(input.amountUsd * MICROS_PER_USD),
  });
  if (config.automaticTax) form.set("automatic_tax[enabled]", "true");
  const response = await fetchImpl(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => null)) as { url?: unknown } | null;
  if (!response.ok || typeof body?.url !== "string") throw new Error("Stripe refused the session");
  return body.url;
}

/** Check a `Stripe-Signature` header against the raw request body. */
export function verifyStripeSignature(
  payload: Buffer,
  header: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t") timestamp = value ?? "";
    else if (key === "v1" && value) signatures.push(value);
  }
  const seconds = Number(timestamp);
  if (!/^\d+$/.test(timestamp) || Math.abs(nowSeconds - seconds) > SIGNATURE_TOLERANCE_SECONDS)
    return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(payload).digest();
  return signatures.some((signature) => {
    const given = Buffer.from(signature, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export interface PaidCheckout {
  sessionId: string;
  ownerId: string;
  creditMicros: number;
  paidCents: number;
}

/**
 * The credit a webhook event grants, or null when the event grants nothing:
 * another event type, another product on the same Stripe account, or a
 * payment that has not arrived yet (Stripe sends
 * checkout.session.async_payment_succeeded for that later).
 */
export function paidCheckout(event: unknown): PaidCheckout | null {
  const { type, data } = (event ?? {}) as { type?: unknown; data?: { object?: unknown } };
  if (type !== "checkout.session.completed" && type !== "checkout.session.async_payment_succeeded")
    return null;
  const session = (data?.object ?? {}) as {
    id?: unknown;
    payment_status?: unknown;
    amount_subtotal?: unknown;
    metadata?: Record<string, unknown> | null;
  };
  if (session.metadata?.purpose !== CHECKOUT_PURPOSE || session.payment_status !== "paid")
    return null;
  const ownerId = session.metadata.owner_id;
  const creditMicros = Number(session.metadata.credit_micros);
  const paidCents = Number(session.amount_subtotal);
  if (
    typeof session.id !== "string" ||
    typeof ownerId !== "string" ||
    !ownerId ||
    !Number.isSafeInteger(creditMicros) ||
    creditMicros <= 0 ||
    // The credit must match what was paid before tax, so a session created
    // with other metadata can never mint more credit than its price.
    paidCents * (MICROS_PER_USD / 100) !== creditMicros
  )
    throw new Error("Malformed AI credit checkout");
  return { sessionId: session.id, ownerId, creditMicros, paidCents };
}
