import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The in-page serializer used by runPageScript, loaded from the shipped
 * extension file so this cannot drift from what actually runs.
 */

const sharedJsPath = path.resolve(
  fileURLToPath(new URL("../../../chrome-extension/shared.js", import.meta.url))
);

let serialize: (value: unknown) => unknown;

beforeAll(() => {
  const source = fs.readFileSync(sharedJsPath, "utf8");
  const extract = new Function(`${source}\nreturn { PAGE_VALUE_SERIALIZE };`) as () => {
    PAGE_VALUE_SERIALIZE: string;
  };
  const { PAGE_VALUE_SERIALIZE } = extract();
  expect(PAGE_VALUE_SERIALIZE).toContain("serializeBtmcpValue");
  serialize = new Function(`return (${PAGE_VALUE_SERIALIZE});`)() as typeof serialize;
});

describe("PAGE_VALUE_SERIALIZE", () => {
  it("passes JSON-safe primitives through", () => {
    expect(serialize(null)).toBe(null);
    expect(serialize(true)).toBe(true);
    expect(serialize(3)).toBe(3);
    expect(serialize("hello")).toBe("hello");
  });

  it("tags values that JSON would drop or misrepresent", () => {
    expect(serialize(undefined)).toEqual({ __type: "undefined" });
    expect(serialize(() => {})).toEqual({ __type: "function", name: "" });
    function named() {}
    expect(serialize(named)).toEqual({ __type: "function", name: "named" });
  });

  it("breaks circular references instead of throwing", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(serialize(cycle)).toEqual({ self: "[Circular]" });
  });

  it("caps a long string in-page without cutting the whole payload", () => {
    const long = "x".repeat(60_000);
    const out = serialize(long);
    expect(typeof out).toBe("string");
    expect((out as string).length).toBe(50_000);
  });
});
