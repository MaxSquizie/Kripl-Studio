import type {
  AgentEvent,
  AgentEventListener,
  AgentInput,
  AgentRuntime,
  AgentStartOptions,
  Unsubscribe
} from "@kripl/core";
import { PiRpcProcess } from "./rpc-process.js";

type JsonRecord = Record<string, unknown>;

function responseError(response: JsonRecord): string | undefined {
  if (response.success === false) {
    return typeof response.error === "string" ? response.error : "Pi RPC request failed.";
  }
  return undefined;
}

export class PiAgentRuntime implements AgentRuntime {
  readonly id = "agent:pi";

  private readonly rpc = new PiRpcProcess();
  private readonly listeners = new Set<AgentEventListener>();
  private unsubscribeRpc?: Unsubscribe;

  async start(options: AgentStartOptions): Promise<void> {
    this.emit({ type: "agent.status", status: "starting" });

    this.rpc.start(options.workspacePath);
    this.unsubscribeRpc = this.rpc.subscribe((event) => {
      this.emit({ type: "agent.raw", source: "pi", payload: event });
    });

    if (options.sessionPath) {
      const response = await this.rpc.send({
        type: "switch_session",
        sessionPath: options.sessionPath
      });
      const error = responseError(response);
      if (error) throw new Error(error);
    }

    this.emit({ type: "agent.status", status: "ready" });
  }

  async send(input: AgentInput): Promise<void> {
    const text = input.text.trim();
    if (!text) return;

    this.emit({ type: "agent.status", status: "running" });

    try {
      const response = await this.rpc.send({ type: "prompt", message: text });
      const error = responseError(response);
      if (error) throw new Error(error);
    } catch (error) {
      this.emit({
        type: "agent.status",
        status: "error",
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.rpc.running) return;
    this.emit({ type: "agent.status", status: "stopping" });

    const response = await this.rpc.send({ type: "abort" });
    const error = responseError(response);
    if (error) throw new Error(error);

    this.emit({ type: "agent.status", status: "ready" });
  }

  subscribe(listener: AgentEventListener): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.unsubscribeRpc?.();
    this.unsubscribeRpc = undefined;
    await this.rpc.dispose();
    this.emit({ type: "agent.status", status: "stopped" });
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
