// Official SDK protocol, with explicit persisted-session resume for the desktop lifecycle.
// Pinned against @deepseek-ai/dsh-sdk-jsonrpc-server 0.2.0-rc.2.
import { HarnessSdkJsonRpcServer } from "@deepseek-ai/dsh-sdk-jsonrpc-server";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { SessionPersistenceNotFoundError } from "@deepseek-ai/dsh-session-persistence";
export const name = "xiaoba-companion-rpc";
export const inject = ["agents", "sessionPersistence"];
class CompanionServer extends HarnessSdkJsonRpcServer {
  async createSession(sessionId) {
    const agentOptions = {
      provider: this.provider,
      model: this.model,
      ...(this.maxTokens ? { maxTokens: this.maxTokens } : {}),
      ...(this.reasoningEffort
        ? { reasoningEffort: this.reasoningEffort }
        : {}),
    };
    let handle;
    try {
      handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
      });
    } catch (error) {
      if (!(error instanceof SessionPersistenceNotFoundError)) throw error;
      handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: this.cwd },
        agentOptions,
      });
    }
    const record = { handle };
    this.sessions.set(sessionId, record);
    return record;
  }
}
export function apply(ctx) {
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
  const server = new CompanionServer(ctx, transport);
  transport.onRequest(async (method, params) => {
    if (method === "initialize") await ctx.get("loader")?.await();
    const result = await server.handleRequest(method, params);
    if (method === "shutdown") {
      await ctx.sessionPersistence.flush();
      setImmediate(async () => {
        await transport.flush();
        await ctx.root.fiber.dispose();
        process.exit(0);
      });
    }
    return result;
  });
  ctx.effect(() => {
    transport.start();
    return async () => {
      await server.shutdown();
      transport.close();
    };
  }, "xiaoba.rpc");
}
