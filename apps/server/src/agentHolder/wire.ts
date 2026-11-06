// @effect-diagnostics globalDate:off - Provider SDK payloads can carry native dates.
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/** Refuses a holder from an incompatible build; its sessions then take the normal recovery path. */
export const AGENT_HOLDER_PROTOCOL = 1;

/**
 * Session calls carry domain values whose schemas differ per method, and a holder from an older
 * build must keep decoding what a newer server sends. Encoding by value kind stays additive.
 */
export function toWire(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (DateTime.isDateTime(value)) return { $dt: DateTime.formatIso(value) };
  if (Option.isOption(value)) {
    return Option.isSome(value) ? { $some: toWire(value.value) } : { $none: true };
  }
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Set) return { $set: [...value].map(toWire) };
  if (value instanceof Map) {
    return { $map: [...value].map(([key, entry]) => [toWire(key), toWire(entry)]) };
  }
  if (Array.isArray(value)) return value.map(toWire);
  const encoded: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    // Tool input is free-form, so a user key mustn't read as one of the markers above.
    if (entry !== undefined && typeof entry !== "function") {
      encoded[key.startsWith("$") ? `$${key}` : key] = toWire(entry);
    }
  }
  return encoded;
}

export function fromWire(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(fromWire);
  const record = value as Record<string, unknown>;
  if (typeof record.$dt === "string") return DateTime.makeUnsafe(record.$dt);
  if ("$some" in record) return Option.some(fromWire(record.$some));
  if (record.$none === true) return Option.none();
  if (typeof record.$date === "string") return new Date(record.$date);
  if (Array.isArray(record.$set)) return new Set(record.$set.map(fromWire));
  if (Array.isArray(record.$map)) {
    return new Map(
      (record.$map as ReadonlyArray<readonly [unknown, unknown]>).map(([key, entry]) => [
        fromWire(key),
        fromWire(entry),
      ]),
    );
  }
  const decoded: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    decoded[key.startsWith("$$") ? key.slice(1) : key] = fromWire(entry);
  }
  return decoded;
}

export const encodeLine = (message: unknown): string => `${JSON.stringify(toWire(message))}\n`;
export const decodeLine = (line: string): unknown => fromWire(JSON.parse(line));
