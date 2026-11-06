// @effect-diagnostics nodeBuiltinImport:off - This standalone proxy must outlive the server it forwards to.
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import * as NodeHttp from "node:http";

const HOLD_RETRY_MS = 500;
const MAX_HOLD_MS = 5 * 60 * 1000;

interface SessionRoute {
  upstreamSessionId: string;
  readonly initializeBody: Buffer;
  readonly authorization: string | undefined;
}

export interface McpHoldingProxy {
  readonly endpoint: string;
  readonly setUpstream: (endpoint: string) => void;
  readonly close: () => void;
}

interface UpstreamResponse {
  readonly status: number;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly stream: NodeHttp.IncomingMessage;
}

const isConnectionRefused = (error: unknown) => {
  const code = (error as { readonly code?: unknown }).code;
  return code === "ECONNREFUSED" || code === "ENOTFOUND";
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const readAll = (stream: NodeJS.ReadableStream) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });

/**
 * Gives agents an MCP endpoint that outlives the server. Real CLIs fail a call made while the
 * server is down and stay disconnected, so a request the server never received waits for it, and a
 * session the restarted server forgot is re-created. A cut response can't be retried: the server
 * may have run the tool, so that call fails and the agent decides.
 */
export const startMcpHoldingProxy = (initialUpstream: string): Promise<McpHoldingProxy> => {
  let upstream = new URL(initialUpstream);
  const routes = new Map<string, SessionRoute>();

  const send = (
    method: string,
    headers: NodeHttp.OutgoingHttpHeaders,
    body: Buffer,
    signal: AbortSignal,
  ) =>
    new Promise<UpstreamResponse>((resolve, reject) => {
      const request = NodeHttp.request(
        upstream,
        { method, headers: { ...headers, host: upstream.host }, signal },
        (stream) => resolve({ status: stream.statusCode ?? 502, headers: stream.headers, stream }),
      );
      request.on("error", reject);
      request.end(body);
    });

  /** Only refused connections and an auth store still repopulating are safe to repeat. */
  const sendHeld = async (
    method: string,
    headers: NodeHttp.OutgoingHttpHeaders,
    body: Buffer,
    signal: AbortSignal,
  ): Promise<UpstreamResponse> => {
    const deadline = Date.now() + MAX_HOLD_MS;
    for (;;) {
      try {
        const response = await send(method, headers, body, signal);
        if (response.status !== 401 || Date.now() >= deadline) return response;
        response.stream.resume();
      } catch (error) {
        if (!isConnectionRefused(error) || Date.now() >= deadline) throw error;
      }
      await delay(HOLD_RETRY_MS);
    }
  };

  const reinitialize = async (route: SessionRoute, signal: AbortSignal) => {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(route.authorization === undefined ? {} : { authorization: route.authorization }),
    };
    const initialized = await sendHeld("POST", headers, route.initializeBody, signal);
    await readAll(initialized.stream);
    const sessionId = initialized.headers["mcp-session-id"];
    if (typeof sessionId !== "string") return false;
    route.upstreamSessionId = sessionId;
    const notified = await sendHeld(
      "POST",
      { ...headers, "mcp-session-id": sessionId },
      Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })),
      signal,
    );
    notified.stream.resume();
    return true;
  };

  const server = NodeHttp.createServer((request, response) => {
    const abort = new AbortController();
    response.on("close", () => abort.abort());
    void (async () => {
      const body = await readAll(request);
      const clientSessionId = request.headers["mcp-session-id"];
      const route = typeof clientSessionId === "string" ? routes.get(clientSessionId) : undefined;
      const headers = (): NodeHttp.OutgoingHttpHeaders => ({
        ...request.headers,
        ...(route === undefined ? {} : { "mcp-session-id": route.upstreamSessionId }),
      });
      let upstreamResponse = await sendHeld(
        request.method ?? "POST",
        headers(),
        body,
        abort.signal,
      );
      if (upstreamResponse.status === 404 && route !== undefined) {
        upstreamResponse.stream.resume();
        if (await reinitialize(route, abort.signal)) {
          upstreamResponse = await sendHeld(
            request.method ?? "POST",
            headers(),
            body,
            abort.signal,
          );
        }
      }
      const issued = upstreamResponse.headers["mcp-session-id"];
      if (route === undefined && typeof issued === "string") {
        routes.set(issued, {
          upstreamSessionId: issued,
          initializeBody: body,
          authorization: request.headers.authorization,
        });
      }
      // The agent keeps the first session id; only the proxy sees later ones.
      const replyHeaders = {
        ...upstreamResponse.headers,
        ...(typeof clientSessionId === "string" && issued !== undefined
          ? { "mcp-session-id": clientSessionId }
          : {}),
      };
      response.writeHead(upstreamResponse.status, replyHeaders);
      upstreamResponse.stream.pipe(response);
      upstreamResponse.stream.on("error", () => response.destroy());
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.destroy();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("MCP holding proxy has no port."));
        return;
      }
      resolve({
        endpoint: `http://127.0.0.1:${address.port}/mcp`,
        setUpstream: (endpoint) => {
          upstream = new URL(endpoint);
        },
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
};
