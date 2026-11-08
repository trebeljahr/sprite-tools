/**
 * The one place the app imports zod from. Importing `z` here instead of from
 * "zod" guarantees the error map below is installed before any schema parses.
 *
 * zod 4 rewrote every built-in error message ("Too small: expected string to
 * have >=1 characters" where zod 3 said "String must contain at least 1
 * character(s)"). Those messages reach people: MCP clients get them in
 * input-validation errors, and the character and motion pages show them. So
 * this map restores the zod 3 wording for every issue our schemas can raise.
 * Messages a schema states itself (`.regex(re, "…")`, refine messages,
 * `ctx.addIssue`) take precedence over this map, as they did in zod 3.
 */
import { z } from "zod";

type Issue = Parameters<NonNullable<Parameters<typeof z.config>[0]>["customError"] & {}>[0];

/** zod 3's `getParsedType`, which named the received type in its messages. */
function received(input: unknown): string {
  if (input === undefined) return "undefined";
  if (input === null) return "null";
  if (Array.isArray(input)) return "array";
  if (typeof input === "number") return Number.isNaN(input) ? "nan" : "number";
  if (input instanceof Date) return "date";
  if (input instanceof Promise) return "promise";
  if (input instanceof Map) return "map";
  if (input instanceof Set) return "set";
  return typeof input;
}

function quoted(values: readonly unknown[]): string {
  return values.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join(" | ");
}

function schemaType(issue: Issue): string | undefined {
  return (issue.inst as { _zod?: { def?: { type?: string } } } | undefined)?._zod?.def?.type;
}

export function zod3Message(issue: Issue): string | undefined {
  switch (issue.code) {
    case "invalid_type": {
      if (issue.input === undefined) return "Required";
      if (
        typeof issue.input === "number" &&
        !Number.isFinite(issue.input) &&
        !Number.isNaN(issue.input)
      )
        return "Number must be finite";
      if (issue.expected === "int")
        return typeof issue.input === "number"
          ? "Expected integer, received float"
          : `Expected number, received ${received(issue.input)}`;
      // zod 3 called a record an object and a tuple an array.
      const expected =
        issue.expected === "record"
          ? "object"
          : issue.expected === "tuple"
            ? "array"
            : issue.expected;
      return `Expected ${expected}, received ${received(issue.input)}`;
    }
    case "invalid_value":
      if (schemaType(issue) === "literal")
        return `Invalid literal value, expected ${JSON.stringify(issue.values[0])}`;
      // zod 3 type-checked an enum before matching it: a missing value was
      // "Required" and a non-string named its type.
      if (issue.input === undefined) return "Required";
      if (typeof issue.input !== "string")
        return `Expected ${quoted(issue.values)}, received ${received(issue.input)}`;
      return `Invalid enum value. Expected ${quoted(issue.values)}, received '${issue.input}'`;
    case "too_small": {
      const min = String(issue.minimum);
      if (issue.origin === "array" || issue.origin === "set")
        return `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? "at least" : "more than"} ${min} element(s)`;
      if (issue.origin === "string")
        return `String must contain ${issue.exact ? "exactly" : issue.inclusive ? "at least" : "over"} ${min} character(s)`;
      if (issue.origin === "number" || issue.origin === "int")
        return `Number must be ${issue.exact ? "exactly equal to " : issue.inclusive ? "greater than or equal to " : "greater than "}${min}`;
      return undefined;
    }
    case "too_big": {
      const max = String(issue.maximum);
      if (issue.origin === "array" || issue.origin === "set")
        return `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? "at most" : "less than"} ${max} element(s)`;
      if (issue.origin === "string")
        return `String must contain ${issue.exact ? "exactly" : issue.inclusive ? "at most" : "under"} ${max} character(s)`;
      if (issue.origin === "number" || issue.origin === "int")
        return `Number must be ${issue.exact ? "exactly" : issue.inclusive ? "less than or equal to" : "less than"} ${max}`;
      return undefined;
    }
    case "invalid_format":
      if (issue.format === "regex") return "Invalid";
      if (issue.format === "guid" || issue.format === "uuid") return "Invalid uuid";
      return `Invalid ${issue.format}`;
    case "unrecognized_keys": {
      // zod 3 checked a record's enum keys one by one, so an unknown key read
      // as a bad enum value; zod 4 reports it as an unrecognized key.
      const keyType = (issue.inst as { _zod?: { def?: { keyType?: { options?: unknown[] } } } })
        ?._zod?.def?.keyType;
      if (schemaType(issue) === "record" && keyType?.options)
        return `Invalid enum value. Expected ${quoted(keyType.options)}, received ${quoted(issue.keys)}`;
      return `Unrecognized key(s) in object: ${issue.keys.map((k) => `'${k}'`).join(", ")}`;
    }
    case "invalid_key":
      // zod 3 surfaced the key schema's own issue (e.g. "Invalid" for a regex).
      return issue.issues[0]?.message;
    case "not_multiple_of":
      return `Number must be a multiple of ${String(issue.divisor)}`;
    case "invalid_union":
    case "custom":
      return "Invalid input";
    default:
      return undefined;
  }
}

z.config({ customError: zod3Message });

export { z };
