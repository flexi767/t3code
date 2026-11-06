// @effect-diagnostics nodeBuiltinImport:off - A real HTTP upstream is what this proxy forwards to.
// @effect-diagnostics globalFetch:off
import * as NodeHttp from "node:http";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { startMcpHoldingProxy } from "./mcpHoldingProxy.ts";

const post = (endpoint: string, body: unknown, sessionId?: string) =>
  fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    },
    body: JSON.stringify(body),
  });

// Mirrors the server's own MCP refusal: a restart forgets every session, and an unknown one gets 404.
const makeUpstream = (port = 0) =>
  new Promise<{
    readonly server: NodeHttp.Server;
    readonly port: number;
    readonly sessions: Set<string>;
    readonly methods: string[];
  }>((resolve) => {
    const sessions = new Set<string>();
    const methods: string[] = [];
    let next = 0;
    const server = NodeHttp.createServer((request, response) => {
      let text = "";
      request.on("data", (chunk) => (text += chunk));
      request.on("end", () => {
        const message = JSON.parse(text) as { method: string };
        methods.push(message.method);
        const sessionId = request.headers["mcp-session-id"];
        if (message.method === "initialize") {
          const id = `upstream-${port}-${next++}`;
          sessions.add(id);
          response.writeHead(200, { "mcp-session-id": id });
          response.end("{}");
          return;
        }
        if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ result: message.method }));
      });
    });
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({ server, port: address.port, sessions, methods });
    });
  });

const stop = (server: NodeHttp.Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

it.live("holds a call through an outage and re-creates the forgotten session", () =>
  Effect.promise(async () => {
    const first = await makeUpstream();
    const proxy = await startMcpHoldingProxy(`http://127.0.0.1:${first.port}/mcp`);
    try {
      const initialized = await post(proxy.endpoint, { method: "initialize" });
      const sessionId = initialized.headers.get("mcp-session-id")!;
      assert.equal((await post(proxy.endpoint, { method: "first" }, sessionId)).status, 200);
      await stop(first.server);

      const held = post(proxy.endpoint, { method: "during-outage" }, sessionId);
      const second = await makeUpstream(first.port);
      const response = await held;
      assert.equal(response.status, 200);
      assert.deepStrictEqual(await response.json(), { result: "during-outage" });
      assert.deepStrictEqual(second.methods, [
        "during-outage",
        "initialize",
        "notifications/initialized",
        "during-outage",
      ]);
      await stop(second.server);
    } finally {
      proxy.close();
    }
  }),
);

it.live("reports a cut response instead of repeating a call the server may have run", () =>
  Effect.promise(async () => {
    let calls = 0;
    const upstream = NodeHttp.createServer((request) => {
      calls += 1;
      request.socket.destroy();
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const { port } = upstream.address() as { port: number };
    const proxy = await startMcpHoldingProxy(`http://127.0.0.1:${port}/mcp`);
    try {
      await post(proxy.endpoint, { method: "tools/call" }).then(
        () => assert.fail("expected the call to fail"),
        () => undefined,
      );
      assert.equal(calls, 1);
    } finally {
      proxy.close();
      await stop(upstream);
    }
  }),
);
