import { fromNodeHeaders } from "better-auth/node";
import type { Request, Response } from "express";
import { requireAccount } from "../auth.js";
import { getDatabase } from "../db.js";
import {
  findImageModel,
  generateXaiImage,
  IMAGE_MODELS,
  IMAGE_PRICING_DATE,
  imagePriceMicros,
  MARGIN_PERCENT,
  microsToUsd,
  PROMPT_MAX_LENGTH,
  ProviderRejected,
} from "../image-generation.js";
import {
  CREDIT_AMOUNTS_USD,
  createCheckoutSession,
  isCreditAmount,
  paidCheckout,
  stripeConfig,
  verifyStripeSignature,
} from "../stripe.js";
import { VideoLedger } from "../video-ledger.js";

const NO_STORE = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function siteOrigin(): string {
  return new URL(process.env.BETTER_AUTH_URL ?? "").origin;
}

// Cookie-authenticated POSTs only from the site itself. The session cookie is
// SameSite=Lax and the body must be JSON, so this is a second fence.
function fromSite(req: Request): boolean {
  try {
    return req.headers.origin === siteOrigin();
  } catch {
    return false;
  }
}

async function balanceMicros(owner: string): Promise<number> {
  const result = await getDatabase().query(
    "SELECT available FROM video_budgets WHERE owner_id=$1",
    [owner],
  );
  return Number(result.rows[0]?.available ?? 0);
}

/** What /generate and /account show: prices, margin, and what this server offers. */
export function creditsInfo(_req: Request, res: Response) {
  res.set(NO_STORE).json({
    generation: Boolean(process.env.XAI_API_KEY),
    purchase: stripeConfig() !== null,
    marginPercent: MARGIN_PERCENT,
    pricingDate: IMAGE_PRICING_DATE,
    amountsUsd: CREDIT_AMOUNTS_USD,
    models: IMAGE_MODELS.map((model) => ({
      id: model.id,
      label: model.label,
      costUsd: model.costUsd,
      priceUsd: microsToUsd(imagePriceMicros(model.costUsd)),
    })),
  });
}

export async function creditsCheckout(req: Request, res: Response) {
  if (!fromSite(req)) return res.status(403).set(NO_STORE).json({ error: "Wrong origin" });
  const config = stripeConfig();
  if (!config)
    return res
      .status(503)
      .set(NO_STORE)
      .json({ error: "Buying AI credit is not set up on this server." });
  let user: Awaited<ReturnType<typeof requireAccount>>;
  try {
    user = await requireAccount(fromNodeHeaders(req.headers));
  } catch {
    return res.status(401).set(NO_STORE).json({ error: "Sign in to buy AI credit." });
  }
  const amountUsd = (req.body as { amountUsd?: unknown } | undefined)?.amountUsd;
  if (!isCreditAmount(amountUsd))
    return res.status(400).set(NO_STORE).json({ error: "Pick one of the listed amounts." });
  try {
    const url = await createCheckoutSession(config, {
      ownerId: user.id,
      email: user.email,
      amountUsd,
      siteOrigin: siteOrigin(),
    });
    res.set(NO_STORE).json({ url });
  } catch {
    res.status(502).set(NO_STORE).json({ error: "Stripe is not answering. Try again later." });
  }
}

export async function stripeWebhook(req: Request, res: Response) {
  const config = stripeConfig();
  if (!config) return res.status(503).set(NO_STORE).json({ error: "Not configured" });
  const payload = req.body;
  if (
    !Buffer.isBuffer(payload) ||
    !verifyStripeSignature(payload, req.get("stripe-signature"), config.webhookSecret)
  )
    return res.status(400).set(NO_STORE).json({ error: "Bad signature" });
  let purchase: ReturnType<typeof paidCheckout>;
  try {
    purchase = paidCheckout(JSON.parse(payload.toString("utf8")));
  } catch {
    return res.status(400).set(NO_STORE).json({ error: "Malformed event" });
  }
  // Errors past this point answer 500, so Stripe retries the event later.
  if (purchase) await new VideoLedger(getDatabase()).grantPurchase(purchase);
  res.set(NO_STORE).json({ received: true });
}

export async function generateImage(req: Request, res: Response) {
  if (!fromSite(req)) return res.status(403).set(NO_STORE).json({ error: "Wrong origin" });
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey)
    return res
      .status(503)
      .set(NO_STORE)
      .json({ error: "Generation with AI credit is not set up on this server." });
  let user: Awaited<ReturnType<typeof requireAccount>>;
  try {
    user = await requireAccount(fromNodeHeaders(req.headers));
  } catch {
    return res.status(401).set(NO_STORE).json({ error: "Sign in to use AI credit." });
  }
  const body = (req.body ?? {}) as { model?: unknown; prompt?: unknown; requestKey?: unknown };
  const model = findImageModel(body.model);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const requestKey = typeof body.requestKey === "string" ? body.requestKey : "";
  if (!model || !prompt || prompt.length > PROMPT_MAX_LENGTH || !UUID.test(requestKey))
    return res
      .status(400)
      .set(NO_STORE)
      .json({ error: "Send a model, a prompt and a request key." });

  const ledger = new VideoLedger(getDatabase());
  const price = imagePriceMicros(model.costUsd);
  let job: { id: string; created: boolean };
  try {
    job = await ledger.reserve(user.id, requestKey, price);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "Insufficient generation credits")
      return res.status(402).set(NO_STORE).json({ error: "Not enough AI credit for this image." });
    if (message === "A generation is already active")
      return res.status(409).set(NO_STORE).json({ error: "Another image is still generating." });
    if (message === "Reservation conflict")
      return res.status(409).set(NO_STORE).json({ error: "This request cannot run again." });
    throw error;
  }
  if (!job.created)
    return res.status(409).set(NO_STORE).json({ error: "This request already ran." });

  let image: string;
  try {
    image = await generateXaiImage(apiKey, model.id, prompt);
  } catch (error) {
    if (error instanceof ProviderRejected) {
      await ledger.release(user.id, job.id);
      return res
        .status(502)
        .set(NO_STORE)
        .json({ error: `${error.message} Your credit was not charged.` });
    }
    await ledger.settle(user.id, job.id, "failed");
    return res.status(504).set(NO_STORE).json({
      error:
        "xAI did not answer in time. It may still have billed the request, so the price was taken from your credit.",
    });
  }
  // The image exists and xAI billed it: hand it over even if the ledger
  // write fails. An unsettled reservation is settled on the next request
  // (VideoLedger.reserve), so the price is taken exactly once.
  let balanceUsd: number | null = null;
  try {
    await ledger.settle(user.id, job.id, "done");
    balanceUsd = microsToUsd(await balanceMicros(user.id));
  } catch {}
  res.set(NO_STORE).json({ image, priceUsd: microsToUsd(price), balanceUsd });
}
