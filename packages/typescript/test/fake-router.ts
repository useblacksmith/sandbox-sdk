import { createConnection, createServer, type Server, type Socket } from "node:net";

/**
 * Stands in for a host's sandbox-router that does not own the sandbox: the
 * first `strand` connections are held for `holdMs` and then closed without a
 * byte (what a stale DNS answer gets); later ones are spliced to the agent.
 */
export class FakeRouter {
  private server: Server | undefined;
  private seen = 0;
  url = "";

  constructor(
    agentUrl: string,
    readonly strand: number,
    readonly holdMs = 20,
  ) {
    this.agentPort = Number(new URL(agentUrl).port);
  }

  private readonly agentPort: number;

  async start(): Promise<this> {
    this.server = createServer((client) => this.route(client));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    this.url = `http://127.0.0.1:${address.port}/v1`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server?.close(() => resolve()));
  }

  private route(client: Socket): void {
    if (this.seen++ < this.strand) {
      client.pause();
      setTimeout(() => client.destroy(), this.holdMs);
      return;
    }
    const agent = createConnection({ host: "127.0.0.1", port: this.agentPort });
    client.pipe(agent).pipe(client);
    client.on("error", () => agent.destroy());
    agent.on("error", () => client.destroy());
  }
}
