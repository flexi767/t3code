import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { decodeLine, encodeLine } from "./wire.ts";

it("round-trips the domain values session calls carry", () => {
  const at = DateTime.makeUnsafe("2026-11-06T10:00:00.000Z");
  const decoded = decodeLine(
    encodeLine({
      at,
      nested: [{ when: at, some: Option.some(1), none: Option.none() }],
      capabilities: new Set(["preview"]),
      byThread: new Map([["t", at]]),
      toolInput: { $date: "not a date", $set: 1, $dt: "nope", $$odd: true },
      absent: undefined,
      callback: () => 1,
    }),
  ) as Record<string, any>;
  assert.isTrue(DateTime.isDateTime(decoded.at));
  assert.equal(DateTime.formatIso(decoded.at), "2026-11-06T10:00:00.000Z");
  assert.isTrue(DateTime.isDateTime(decoded.nested[0].when));
  assert.deepStrictEqual(decoded.nested[0].some, Option.some(1));
  assert.isTrue(Option.isNone(decoded.nested[0].none));
  assert.isTrue(decoded.capabilities.has("preview"));
  assert.isTrue(DateTime.isDateTime(decoded.byThread.get("t")));
  assert.deepStrictEqual(decoded.toolInput, {
    $date: "not a date",
    $set: 1,
    $dt: "nope",
    $$odd: true,
  });
  assert.notProperty(decoded, "absent");
  assert.notProperty(decoded, "callback");
});
