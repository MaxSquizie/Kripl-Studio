import type {
  AgentEvent,
  AgentEventListener,
  AgentInput,
  AgentRuntime,
  AgentStartOptions,
  Unsubscribe
} from "@kripl/core";
import { normalizePiEvent } from "./pi-event-normalizer.js";
import {
  KRIPL_PI_PROVIDER,
  type PiLocalModelConfig,
  writePiLocalModelConfig
} from "./pi-local-config.js";
import { PiRpcProcess } from "./rpc-process.js";

type JsonRecord = Record<string, unknown>;

export interface PiAgentRuntimeOptions {
  agentDir: string;
  sessionDir?: string;
  localModel: PiLocalModelConfig;
}

function responseError(response: JsonRecord): string | undefined {
  if (response.success === false) {
    return typeof response.error === "string" ? response.error : "Pi RPC request failed.";
  }
  return undefined;
}

function assertSuccess(response: JsonRecord): void {
  const error = responseError(response);
  if (error) throw new Error(error);
}

export class PiAgentRuntime implements AgentRuntime {
  readonly id = "agent:pi";

  private readonly rpc = new PiRpcProcess();
  private readonly listeners = new Set<AgentEventListener>();
  private unsubscribeRpc?: Unsubscribe;

  constructor(private readonly options: PiAgentRuntimeOptions) {}

  async start(options: AgentStartOptions): Promise<void> {
    this.emit({ type: "agent.status", status: "starting" });

    try {
      await writePiLocalModelConfig(this.options.agentDir, this.options.localModel);

      this.unsubscribeRpc = this.rpc.subscribe((event) => {
        this.emit({ type: "agent.raw", source: "pi", payload: event });
        for (const normalized of normalizePiEvent(event)) {
          this.emit(normalized);
        }
      });

      const rpcOptions = this.options.sessionDir
        ? { agentDir: this.options.agentDir, sessionDir: this.options.sessionDir }
        : { agentDir: this.options.agentDir };

      this.rpc.start(options.workspacePath, rpcOptions);

      if (options.sessionPath) {
        const response = await this.rpc.send({
          type: "switch_session",
          sessionPath: options.sessionPath
        });
        assertSuccess(response);
      }

      assertSuccess(
        await this.rpc.send({
          type: "set_model",
          provider: KRIPL_PI_PROVIDER,
          modelId: this.options.localModel.modelId
        })
      );

      assertSuccess(await this.rpc.send({ type: "set_auto_retry", enabled: false }));

      const state = await this.rpc.send({ type: "get_state" });
      assertSuccess(state);

      this.emit({ type: "agent.status", status: "ready" });
    } catch (error) {
      this.emit({
        type: "agent.status",
        status: "error",
        message: error instanceof Error ? error.message : String(error)
      });
      await this.rpc.dispose();
      throw error;
    }
  }

  async send(input: AgentInput): Promise<void> {
    const text = input.text.trim();
    if (!text) return;

    try {
      const response = await this.rpc.send({ type: "prompt", message: text });
      assertSuccess(response);
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
    assertSuccess(response);

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
