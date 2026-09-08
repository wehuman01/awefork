import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createOpencodeClient, OpencodeApiError } from "../src/shared/opencode-client";

/** Fake endpoints for the timeout behavior only; full API semantics live in
 *  opencode-adapter.test.ts. */
let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  servers = [];
});

function listen(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe("request timeouts", () => {
  it("fails a wedged request with a clear timeout error instead of hanging forever", async () => {
    // Never responds: a half-dead opencode process.
    const baseUrl = await listen(() => {});
    const client = createOpencodeClient(baseUrl, { timeoutMs: 100 });

    const error: unknown = await client.listSessions().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpencodeApiError);
    expect((error as OpencodeApiError).message).toMatch(/timed out after 100ms/);
  });

  it("leaves the prompt endpoint untimed — its response arrives when the run finishes", async () => {
    const baseUrl = await listen((req, res) => {
      if (req.method === "POST" && req.url?.includes("/message")) {
        setTimeout(() => {
          res.writeHead(204);
          res.end();
        }, 150);
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
    const client = createOpencodeClient(baseUrl, { timeoutMs: 50 });

    await expect(client.prompt("s1", "hello")).resolves.toBeUndefined();
  });
});
