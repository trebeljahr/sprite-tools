import { describe, expect, it } from "vitest";
import { z } from "../src/lib/zod";
import { validatePlan } from "../src/lib/character/types";
import { characterDemo } from "../src/lib/character/demo";
import { projectSchema } from "../src/lib/motion/core";
import { motionMannequin, newMotionProject } from "../src/lib/motion/presets";
import { validateAnimationSet } from "../src/lib/playground/set";

// zod 4 reworded every built-in error message. These are the zod 3 strings
// MCP clients and the character / motion pages showed before the upgrade.
const messages = (schema: z.ZodType, value: unknown) => {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("expected a failure");
  return result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};

describe("zod 3 error wording on zod 4", () => {
  const schema = z
    .object({
      name: z.string().min(2).max(4),
      count: z.number().int().positive().max(10),
      ratio: z.number().min(0).lt(1),
      mode: z.enum(["full", "auto"]),
      version: z.literal(1),
      id: z.string().regex(/^[a-z]+$/),
      job: z.guid(),
      tags: z.array(z.string()).min(1).max(2),
      point: z.tuple([z.number(), z.number()]),
      extra: z.record(z.string(), z.unknown()),
      edge: z.union([z.literal(512), z.literal(1280)]),
      hex: z.string().regex(/^#[0-9a-f]{6}$/, "expected a hex colour like #000000"),
    })
    .strict();
  const valid = {
    name: "ab",
    count: 1,
    ratio: 0,
    mode: "full",
    version: 1,
    id: "abc",
    job: "12345678-1234-1234-1234-123456789abc",
    tags: ["a"],
    point: [0, 0],
    extra: {},
    edge: 512,
    hex: "#000000",
  };

  it("accepts the valid document", () => {
    expect(schema.safeParse(valid).success).toBe(true);
  });

  it("names missing fields and wrong types as zod 3 did", () => {
    expect(messages(schema, {})).toEqual([
      "name: Required",
      "count: Required",
      "ratio: Required",
      "mode: Required",
      "version: Invalid literal value, expected 1",
      "id: Required",
      "job: Required",
      "tags: Required",
      "point: Required",
      "extra: Required",
      "edge: Invalid input",
      "hex: Required",
    ]);
    expect(
      messages(schema, {
        ...valid,
        name: 5,
        count: 1.5,
        ratio: Number.NaN,
        mode: 3,
        tags: "a",
        point: "a",
        extra: "a",
      }),
    ).toEqual([
      "name: Expected string, received number",
      "count: Expected integer, received float",
      "ratio: Expected number, received nan",
      "mode: Expected 'full' | 'auto', received number",
      "tags: Expected array, received string",
      "point: Expected array, received string",
      "extra: Expected object, received string",
    ]);
  });

  it("states bounds, formats and unknown keys as zod 3 did", () => {
    expect(
      messages(schema, {
        ...valid,
        name: "abcde",
        count: 0,
        ratio: 1,
        mode: "loop",
        version: 2,
        id: "ABC",
        job: "not-a-uuid",
        tags: [],
        edge: 1920,
        hex: "red",
        stray: true,
      }),
    ).toEqual([
      "name: String must contain at most 4 character(s)",
      "count: Number must be greater than 0",
      "ratio: Number must be less than 1",
      "mode: Invalid enum value. Expected 'full' | 'auto', received 'loop'",
      "version: Invalid literal value, expected 1",
      "id: Invalid",
      "job: Invalid uuid",
      "tags: Array must contain at least 1 element(s)",
      "edge: Invalid input",
      "hex: expected a hex colour like #000000",
      ": Unrecognized key(s) in object: 'stray'",
    ]);
    expect(messages(schema, { ...valid, name: "a", count: 11, tags: ["a", "b", "c"] })).toEqual([
      "name: String must contain at least 2 character(s)",
      "count: Number must be less than or equal to 10",
      "tags: Array must contain at most 2 element(s)",
    ]);
  });

  it("calls infinite numbers not finite", () => {
    expect(messages(z.number(), Number.POSITIVE_INFINITY)).toEqual([": Number must be finite"]);
  });

  it("keeps accepting any 8-4-4-4-12 hex id, as zod 3's uuid() did", () => {
    // zod 4's uuid() only takes RFC 9562 variants; guid() is zod 3's rule.
    expect(z.guid().safeParse("12345678-1234-1234-1234-123456789abc").success).toBe(true);
    expect(z.guid().safeParse(crypto.randomUUID()).success).toBe(true);
    expect(z.guid().safeParse("12345678-1234-1234-1234-123456789abg").success).toBe(false);
  });
});

describe("character plan errors", () => {
  const plan = characterDemo().plan;

  it("joins the zod 3 messages into the page's error", () => {
    expect(() => validatePlan({ ...plan, version: 2, width: 1.5 })).toThrow(
      "Invalid character plan: Invalid literal value, expected 1 Expected integer, received float",
    );
    const parts = structuredClone(plan.parts);
    parts[0].id = "Bad Id";
    parts[0].name = "x".repeat(101);
    expect(() => validatePlan({ ...plan, parts })).toThrow(
      "Invalid character plan: Invalid String must contain at most 100 character(s)",
    );
  });

  it("still runs the plan's own checks", () => {
    const parts = structuredClone(plan.parts);
    parts[1].id = parts[0].id;
    expect(() => validatePlan({ ...plan, parts })).toThrow(
      "Part ids must be unique; unassigned, constructor and prototype are reserved.",
    );
  });
});

describe("records keyed by an enum stay partial", () => {
  // zod 4's z.record(z.enum(...)) requires every key; zod 3's did not.
  it("accepts a motion project that binds only some joints", () => {
    const project = newMotionProject(motionMannequin().plan);
    const { torso } = project.binding;
    const parsed = projectSchema.parse({ ...project, binding: { torso } });
    expect(parsed.binding).toEqual({ torso });
    expect(projectSchema.parse({ ...project, binding: {} }).binding).toEqual({});
  });

  it("rejects a joint role that does not exist", () => {
    const project = newMotionProject(motionMannequin().plan);
    const result = projectSchema.safeParse({
      ...project,
      binding: { ...project.binding, wing: { part: "wing", offset: 0 } },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(
      /^Invalid enum value\. Expected 'torso' \| 'head' .* received 'wing'$/,
    );
  });

  it("accepts a playground set that binds and labels only some roles", () => {
    const clip = {
      sheet: "hero.png",
      grid: { cols: 4, rows: 1 },
      count: 4,
      durations: [100, 100, 100, 100],
      loop: true,
    };
    const set = validateAnimationSet({
      version: 1,
      canvas: { width: 128, height: 128 },
      origin: { x: 64, y: 120 },
      clips: { idle: clip, jog: clip },
      controller: { bindings: { walk: "jog" }, labels: { idle: "Rest" } },
    });
    expect(set.bindings.walk).toBe("jog");
    expect(set.bindings.idle).toBe("idle");
    expect(set.controller?.labels).toEqual({ idle: "Rest" });
    expect(() =>
      validateAnimationSet({
        version: 1,
        canvas: { width: 128, height: 128 },
        origin: { x: 64, y: 120 },
        clips: { idle: clip },
        controller: { bindings: { fly: "idle" } },
      }),
    ).toThrow();
  });
});
