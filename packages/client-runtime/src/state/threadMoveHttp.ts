import {
  ThreadMoveError,
  type ThreadId,
  type ThreadMoveImportInput,
  type ThreadMoveReceipt,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ManagedRelayDpopSigner from "../relay/managedRelay.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";
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

const isThreadMoveError = Schema.is(ThreadMoveError);
const isRemoteEnvironmentAuthFetchError = Schema.is(RemoteEnvironmentAuthFetchError);

/** The shared request mapper only knows common errors; a move's refusal must keep its message. */
export const surfaceThreadMoveRefusal = <A, E, R>(
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ThreadMoveError, R> =>
  request.pipe(
    Effect.mapError((error) =>
      isRemoteEnvironmentAuthFetchError(error) && isThreadMoveError(error.cause)
        ? error.cause
        : error,
    ),
  );

export const exportThreadMove = Effect.fn("threadMove.export")(function* (payload: {
  readonly threadId: ThreadId;
  readonly transferId: string;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...(yield* context),
    group: "threadMove",
    method: "POST",
    url: (urls) => urls.threadMoveExport(),
    timeoutMs: 120_000,
    request: ({ client, headers }) =>
      client.threadMoveExport({ payload, headers: withOrchestrationProtocolHeader(headers) }),
  }).pipe(surfaceThreadMoveRefusal);
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
  }).pipe(surfaceThreadMoveRefusal);
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
  }).pipe(surfaceThreadMoveRefusal);
});
