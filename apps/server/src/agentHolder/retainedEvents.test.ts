import { assert, it } from "@effect/vitest";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";

import { AckTracker, MAX_RETAINED_BYTES, RetainedEvents } from "./retainedEvents.ts";

const item = (id: string, text: string) =>
  ({ type: "turn_item.updated", turnItem: { id, text } }) as unknown as ProviderAdapterV2Event;
const terminal = { type: "turn.terminal" } as unknown as ProviderAdapterV2Event;

it("keeps each entity's newest state in first-seen order and every terminal event", () => {
  const events = new RetainedEvents();
  events.add(1, item("a", "first"), 10);
  events.add(2, item("b", "other"), 10);
  events.add(3, item("a", "newest"), 10);
  events.add(4, terminal, 10);
  events.add(5, terminal, 10);
  events.add(6, { type: "command_output.delta" } as unknown as ProviderAdapterV2Event, 10);
  assert.deepStrictEqual(
    events.snapshot().map(({ seq }) => seq),
    [3, 2, 4, 5],
  );
});

it("marks the log unreplayable once a session passes the limit", () => {
  const events = new RetainedEvents();
  events.add(1, item("a", "large"), MAX_RETAINED_BYTES);
  assert.isFalse(events.truncated);
  events.add(2, item("b", "over"), 1);
  assert.isTrue(events.truncated);
  assert.lengthOf(events.snapshot(), 0);
  events.dropThrough(2);
  assert.isFalse(events.truncated);
});

it("drops a settled turn's events without forgetting later ones", () => {
  const events = new RetainedEvents();
  events.add(1, item("a", "settled"), 10);
  events.add(2, terminal, 10);
  events.add(3, item("b", "next"), 10);
  events.dropThrough(2);
  assert.deepStrictEqual(
    events.snapshot().map(({ seq }) => seq),
    [3],
  );
});

it("acknowledges only what the slowest consumer finished", () => {
  const tracker = new AckTracker(5);
  assert.equal(tracker.position(), 5);
  tracker.publish(7);
  assert.equal(tracker.position(), 7);
  tracker.add(1);
  tracker.add(2);
  tracker.publish(9);
  tracker.processed(1, 9);
  assert.equal(tracker.position(), 7);
  tracker.processed(2, 8);
  assert.equal(tracker.position(), 8);
  tracker.remove(2);
  assert.equal(tracker.position(), 9);
});
