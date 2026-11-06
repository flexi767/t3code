import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";

export interface RetainedEvent {
  readonly seq: number;
  readonly event: ProviderAdapterV2Event;
}

/** Past this a session can't be replayed, so a restart falls back to normal recovery. */
export const MAX_RETAINED_BYTES = 128 * 1024 * 1024;

function entityKey(event: ProviderAdapterV2Event): string | null {
  switch (event.type) {
    case "provider_session.updated":
      return "session";
    case "provider_thread.updated":
      return `thread:${event.providerThread.id}`;
    case "provider_turn.updated":
      return `turn:${event.providerTurn.id}`;
    case "node.updated":
      return `node:${event.node.id}`;
    case "subagent.updated":
      return `subagent:${event.subagent.id}`;
    case "message.updated":
      return `message:${event.message.id}`;
    case "turn_item.updated":
      return `item:${event.turnItem.id}`;
    case "background_work.updated":
      return `background:${event.providerTurnId}`;
    case "runtime_request.updated":
      return `request:${event.runtimeRequest.id}`;
    case "plan.updated":
      return `plan:${event.plan.id}`;
    default:
      return null;
  }
}

/**
 * What a new server replays to rebuild a run's routing and ingest what it missed. Snapshot events
 * keep only their newest state in first-seen order, so a long turn's streaming text stays bounded.
 */
export class RetainedEvents {
  private readonly entries = new Map<
    string,
    { seq: number; event: ProviderAdapterV2Event; size: number }
  >();
  private bytes = 0;
  ackedSeq = 0;
  truncated = false;

  add(seq: number, event: ProviderAdapterV2Event, size: number): void {
    // Live output is never stored by the server, so it has nothing to replay.
    if (event.type === "command_output.delta") return;
    const key = entityKey(event) ?? `seq:${seq}`;
    const previous = this.entries.get(key);
    this.bytes += size - (previous?.size ?? 0);
    this.entries.set(key, { seq, event, size });
    if (this.bytes > MAX_RETAINED_BYTES) {
      this.truncated = true;
      this.entries.clear();
      this.bytes = 0;
    }
  }

  ack(seq: number): void {
    this.ackedSeq = Math.max(this.ackedSeq, seq);
  }

  /** Called once no consumer remains, so the log starts over and an earlier overflow is forgiven. */
  dropThrough(seq: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.seq <= seq) {
        this.bytes -= entry.size;
        this.entries.delete(key);
      }
    }
    this.truncated = false;
  }

  snapshot(): ReadonlyArray<RetainedEvent> {
    // Map order is first-seen, which a replaying consumer needs: a subagent must precede the terminal.
    return [...this.entries.values()].map(({ seq, event }) => ({ seq, event }));
  }
}

/**
 * An event is acknowledged once every consumer has finished it. Consumers run in parallel over
 * their own queues, so the session's position is the slowest one's.
 */
export class AckTracker {
  private readonly subscribers = new Map<number, number>();
  private published = 0;

  constructor(start = 0) {
    this.published = start;
  }

  add(subscriberId: number): void {
    this.subscribers.set(subscriberId, this.published);
  }

  remove(subscriberId: number): void {
    this.subscribers.delete(subscriberId);
  }

  publish(seq: number): void {
    this.published = Math.max(this.published, seq);
  }

  processed(subscriberId: number, seq: number): void {
    const current = this.subscribers.get(subscriberId);
    if (current !== undefined) this.subscribers.set(subscriberId, Math.max(current, seq));
  }

  position(): number {
    return this.subscribers.size === 0 ? this.published : Math.min(...this.subscribers.values());
  }
}
