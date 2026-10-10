import type { AgentEvent, AgentInteractionRequest } from "@kripl/core";

type RoutedEvent = AgentEvent & { agentId?: number };
type StatusEvent = Extract<AgentEvent, { type: "agent.status" }>;

interface PendingInteraction {
  request: AgentInteractionRequest;
  expiresAt?: number;
}

interface CollectedState {
  status?: StatusEvent;
  pending?: PendingInteraction;
  errorText?: string;
}

interface AttachAgentState {
  status?: StatusEvent;
  interaction?: AgentInteractionRequest;
  errorText?: string;
}

/** Keep only UI control state while a session snapshot is being attached. */
export function createAttachEventCollector(now: () => number = Date.now) {
  const agents = new Map<number, CollectedState>();

  return {
    push(event: RoutedEvent): void {
      if (event.type !== "agent.status" && event.type !== "agent.interaction" &&
          event.type !== "agent.notification") return;
      if (typeof event.agentId !== "number") return;
      if (event.type === "agent.notification" && event.level === "info") return;

      let state = agents.get(event.agentId);
      if (!state) {
        state = {};
        agents.set(event.agentId, state);
      }

      if (event.type === "agent.status") {
        state.status = {
          type: event.type,
          status: event.status,
          ...(event.message !== undefined ? { message: event.message } : {})
        };
        if (event.status !== "running" && event.status !== "stopping") {
          delete state.pending;
        }
        if (event.status === "error") state.errorText = event.message ?? "Pi agent failed.";
        return;
      }

      if (event.type === "agent.interaction") {
        const pending: PendingInteraction = { request: event.request };
        const timeout = event.request.timeoutMs;
        if (timeout !== undefined && Number.isFinite(timeout) && timeout !== 0) {
          // The RPC timer treats zero as disabled and clamps invalid timer
          // delays to 1 ms. Preserve its deadline across repeated reads.
          const delay = timeout < 1 || timeout > 2_147_483_647 ? 1 : Math.trunc(timeout);
          pending.expiresAt = now() + delay;
        }
        state.pending = pending;
        return;
      }

      state.errorText = event.message;
    },

    forAgent(agentId: number): AttachAgentState {
      const state = agents.get(agentId);
      if (!state) return {};
      const pending = state.pending;
      const interaction = pending &&
        (pending.expiresAt === undefined || now() < pending.expiresAt)
        ? pending.request : undefined;
      return {
        ...(state.status ? { status: state.status } : {}),
        ...(interaction ? { interaction } : {}),
        ...(state.errorText !== undefined ? { errorText: state.errorText } : {})
      };
    }
  };
}
