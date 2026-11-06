import type {
  OrchestrationV2ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";

import type { RetainedEvent } from "./retainedEvents.ts";

/** Everything a server needs to build a proxy for a session that already runs in a holder. */
export interface HeldSessionDescriptor {
  readonly providerSessionId: ProviderSessionId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly providerSession: OrchestrationV2ProviderSession;
  /** Optional runtime members carry meaning, so absence has to survive the socket. */
  readonly methods: ReadonlyArray<string>;
  readonly mcpAppMethods: boolean;
  readonly backgroundTasksEndWithProcess: boolean;
}

export interface HeldSessionSnapshot {
  readonly descriptor: HeldSessionDescriptor;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly mcpConfigs: ReadonlyArray<McpProviderSessionConfig>;
  readonly lastSeq: number;
  readonly ackedSeq: number;
  readonly truncated: boolean;
  readonly retained: ReadonlyArray<RetainedEvent>;
  readonly ended: boolean;
}

export interface HolderHello {
  readonly protocol: number;
  readonly pid: number;
  readonly version: string;
  readonly sessions: ReadonlyArray<HeldSessionSnapshot>;
}

export interface HolderRegistration {
  readonly pid: number;
  readonly version: string;
  readonly socket: string;
  readonly protocol: number;
  readonly threadIds: ReadonlyArray<string>;
}

/** Runtime methods forwarded by name; a holder reports which of these its adapter implements. */
export const FORWARDED_RUNTIME_METHODS = [
  "ensureThread",
  "resumeThread",
  "injectHistory",
  "startTurn",
  "compactThread",
  "steerTurn",
  "stopTask",
  "awaitBackgroundTasks",
  "interruptTurn",
  "stopSubagent",
  "unloadThread",
  "respondToRuntimeRequest",
  "readThreadSnapshot",
  "uploadFeedback",
  "rollbackThread",
  "forkThread",
  "hasPendingBackgroundWorkForThread",
] as const;

export type ForwardedRuntimeMethod = (typeof FORWARDED_RUNTIME_METHODS)[number];

export const REGISTRATION_DIRECTORY = "agent-holders";
