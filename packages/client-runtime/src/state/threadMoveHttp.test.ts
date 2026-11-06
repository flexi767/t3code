import { ThreadMoveError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { assert, it } from "@effect/vitest";

import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";
import { surfaceThreadMoveRefusal } from "./threadMoveHttp.ts";

it.effect("keeps a move refusal's own message and leaves other failures alone", () =>
  Effect.gen(function* () {
    const refusal = new ThreadMoveError({ message: "Push its branch first, then retry." });
    const surfaced = yield* surfaceThreadMoveRefusal(
      Effect.fail(new RemoteEnvironmentAuthFetchError({ message: "Failed", cause: refusal })),
    ).pipe(Effect.flip);
    assert.strictEqual(surfaced, refusal);
    const network = new RemoteEnvironmentAuthFetchError({ message: "Failed", cause: "offline" });
    assert.strictEqual(
      yield* surfaceThreadMoveRefusal(Effect.fail(network)).pipe(Effect.flip),
      network,
    );
  }),
);
