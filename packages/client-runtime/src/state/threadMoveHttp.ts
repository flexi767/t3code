import type { ThreadId, ThreadMoveImportInput, ThreadMoveReceipt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ManagedRelayDpopSigner from "../relay/managedRelay.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";

const context = Effect.gen(function* () {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared))
    return yield* new EnvironmentRpcUnavailableError({
      environmentId: supervisor.target.environmentId,
      message: "Connect both machines before moving a thread.",
    });
  return {
    prepared: prepared.value,
    signer: yield* Effect.serviceOption(ManagedRelayDpopSigner.ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    ),
  };
});

export const exportThreadMove = Effect.fn("threadMove.export")(function* (payload: {
  readonly threadId: ThreadId;
  readonly transferId: string;
  readonly prepareRepository?: boolean;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...(yield* context),
    group: "threadMove",
    method: "POST",
    url: (urls) => urls.threadMoveExport(),
    timeoutMs: 120_000,
    request: ({ client, headers }) =>
      client.threadMoveExport({ payload, headers: withOrchestrationProtocolHeader(headers) }),
  });
});

export const importThreadMove = Effect.fn("threadMove.import")(function* (
  payload: ThreadMoveImportInput,
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...(yield* context),
    group: "threadMove",
    method: "POST",
    url: (urls) => urls.threadMoveImport(),
    timeoutMs: 120_000,
    request: ({ client, headers }) =>
      client.threadMoveImport({ payload, headers: withOrchestrationProtocolHeader(headers) }),
  });
});

export const finishThreadMove = Effect.fn("threadMove.finish")(function* (
  payload: ThreadMoveReceipt,
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...(yield* context),
    group: "threadMove",
    method: "POST",
    url: (urls) => urls.threadMoveFinish(),
    timeoutMs: 60_000,
    request: ({ client, headers }) =>
      client.threadMoveFinish({ payload, headers: withOrchestrationProtocolHeader(headers) }),
  });
});
