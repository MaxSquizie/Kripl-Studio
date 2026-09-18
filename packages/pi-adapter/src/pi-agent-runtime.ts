import type {
  AgentEvent,
  AgentEventListener,
  AgentInput,
  AgentInteractionResponse,
  AgentRuntime,
  AgentSessionSnapshot,
  AgentStartOptions,
  NetworkMode,
  PermissionPolicy,
  ToolBridgeConnection,
  Unsubscribe
} from "@kripl/core";
import { DEFAULT_PERMISSION_POLICY } from "@kripl/permissions";
import { normalizePiEvent } from "./pi-event-normalizer.js";
import {
  KRIPL_PI_PROVIDER,
  type PiLocalModelConfig,
  writePiLocalModelConfig
} from "./pi-local-config.js";
import { writePiBrowserTools } from "./pi-browser-tools.js";
import { writePiPermissionGate } from "./pi-permission-gate.js";
import { writePiWebTools } from "./pi-web-tools.js";
import { PiRpcProcess } from "./rpc-process.js";
import { normalizePiSessionMessages } from "./pi-session-normalizer.js";

type JsonRecord = Record<string, unknown>;

export interface PiAgentRuntimeOptions {
  agentDir: string;
  sessionDir?: string;
  localModel: PiLocalModelConfig;
  networkMode?: NetworkMode;
  permissionPolicy?: PermissionPolicy;
  toolBridge?: ToolBridgeConnection;
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

function responseData(response: JsonRecord): JsonRecord {
  assertSuccess(response);
  if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) {
    throw new Error("Pi RPC response is missing data.");
  }
  return response.data as JsonRecord;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export class PiAgentRuntime implements AgentRuntime {
  readonly id = "agent:pi";

  private readonly rpc = new PiRpcProcess();
  private readonly listeners = new Set<AgentEventListener>();
  private unsubscribeRpc: Unsubscribe | undefined;

  constructor(private readonly options: PiAgentRuntimeOptions) {}

  async start(options: AgentStartOptions): Promise<void> {
    this.emit({ type: "agent.status", status: "starting" });

    try {
      const networkMode = this.options.networkMode ?? "online";
      await Promise.all([
        writePiLocalModelConfig(this.options.agentDir, this.options.localModel),
        writePiPermissionGate(
          this.options.agentDir,
          this.options.permissionPolicy ?? DEFAULT_PERMISSION_POLICY
        ),
        writePiWebTools(this.options.agentDir, networkMode),
        writePiBrowserTools(this.options.agentDir)
      ]);

      this.unsubscribeRpc = this.rpc.subscribe((event) => {
        this.emit({ type: "agent.raw", source: "pi", payload: event });
        for (const normalized of normalizePiEvent(event)) {
          this.emit(normalized);
        }
      });

      const rpcOptions = {
        agentDir: this.options.agentDir,
        ...(this.options.sessionDir ? { sessionDir: this.options.sessionDir } : {}),
        ...(this.options.networkMode ? { networkMode: this.options.networkMode } : {}),
        ...(this.options.toolBridge ? { toolBridge: this.options.toolBridge } : {})
      };

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

  async respondToInteraction(response: AgentInteractionResponse): Promise<void> {
    if (!response.id) throw new Error("Agent interaction response id is required.");

    await this.rpc.sendOneWay({
      type: "extension_ui_response",
      id: response.id,
      ...(typeof response.confirmed === "boolean" ? { confirmed: response.confirmed } : {}),
      ...(typeof response.value === "string" ? { value: response.value } : {}),
      ...(response.cancelled === true ? { cancelled: true } : {})
    });
  }

  async getSessionSnapshot(): Promise<AgentSessionSnapshot> {
    const [stateResponse, messagesResponse] = await Promise.all([
      this.rpc.send({ type: "get_state" }),
      this.rpc.send({ type: "get_messages" })
    ]);

    const state = responseData(stateResponse);
    const messagesData = responseData(messagesResponse);
    const sessionId = optionalString(state.sessionId);
    if (!sessionId) {
      throw new Error("Pi session state is missing sessionId.");
    }

    const messageCount =
      typeof state.messageCount === "number" && Number.isFinite(state.messageCount)
        ? Math.max(0, Math.floor(state.messageCount))
        : 0;

    return {
      ...(optionalString(state.sessionFile) ? { sessionFile: optionalString(state.sessionFile) } : {}),
      sessionId,
      ...(optionalString(state.sessionName) ? { sessionName: optionalString(state.sessionName) } : {}),
      messageCount,
      messages: normalizePiSessionMessages(messagesData.messages)
    };
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
