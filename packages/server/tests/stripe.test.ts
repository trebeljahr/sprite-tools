import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { paidCheckout, verifyStripeSignature } from "../src/stripe";

const SECRET = "whsec_test_only";
const payload = Buffer.from('{"type":"checkout.session.completed"}');

function sign(t: number, secret = SECRET) {
  return createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
}

describe("verifyStripeSignature", () => {
  const now = 1_800_000_000;

  it("accepts a fresh signature, also next to a rotated-out one", () => {
    expect(verifyStripeSignature(payload, `t=${now},v1=${sign(now)}`, SECRET, now)).toBe(true);
    expect(
      verifyStripeSignature(
        payload,
        `t=${now},v1=${sign(now, "whsec_old")},v1=${sign(now)}`,
        SECRET,
        now,
      ),
    ).toBe(true);
  });

  it("refuses a missing, stale, foreign or malformed header", () => {
    expect(verifyStripeSignature(payload, undefined, SECRET, now)).toBe(false);
    expect(
      verifyStripeSignature(payload, `t=${now - 301},v1=${sign(now - 301)}`, SECRET, now),
    ).toBe(false);
    expect(
      verifyStripeSignature(payload, `t=${now},v1=${sign(now, "whsec_other")}`, SECRET, now),
    ).toBe(false);
    expect(verifyStripeSignature(payload, `t=${now},v1=zz`, SECRET, now)).toBe(false);
    expect(verifyStripeSignature(payload, `v1=${sign(now)}`, SECRET, now)).toBe(false);
  });
});

describe("paidCheckout", () => {
  const session = {
    id: "cs_test_1",
    payment_status: "paid",
    amount_subtotal: 1000,
    metadata: { purpose: "sprite-tools-ai-credit", owner_id: "u1", credit_micros: "10000000" },
  };

  it("grants the paid amount and ignores other events and products", () => {
    expect(paidCheckout({ type: "checkout.session.completed", data: { object: session } })).toEqual(
      {
        sessionId: "cs_test_1",
        ownerId: "u1",
        creditMicros: 10_000_000,
        paidCents: 1000,
      },
    );
    expect(paidCheckout({ type: "invoice.paid", data: { object: session } })).toBeNull();
    expect(
      paidCheckout({
        type: "checkout.session.completed",
        data: { object: { ...session, metadata: { project: "ricos.site" } } },
      }),
    ).toBeNull();
  });

  it("refuses credit that does not match the price paid", () => {
    expect(() =>
      paidCheckout({
        type: "checkout.session.completed",
        data: { object: { ...session, amount_subtotal: 500 } },
      }),
    ).toThrow("Malformed");
  });
});
