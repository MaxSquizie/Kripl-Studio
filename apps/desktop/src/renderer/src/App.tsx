import type { AgentEvent, AttachedFile, AgentInteractionRequest, AgentInteractionResponse, AgentSessionSnapshot, AgentSessionSummary, AgentStatus, ContextInspectorSnapshot, DesktopRuntimeSettings, DesktopUiState, RecentProject, WorkspaceChange, WorkspaceCommitResult, WorkspaceDescriptor, WorkspaceEntry, WorkspaceFilePreview, WorkspaceGitStatus } from "@kripl/core";
import { cleanAssistantToolText } from "@kripl/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent } from "react";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { WorkspaceContent, activeWorkspacePath, type WorkspaceDocumentView, type WorkspaceEditorRevealTarget, type WorkspaceView } from "./WorkspaceContent";
import { WorkspaceTabs, upsertWorkspaceTab, workspaceViewKey } from "./WorkspaceTabs";
import { TerminalPanel } from "./TerminalPanel";
import { ContextInspectorCard } from "./ContextInspectorCard";
import kriplIcon from "./assets/kripl-icon.png";
import { GitStatusCard } from "./GitStatusCard";
import { CollapsibleDetails } from "./CollapsibleDetails";
import { AgentPermissionsCard } from "./AgentPermissionsCard";
import { ModelTuningCard } from "./ModelTuningCard";
import { RecentProjectsCard } from "./RecentProjectsCard";
import kriplCodingGif from "./assets/kripl-coding.gif";
import { Markdown, CopyIconButton } from "./Markdown";
import { WorkspaceSearchPalette, type WorkspaceSearchMode } from "./WorkspaceSearchPalette";

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

function readStored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable — persistence is best-effort.
  }
}

function buildMessageWithAttachments(text: string, files: AttachedFile[]): string {
  const usable = files.filter((file) => !file.error);
  if (usable.length === 0) return text;

  const lines: string[] = ["[Attached files]"];
  for (const file of usable) {
    lines.push(`- ${file.name} (${formatBytes(file.sizeBytes)}, ${file.kind}) — ${file.path}`);
  }
  for (
    const file of usable.filter(
      (item): item is AttachedFile & { preview: string } => item.preview !== undefined
    )
  ) {
    lines.push("", `Content of ${file.name}:`, "```", file.preview, "```");
  }

  const block = lines.join("\n");
  return text ? `${block}\n\n${text}` : block;
}

interface AppInfo {
  name: string;
  version: string;
  platform: string;
  networkMode: "online" | "restricted" | "offline";
  modelRouting: "local-only" | "allow-remote";
}

interface LocalModel {
  provider: string;
  id: string;
  name: string;
  local: boolean;
  contextWindow?: number;
}

type MessageRole = "user" | "assistant" | "system";

/** One ordered step of the agent's work: a reasoning text or a tool call. */
type ReasoningStep =
  | { kind: "thinking"; text: string }
  | { kind: "tool"; tool: ToolItem };

/** Collapsed activity folded into an answer bubble, in the order it happened:
 *  reasoning text → tool call → reasoning text → … */
interface ReasoningBlock {
  steps: ReasoningStep[];
  /** Wall-clock time the agent spent on this activity, if measured. */
  durationMs?: number;
}

interface MessageItem {
  kind: "message";
  id: string;
  role: MessageRole;
  text: string;
  /** Data URLs of attached images, rendered inline in the chat. */
  images?: string[];
  reasoning?: ReasoningBlock;
  /** Generation speed restored from storage after an app restart. */
  tokps?: number;
}

interface ToolItem {
  kind: "tool";
  callId: string;
  name: string;
  phase: "started" | "updated" | "completed" | "failed";
  payload?: unknown;
}

type FeedItem = MessageItem | ToolItem;

interface AgentBinding {
  workspacePath: string;
  endpoint: string;
  modelId: string;
  sessionPath: string;
}

type ProbeState =
  | { status: "idle"; models: LocalModel[] }
  | { status: "checking"; models: LocalModel[] }
  | { status: "ready"; models: LocalModel[] }
  | { status: "error"; models: LocalModel[]; message: string };

const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:1234/v1";

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

const DEFAULT_CONTEXT_WINDOW = 32_768;

// Slim ring (not a filled circle) showing how much of the model's context
// window is used. Hovering reveals exact used/remaining token counts.
// When the server does not report a limit, the arc stays neutral and the
// tooltip says so instead of pretending to know the window size.
function TokenRing({ used, limit }: { used: number; limit?: number | undefined }) {
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  const fraction = limit ? Math.min(1, used / limit) : 0;
  const remaining = limit ? Math.max(0, limit - used) : undefined;

  return (
    <div className="token-ring">
      <svg width={40} height={40} viewBox="0 0 40 40" aria-hidden="true">
        <circle cx={20} cy={20} r={radius} className="token-ring-track" />
        <circle
          cx={20}
          cy={20}
          r={radius}
          className={
            "token-ring-arc" +
            (limit === undefined
              ? " unknown"
              : fraction >= 1
                ? " full"
                : "")
          }
          strokeDasharray={`${circumference * fraction} ${circumference}`}
          transform="rotate(-90 20 20)"
        />
      </svg>
      <div className="token-ring-tooltip" role="tooltip">
        <span>{formatTokens(used)} used</span>
        {limit === undefined ? (
          <span>context limit not reported by server</span>
        ) : (
          <span>{formatTokens(remaining!)} left of {formatTokens(limit)}</span>
        )}
      </div>
    </div>
  );
}

/** Stopwatch for the collapsed reasoning block: “3м 12с” or just “45с”. */
function formatReasoningDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}м ${seconds}с` : `${seconds}с`;
}

function payloadPreview(payload: unknown): string {
  if (payload === undefined) return "";
  try {
    const serialized = JSON.stringify(payload, null, 2);
    if (typeof serialized !== "string") return String(payload);
    return serialized.length > 1800 ? `${serialized.slice(0, 1800)}\n…` : serialized;
  } catch {
    return String(payload);
  }
}

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceDescriptor | null>(null);
  const [workspaceEntries, setWorkspaceEntries] = useState<Record<string, WorkspaceEntry[]>>({});
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const [workspaceChanges, setWorkspaceChanges] = useState<WorkspaceChange[]>([]);
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatus | null>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>({ type: "agent" });
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceDocumentView[]>([]);
  const [editorDrafts, setEditorDrafts] = useState<Record<string, string>>({});
  const [editorRevealTarget, setEditorRevealTarget] = useState<WorkspaceEditorRevealTarget | undefined>(undefined);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<DesktopRuntimeSettings | null>(null);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [contextSnapshot, setContextSnapshot] = useState<ContextInspectorSnapshot | null>(null);
  const [endpoint, setEndpoint] = useState(() => readStored("kripl.localEndpoint", DEFAULT_LOCAL_ENDPOINT));
  const [probe, setProbe] = useState<ProbeState>({ status: "idle", models: [] });
  const [selectedModel, setSelectedModel] = useState(() => readStored("kripl.selectedModel", ""));
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("idle");
  const [agentError, setAgentError] = useState("");
  const [binding, setBinding] = useState<AgentBinding | null>(null);
  const [composerText, setComposerText] = useState("");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  // path -> data URL preview (images and PDFs) for the composer chips
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
  const [pdfPreviewPath, setPdfPreviewPath] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [usage, setUsage] = useState<{ input?: number; output?: number; cacheRead?: number } | null>(null);
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);

  const [windowMaximized, setWindowMaximized] = useState(false);
  const [contextWindowOverride, setContextWindowOverride] = useState(() => {
    const raw = readStored("kripl.contextWindow", "");
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  });
  const [feed, setFeed] = useState<FeedItem[]>([]);
  // Live reasoning timeline (text + tool calls in order) shown while the agent
  // is still working; folded into the answer bubble once it appears.
  const [liveSteps, setLiveSteps] = useState<ReasoningStep[] | null>(null);
  const [interaction, setInteraction] = useState<AgentInteractionRequest | null>(null);
  // Tokens-per-second for the current turn (shown next to KRIPL).
  const turnStartRef = useRef<number | null>(null);
  const [tokensPerSecond, setTokensPerSecond] = useState<number | undefined>(undefined);
  // Full-size overlay for inspecting attached images.
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!lightboxSrc) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setLightboxSrc(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxSrc]);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceSearchMode, setWorkspaceSearchMode] = useState<WorkspaceSearchMode | null>(null);
  const assistantMessageId = useRef<string | null>(null);
  // Ordered activity accumulated during the current run (reasoning text and
  // tool calls interleaved); folded into the answer bubble as a collapsible
  // "Рассуждение" block when that message appears.
  const turnActivityRef = useRef<ReasoningStep[]>([]);
  // Wall-clock span of the pending activity (first step → last event).
  const activityStartRef = useRef<number | null>(null);
  const activityEndRef = useRef<number | null>(null);

  // Chat scrolling: stick to the bottom while the user is near it, otherwise
  // count new messages and offer a jump-to-bottom button.
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const seenFeedLengthRef = useRef(0);
  const [pendingMessages, setPendingMessages] = useState(0);
  // Assistant message ids created during the current run (for tok/s).
  const runAssistantIdsRef = useRef<Set<string>>(new Set());
  // A tool call happened after the last assistant bubble was created: the next
  // text block belongs to a genuinely new message, not an extra empty one.
  const toolSinceMessageRef = useRef(false);

  useEffect(() => {
    let disposed = false;

    void window.kripl.getAppInfo().then((info) => {
      if (!disposed) setAppInfo(info);
    });
    void window.kripl.getContextSnapshot().then((snapshot) => {
      if (!disposed) setContextSnapshot(snapshot);
    });

    void window.kripl.getDesktopBootstrap()
      .then(async (bootstrap) => {
        if (disposed) return;
        setRuntimeSettings(bootstrap.runtime);
        setRecentProjects(bootstrap.recentProjects ?? []);
        if (bootstrap.workspace) {
          await hydrateWorkspace(bootstrap.workspace, bootstrap.ui);
        }
      })
      .catch((error) => {
        if (!disposed) {
          setAgentError(error instanceof Error ? error.message : String(error));
        }
      });

    const unsubscribeContext = window.kripl.onContextSnapshot((snapshot) => {
      if (!disposed) setContextSnapshot(snapshot);
    });

    const unsubscribeSessionsChanged = window.kripl.onAgentSessionsChanged(() => {
      if (!disposed) void refreshSessions();
    });
    const unsubscribeWindowMaximized = window.kripl.onWindowMaximized((maximized) => {
      if (!disposed) setWindowMaximized(maximized);
    });

    return () => {
      disposed = true;
      unsubscribeContext();
      unsubscribeSessionsChanged();
      unsubscribeWindowMaximized();
    };
  }, []);

  // Reconnect to the local model server used in the previous run.
  useEffect(() => {
    void probeModels();
  }, []);

  async function refreshSessions() {
    if (!workspace) {
      setSessions([]);
      return;
    }
    try {
      setSessions(await window.kripl.listAgentSessions());
    } catch {
      setSessions([]);
    }
  }

  // Keep the session picker in sync with the workspace's Pi session catalog.
  useEffect(() => {
    void refreshSessions();
  }, [workspace?.path]);

  useEffect(() => {
    writeStored("kripl.localEndpoint", endpoint);
  }, [endpoint]);

  useEffect(() => {
    if (selectedModel) writeStored("kripl.selectedModel", selectedModel);
  }, [selectedModel]);

  useEffect(() => {
    writeStored("kripl.contextWindow", contextWindowOverride ? String(contextWindowOverride) : "");
  }, [contextWindowOverride]);

  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      if (!workspace || !(event.ctrlKey || event.metaKey)) return;

      const key = event.key.toLowerCase();
      if (key === "p" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        setWorkspaceSearchMode("files");
        return;
      }
      if (key === "f" && event.shiftKey && !event.altKey) {
        event.preventDefault();
        setWorkspaceSearchMode("text");
      }
    }

    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [workspace]);

  // Stick to the bottom while the user is near it; otherwise count new
  // messages for the jump-to-bottom button.
  useEffect(() => {
    const el = conversationRef.current;
    if (!el) return;
    if (nearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      seenFeedLengthRef.current = feed.length;
      setPendingMessages(0);
    } else if (feed.length > seenFeedLengthRef.current) {
      setPendingMessages(feed.length - seenFeedLengthRef.current);
    }
  }, [feed]);

  useEffect(() => {
    return window.kripl.onAgentEvent((event: AgentEvent) => {
      if (event.type === "agent.status") {
        setAgentStatus(event.status);
        if (event.status === "stopped" || event.status === "error") {
          setInteraction(null);
          settleTurnActivity();
          sweepEmptyAssistantBubbles();
          void refreshSessions();
        }
        if (event.status === "error") {
          setAgentError(event.message ?? "Pi agent failed.");
        }
        if (event.status === "ready") {
          settleTurnActivity();
          sweepEmptyAssistantBubbles();
          void syncActiveSessionFromRuntime();
        }
        return;
      }

      if (event.type === "agent.turn" && event.phase === "started") {
        assistantMessageId.current = null;
        turnStartRef.current = Date.now();
        setTokensPerSecond(undefined);
        return;
      }

      // A turn is one model call; a tool loop spans many turns. Keep
      // accumulating activity across them — it is folded into the answer
      // bubble when that message appears, or dropped on the next prompt.
      if (event.type === "agent.turn" && event.phase === "completed") {
        return;
      }

      if (event.type === "agent.stream" && event.channel === "thinking") {
        touchActivity();
        // Reasoning accumulates across the whole run: a new block never
        // erases what was already written between tool calls.
        const steps = turnActivityRef.current;
        if (event.phase === "started") {
          steps.push({ kind: "thinking", text: "" });
        } else if (event.phase === "delta") {
          let last = steps[steps.length - 1];
          if (!last || last.kind !== "thinking") {
            last = { kind: "thinking", text: "" };
            steps.push(last);
          }
          last.text += event.delta;
        } else {
          // Completed without deltas: fill the block in once.
          const last = steps[steps.length - 1];
          if (last && last.kind === "thinking" && last.text === "") {
            last.text = event.content;
          }
        }
        setLiveSteps([...steps]);
        return;
      }

      if (event.type === "agent.stream" && event.channel === "text") {
        if (event.phase === "started") {
          // Providers may emit several text blocks for one answer. Only a tool
          // call in between marks the start of a genuinely new message; an extra
          // empty block must not spawn a stray bubble after the final answer.
          const activeId = assistantMessageId.current;
          if (activeId && !toolSinceMessageRef.current) return;

          const id = crypto.randomUUID();
          assistantMessageId.current = id;
          toolSinceMessageRef.current = false;
          runAssistantIdsRef.current.add(id);
          // The answer has arrived: fold everything the agent thought and did
          // while working into this bubble as a collapsed reasoning block.
          const reasoning = takeTurnActivity();
          setFeed((current) => [
            ...current,
            {
              kind: "message",
              id,
              role: "assistant",
              text: "",
              ...(reasoning ? { reasoning } : {})
            }
          ]);
          return;
        }

        const existingId = assistantMessageId.current;
        if (!existingId) {
          const newId = crypto.randomUUID();
          assistantMessageId.current = newId;
          toolSinceMessageRef.current = false;
          runAssistantIdsRef.current.add(newId);
          const initialText = event.phase === "delta" ? event.delta : event.content;
          const reasoning = takeTurnActivity();
          setFeed((current) => [
            ...current,
            {
              kind: "message",
              id: newId,
              role: "assistant",
              text: initialText,
              ...(reasoning ? { reasoning } : {})
            }
          ]);
          return;
        }

        const targetId = existingId;
        setFeed((current) =>
          current.map((item) => {
            if (item.kind !== "message" || item.id !== targetId) return item;
            if (event.phase === "delta") {
              return { ...item, text: item.text + event.delta };
            }
            if (!item.text) {
              return { ...item, text: event.content };
            }
            return item;
          })
        );
        return;
      }

      if (event.type === "agent.interaction") {
        setInteraction(event.request);
        return;
      }

      if (event.type === "agent.usage") {
        const next: { input?: number; output?: number; cacheRead?: number } = {};
        if (event.input !== undefined) next.input = event.input;
        if (event.output !== undefined) next.output = event.output;
        if (event.cacheRead !== undefined) next.cacheRead = event.cacheRead;
        setUsage(next);
        const start = turnStartRef.current;
        if (next.output && next.output > 0 && start) {
          const seconds = Math.max(1, (Date.now() - start) / 1000);
          const value = Math.round((next.output / seconds) * 10) / 10;
          setTokensPerSecond(value);
          writeStored("kripl.tokps.last", String(value));
          // Pin the speed onto every answer bubble of this run that does not
          // have its own value yet (usage events are not tied to a message id,
          // and the values survive app restarts via storage).
          const targets = runAssistantIdsRef.current;
          if (targets.size > 0) {
            setFeed((current) =>
              current.map((item) =>
                item.kind === "message" &&
                item.role === "assistant" &&
                targets.has(item.id) &&
                item.tokps === undefined
                  ? { ...item, tokps: value }
                  : item
              )
            );
          }
        }
        return;
      }

      if (event.type === "agent.notification") {
        if (event.level === "error" || event.level === "warning") {
          setAgentError(event.message);
        }
        return;
      }

      if (event.type === "agent.tool") {
        // Models without native function calling sometimes emit the tool call as
        // raw JSON text. Once execution starts, swap that blob for a marker.
        if (event.phase === "started") {
          toolSinceMessageRef.current = true;
          const matching = new Set([event.name.toLowerCase()]);
          setFeed((current) => {
            for (let i = current.length - 1; i >= 0; i--) {
              const item = current[i];
              if (!item || item.kind !== "message" || item.role !== "assistant") continue;
              const cleaned = cleanAssistantToolText(item.text, matching);
              if (cleaned === item.text) return current;
              const next = [...current];
              next[i] = { ...item, text: cleaned };
              return next;
            }
            return current;
          });
        }

        if (event.phase === "completed" || event.phase === "failed") {
          void Promise.all([
            window.kripl.getWorkspaceChanges(),
            window.kripl.getWorkspaceGitStatus()
          ]).then(([changes, status]) => {
            setWorkspaceChanges(changes);
            setGitStatus(status);
          }).catch(() => {});
        }
        const nextTool: ToolItem = {
          kind: "tool",
          callId: event.callId,
          name: event.name,
          phase: event.phase,
          ...(event.payload === undefined ? {} : { payload: event.payload })
        };
        // Mirror the tool call into the turn activity for the reasoning block,
        // keeping its position relative to the surrounding reasoning text.
        touchActivity();
        const steps = turnActivityRef.current;
        const toolIndex = steps.findIndex(
          (step) => step.kind === "tool" && step.tool.callId === event.callId
        );
        if (toolIndex >= 0) {
          steps[toolIndex] = { kind: "tool", tool: nextTool };
        } else {
          steps.push({ kind: "tool", tool: nextTool });
        }
        setLiveSteps([...steps]);
      }
    });
  }, []);

  const modelReady =
    probe.status === "ready" &&
    probe.models.length > 0 &&
    probe.models.some((model) => model.id === selectedModel);

  const bindingMatchesSelection =
    Boolean(binding) &&
    binding?.workspacePath === workspace?.path &&
    binding?.endpoint === endpoint &&
    binding?.modelId === selectedModel;

  const canStartAgent = Boolean(workspace && modelReady) && agentStatus !== "starting";
  const canSend = bindingMatchesSelection && agentStatus === "ready";

  const selectedModelInfo = probe.models.find((model) => model.id === selectedModel);
  // No silent 32k fallback: if neither the override nor the server reports a
  // limit, the ring shows "unknown" instead of a made-up number.
  const contextWindowLimit =
    contextWindowOverride ?? selectedModelInfo?.contextWindow;
  const lastAssistantId = useMemo(() => {
    for (let index = feed.length - 1; index >= 0; index -= 1) {
      const item = feed[index];
      if (item && item.kind === "message" && item.role === "assistant") return item.id;
    }
    return null;
  }, [feed]);
  const tokenUsageUsed = usage ? (usage.input ?? 0) + (usage.cacheRead ?? 0) : 0;

  // Auto-reconnect: if this workspace was bound to the same server/model in a
  // previous run, start the agent again without any manual steps.
  const autoStartTried = useRef(false);

  useEffect(() => {
    if (autoStartTried.current || !workspace || !modelReady) return;
    let saved: AgentBinding | null = null;
    try {
      const raw = localStorage.getItem("kripl.lastBinding");
      if (raw) saved = JSON.parse(raw) as AgentBinding;
    } catch {
      saved = null;
    }
    if (
      !saved ||
      saved.workspacePath !== workspace.path ||
      saved.endpoint !== endpoint ||
      saved.modelId !== selectedModel
    ) {
      return;
    }
    autoStartTried.current = true;
    void startAgent();
  }, [workspace, modelReady]);

  const dirtyEditorPaths = useMemo(() => {
    const dirty = new Set<string>();
    for (const tab of workspaceTabs) {
      if (tab.type !== "file" || tab.file.binary || tab.file.truncated) continue;
      const draft = editorDrafts[tab.file.path] ?? tab.file.content ?? "";
      if (draft !== (tab.file.content ?? "")) dirty.add(tab.file.path);
    }
    return dirty;
  }, [editorDrafts, workspaceTabs]);

  // Fetch image/PDF previews for newly attached files (best-effort).
  useEffect(() => {
    for (const file of attachments) {
      if (file.error || attachmentPreviews[file.path]) continue;
      const lower = file.name.toLowerCase();
      if (file.kind !== "image" && !lower.endsWith(".pdf")) continue;
      void window.kripl.readAttachPreview(file.path).then((result) => {
        if (result.ok && result.dataUrl) {
          setAttachmentPreviews((current) => ({ ...current, [file.path]: result.dataUrl as string }));
        }
      });
    }
  }, [attachments]);


  async function disconnectAgent() {
    await window.kripl.stopAgent();
    setAgentStatus("stopped");
    setBinding(null);
    assistantMessageId.current = null;
  }

  function hydrateSessionSnapshot(snapshot: AgentSessionSnapshot) {
    const restored: FeedItem[] = snapshot.messages
      .filter((message) => message.role !== "tool")
      .map((message) => ({
        kind: "message" as const,
        id: crypto.randomUUID(),
        role:
          message.role === "user"
            ? "user"
            : message.role === "assistant"
              ? "assistant"
              : "system",
        text: message.text
      }));

    // Restore the last known generation speed onto the final answer bubble.
    const storedTokps = Number(readStored("kripl.tokps.last", ""));
    if (Number.isFinite(storedTokps) && storedTokps > 0) {
      for (let index = restored.length - 1; index >= 0; index -= 1) {
        const item = restored[index];
        if (item && item.kind === "message" && item.role === "assistant") {
          item.tokps = storedTokps;
          break;
        }
      }
    }

    setFeed(restored);
    setLiveSteps(null);
    assistantMessageId.current = null;
  }

  async function syncActiveSessionFromRuntime() {
    try {
      const [snapshot, sessions] = await Promise.all([
        window.kripl.getAgentSessionSnapshot(),
        window.kripl.listAgentSessions()
      ]);
      if (!snapshot) return;
      // The just-streamed transcript already carries reasoning blocks and tok/s
      // that the normalized snapshot does not — keep it. Only hydrate when we
      // did not stream this conversation ourselves (e.g. after a resume).
      const streamedOwnRun = runAssistantIdsRef.current.size > 0;
      if (!streamedOwnRun) {
        hydrateSessionSnapshot(snapshot);
      }
      const persistedPath =
        snapshot.sessionFile &&
        sessions.some((session) => session.path === snapshot.sessionFile)
          ? snapshot.sessionFile
          : undefined;

      if (persistedPath) {
        setBinding((current) =>
          current
            ? {
                ...current,
                sessionPath: persistedPath
              }
            : current
        );
      }
    } catch {
      // Session metadata refresh must not interrupt the live agent UI.
    }
  }

  function persistedView(view: WorkspaceView): DesktopUiState["workspaceView"] {
    if (view.type === "file") return { type: "file", path: view.file.path };
    if (view.type === "diff") return { type: "diff", path: view.diff.path };
    return { type: "agent" };
  }

  function persistWorkspaceUi(
    view: WorkspaceView = workspaceView,
    expanded: Set<string> = expandedDirectories
  ) {
    void window.kripl.saveDesktopUi({
      workspaceView: persistedView(view),
      expandedDirectories: [...expanded]
    }).catch(() => {});
  }

  async function hydrateWorkspace(
    descriptor: WorkspaceDescriptor,
    ui: DesktopUiState
  ) {
    const [rootEntries, changes, nextGitStatus] = await Promise.all([
      window.kripl.listWorkspace(),
      window.kripl.getWorkspaceChanges(),
      descriptor.gitRepository
        ? window.kripl.getWorkspaceGitStatus()
        : Promise.resolve(null)
    ]);

    const entries: Record<string, WorkspaceEntry[]> = { "": rootEntries };
    const expanded = new Set<string>();
    const orderedPaths = [...ui.expandedDirectories]
      .sort((left, right) => left.split("/").length - right.split("/").length)
      .slice(0, 64);

    for (const path of orderedPaths) {
      try {
        entries[path] = await window.kripl.listWorkspace(path);
        expanded.add(path);
      } catch {
        // Stale/deleted directories are simply omitted from restored UI state.
      }
    }

    let nextView: WorkspaceView = { type: "agent" };
    const savedView = ui.workspaceView;

    if (savedView.type === "file" && savedView.path) {
      try {
        const file = await window.kripl.readWorkspaceFile(savedView.path);
        nextView = { type: "file", file };
      } catch {
        nextView = { type: "agent" };
      }
    } else if (savedView.type === "diff" && savedView.path) {
      try {
        const diff = await window.kripl.getWorkspaceDiff(savedView.path);
        nextView = { type: "diff", diff };
      } catch {
        nextView = { type: "agent" };
      }
    }

    setWorkspace(descriptor);
    setWorkspaceEntries(entries);
    setExpandedDirectories(expanded);
    setWorkspaceChanges(changes);
    setGitStatus(nextGitStatus);
    setWorkspaceView(nextView);
    setWorkspaceTabs(nextView.type === "agent" ? [] : [nextView]);
    setEditorDrafts(
      nextView.type === "file"
        ? { [nextView.file.path]: nextView.file.content ?? "" }
        : {}
    );
    setEditorRevealTarget(undefined);
    setBinding(null);
    setAgentStatus("idle");
    setFeed([]);
    setLiveSteps(null);
    setInteraction(null);
    assistantMessageId.current = null;
  }

  function confirmWorkspaceSwitch(): boolean {
    if (dirtyEditorPaths.size === 0) return true;

    const count = dirtyEditorPaths.size;
    return window.confirm(
      `You have ${count} unsaved editor buffer${count === 1 ? "" : "s"}. Switching projects will discard ${count === 1 ? "it" : "them"}.\n\nContinue?`
    );
  }

  async function openWorkspace() {
    if (!confirmWorkspaceSwitch()) return;

    try {
      const selected = await window.kripl.pickWorkspace();
      if (!selected) return;

      await hydrateWorkspace(selected, {
        workspaceView: { type: "agent" },
        expandedDirectories: []
      });
      setAgentError("");
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
    }
  }

  // Quick switch to a recent repository from the right rail.
  async function openRecentProject(path: string) {
    if (!confirmWorkspaceSwitch()) return;

    try {
      const descriptor = await window.kripl.openRecentProject(path);
      await hydrateWorkspace(descriptor, {
        workspaceView: { type: "agent" },
        expandedDirectories: []
      });
      setAgentError("");
      // Re-read bootstrap: the recent list order and runtime settings changed.
      const bootstrap = await window.kripl.getDesktopBootstrap();
      setRecentProjects(bootstrap.recentProjects ?? []);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
    }
  }

  async function forgetRecentProject(path: string) {
    try {
      setRecentProjects(await window.kripl.forgetRecentProject(path));
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshWorkspace() {
    if (!workspace) return;
    try {
      const [rootEntries, changes, nextGitStatus] = await Promise.all([
        window.kripl.listWorkspace(),
        window.kripl.getWorkspaceChanges(),
        window.kripl.getWorkspaceGitStatus()
      ]);

      const entries: Record<string, WorkspaceEntry[]> = { "": rootEntries };
      const orderedPaths = [...expandedDirectories]
        .sort((left, right) => left.split("/").length - right.split("/").length)
        .slice(0, 64);

      for (const path of orderedPaths) {
        try {
          entries[path] = await window.kripl.listWorkspace(path);
        } catch {
          // Ignore stale directories during refresh.
        }
      }

      setWorkspaceEntries(entries);
      setWorkspaceChanges(changes);
      setGitStatus(nextGitStatus);

      if (workspaceView.type === "file") {
        try {
          const file = await window.kripl.readWorkspaceFile(workspaceView.file.path);
          const view: WorkspaceDocumentView = { type: "file", file };
          reconcileEditorDraft(file);
          setWorkspaceView(view);
          setWorkspaceTabs((current) => upsertWorkspaceTab(current, view));
        } catch {
          const staleKey = workspaceViewKey(workspaceView);
          setWorkspaceTabs((current) =>
            current.filter((tab) => workspaceViewKey(tab) !== staleKey)
          );
          setEditorDrafts((current) => {
            const next = { ...current };
            delete next[workspaceView.file.path];
            return next;
          });
          const view: WorkspaceView = { type: "agent" };
          setWorkspaceView(view);
          persistWorkspaceUi(view);
        }
      } else if (workspaceView.type === "diff") {
        try {
          const diff = await window.kripl.getWorkspaceDiff(workspaceView.diff.path);
          const view: WorkspaceDocumentView = { type: "diff", diff };
          setWorkspaceView(view);
          setWorkspaceTabs((current) => upsertWorkspaceTab(current, view));
        } catch {
          const staleKey = workspaceViewKey(workspaceView);
          setWorkspaceTabs((current) =>
            current.filter((tab) => workspaceViewKey(tab) !== staleKey)
          );
          const view: WorkspaceView = { type: "agent" };
          setWorkspaceView(view);
          persistWorkspaceUi(view);
        }
      }
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
    }
  }

  async function toggleDirectory(path: string) {
    if (expandedDirectories.has(path)) {
      setExpandedDirectories((current) => {
        const next = new Set(current);
        next.delete(path);
        persistWorkspaceUi(workspaceView, next);
        return next;
      });
      return;
    }

    try {
      if (!workspaceEntries[path]) {
        const entries = await window.kripl.listWorkspace(path);
        setWorkspaceEntries((current) => ({ ...current, [path]: entries }));
      }
      setExpandedDirectories((current) => {
        const next = new Set(current);
        next.add(path);
        persistWorkspaceUi(workspaceView, next);
        return next;
      });
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
    }
  }

  function reconcileEditorDraft(file: WorkspaceFilePreview) {
    const previousTab = workspaceTabs.find(
      (tab) => tab.type === "file" && tab.file.path === file.path
    );
    const previousContent =
      previousTab?.type === "file" ? previousTab.file.content ?? "" : undefined;
    const nextContent = file.content ?? "";

    setEditorDrafts((current) => {
      const existing = current[file.path];
      const wasDirty =
        previousContent !== undefined &&
        existing !== undefined &&
        existing !== previousContent;

      if (wasDirty || existing === nextContent) return current;
      return { ...current, [file.path]: nextContent };
    });
  }

  async function openWorkspaceFile(
    path: string,
    location?: { line: number; column: number; length: number }
  ) {
    try {
      const file = await window.kripl.readWorkspaceFile(path);
      const view: WorkspaceDocumentView = { type: "file", file };
      reconcileEditorDraft(file);
      setWorkspaceTabs((current) => upsertWorkspaceTab(current, view));
      setWorkspaceView(view);
      setEditorRevealTarget(
        location
          ? {
              path,
              line: location.line,
              column: location.column,
              length: location.length,
              requestId: crypto.randomUUID()
            }
          : undefined
      );
      persistWorkspaceUi(view);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
    }
  }

  async function openWorkspaceDiff(path: string) {
    try {
      const diff = await window.kripl.getWorkspaceDiff(path);
      const view: WorkspaceDocumentView = { type: "diff", diff };
      setWorkspaceTabs((current) => upsertWorkspaceTab(current, view));
      setWorkspaceView(view);
      setEditorRevealTarget(undefined);
      persistWorkspaceUi(view);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
    }
  }

  function updateEditorDraft(path: string, content: string) {
    setEditorDrafts((current) => ({ ...current, [path]: content }));
  }

  function selectWorkspaceView(view: WorkspaceView) {
    setWorkspaceView(view);
    setEditorRevealTarget(undefined);
    persistWorkspaceUi(view);
  }

  function closeWorkspaceTab(tab: WorkspaceDocumentView) {
    const key = workspaceViewKey(tab);
    if (tab.type === "file" && dirtyEditorPaths.has(tab.file.path)) {
      const shouldClose = window.confirm(
        "This tab has unsaved changes. Close it and discard the editor buffer?\n\n" +
          tab.file.path
      );
      if (!shouldClose) return;
    }

    const index = workspaceTabs.findIndex((candidate) => workspaceViewKey(candidate) === key);
    const nextTabs = workspaceTabs.filter((candidate) => workspaceViewKey(candidate) !== key);
    setWorkspaceTabs(nextTabs);

    if (tab.type === "file") {
      setEditorDrafts((current) => {
        const next = { ...current };
        delete next[tab.file.path];
        return next;
      });
      if (editorRevealTarget?.path === tab.file.path) {
        setEditorRevealTarget(undefined);
      }
    }

    if (workspaceView.type !== "agent" && workspaceViewKey(workspaceView) === key) {
      const fallback = nextTabs[Math.min(Math.max(index, 0), nextTabs.length - 1)];
      const nextView: WorkspaceView = fallback ?? { type: "agent" };
      setWorkspaceView(nextView);
      persistWorkspaceUi(nextView);
    }
  }

  async function saveWorkspaceFile(path: string, content: string) {
    const file = await window.kripl.writeWorkspaceFile(path, content);
    const [changes, nextGitStatus] = await Promise.all([
      window.kripl.getWorkspaceChanges(),
      window.kripl.getWorkspaceGitStatus()
    ]);
    setWorkspaceChanges(changes);
    setGitStatus(nextGitStatus);
    setEditorDrafts((current) => ({ ...current, [path]: file.content ?? "" }));
    const view: WorkspaceDocumentView = { type: "file", file };
    setWorkspaceTabs((current) => upsertWorkspaceTab(current, view));
    setWorkspaceView(view);
    persistWorkspaceUi(view);
  }

  async function refreshDiffAfterAction(path: string) {
    const [changes, nextGitStatus] = await Promise.all([
      window.kripl.getWorkspaceChanges(),
      window.kripl.getWorkspaceGitStatus()
    ]);
    setWorkspaceChanges(changes);
    setGitStatus(nextGitStatus);
    const stillChanged = changes.some((change) => change.path === path);

    if (stillChanged) {
      const diff = await window.kripl.getWorkspaceDiff(path);
      const view: WorkspaceDocumentView = { type: "diff", diff };
      setWorkspaceTabs((current) => upsertWorkspaceTab(current, view));
      setWorkspaceView(view);
      persistWorkspaceUi(view);
      return;
    }

    try {
      const file = await window.kripl.readWorkspaceFile(path);
      const view: WorkspaceDocumentView = { type: "file", file };
      reconcileEditorDraft(file);
      setWorkspaceTabs((current) => upsertWorkspaceTab(current, view));
      setWorkspaceView(view);
      persistWorkspaceUi(view);
    } catch {
      const view: WorkspaceView = { type: "agent" };
      setWorkspaceView(view);
      persistWorkspaceUi(view);
    }
  }

  async function stageWorkspaceChange(path: string) {
    await window.kripl.stageWorkspaceChange(path);
    await refreshDiffAfterAction(path);
  }

  async function unstageWorkspaceChange(path: string) {
    await window.kripl.unstageWorkspaceChange(path);
    await refreshDiffAfterAction(path);
  }

  async function revertWorkspaceChange(path: string) {
    await window.kripl.revertWorkspaceChange(path);
    await refreshWorkspace();
    await refreshDiffAfterAction(path);
  }

  async function commitWorkspaceChanges(message: string): Promise<WorkspaceCommitResult> {
    const result = await window.kripl.commitWorkspaceChanges(message);
    await refreshWorkspace();
    return result;
  }

  async function retrieveMemory(query: string) {
    await window.kripl.retrieveMemory(query);
  }

  async function probeModels() {
    setProbe((current) => ({ status: "checking", models: current.models }));
    const result = await window.kripl.probeLocalModels(endpoint);

    if (!result.ok) {
      setProbe({ status: "error", models: [], message: result.error ?? "Local model probe failed." });
      setSelectedModel("");
      return;
    }

    setEndpoint(result.endpoint);
    setProbe({ status: "ready", models: result.models });
    setSelectedModel((current) => {
      if (result.models.some((model) => model.id === current)) return current;
      return result.models[0]?.id ?? "";
    });
  }

  async function startAgent(resumeSessionPath?: string) {
    if (!workspace || !modelReady || !selectedModel) return;

    setAgentError("");
    setAgentStatus("starting");
    setFeed([]);
    setLiveSteps(null);
    setUsage(null);
    assistantMessageId.current = null;

    const result = await window.kripl.startAgent({
      endpoint,
      modelId: selectedModel,
      ...(resumeSessionPath ? { sessionPath: resumeSessionPath } : {})
    });

    if (!result.ok) {
      setAgentStatus("error");
      setAgentError(result.error ?? "Failed to start Pi agent.");
      setBinding(null);
      return;
    }

    const snapshot = await window.kripl.getAgentSessionSnapshot().catch(() => null);
    if (snapshot) {
      hydrateSessionSnapshot(snapshot);
    }

    const nextBinding: AgentBinding = {
      workspacePath: workspace.path,
      endpoint,
      modelId: selectedModel,
      sessionPath: resumeSessionPath ?? ""
    };
    setBinding(nextBinding);
    writeStored("kripl.lastBinding", JSON.stringify(nextBinding));
    setAgentStatus("ready");
    void refreshSessions();
  }

  async function addAttachments(paths: string[]) {
    const result = await window.kripl.attachAgentFiles(paths);
    if (!result.ok || !result.files?.length) return;
    setAttachments((current) => [...current, ...result.files!].slice(-10));
  }

  async function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const fileItems = Array.from(event.clipboardData.items).filter(
      (item) => item.kind === "file"
    );
    if (fileItems.length === 0) return; // regular text paste
    event.preventDefault();

    const directPaths: string[] = [];
    for (const item of fileItems) {
      const file = item.getAsFile() as (File & { path?: string }) | null;
      if (!file) continue;
      if (typeof file.path === "string" && file.path.trim()) {
        directPaths.push(file.path);
        continue;
      }

      // Clipboard payload without a filesystem path (e.g. copied screenshot):
      // ship the raw bytes to main and let it materialize an attachment.
      void (async () => {
        try {
          const buffer = await file.arrayBuffer();
          const result = await window.kripl.pasteAgentFiles([
            { name: file.name || "pasted-file", dataBase64: arrayBufferToBase64(buffer) }
          ]);
          if (result.ok && result.files?.length) {
            setAttachments((current) => [...current, ...result.files!].slice(-10));
          }
        } catch {
          // Ignore clipboard payloads that cannot be read.
        }
      })();
    }

    if (directPaths.length > 0) void addAttachments(directPaths);
  }

  async function commitSessionRename(path: string) {
    const name = renameValue.trim();
    setRenamingPath(null);
    const result = await window.kripl.renameAgentSession(path, name);
    if (!result.ok) {
      setAgentError(result.error ?? "Failed to rename session.");
      return;
    }
    void refreshSessions();
  }

  async function pickAttachments() {
    const paths = await window.kripl.pickAttachFiles();
    if (paths.length > 0) void addAttachments(paths);
  }

  function removeAttachment(index: number) {
    setAttachments((current) => current.filter((_file, i) => i !== index));
  }

  /** Mark that reasoning/tool activity is happening right now. */
  function touchActivity(): void {
    const now = Date.now();
    if (activityStartRef.current === null) activityStartRef.current = now;
    activityEndRef.current = now;
  }

  /** Snapshot the activity accumulated so far and reset the accumulator. */
  function takeTurnActivity(): ReasoningBlock | null {
    const steps = turnActivityRef.current.filter(
      (step) =>
        step.kind === "tool" || (step.kind === "thinking" && step.text.trim() !== "")
    );
    turnActivityRef.current = [];
    setLiveSteps(null);
    if (steps.length === 0) return null;
    const start = activityStartRef.current;
    const end = activityEndRef.current ?? start;
    activityStartRef.current = null;
    activityEndRef.current = null;
    return {
      steps,
      ...(start !== null && end !== null ? { durationMs: Math.max(0, end - start) } : {})
    };
  }

  /** Drop pending activity (turn aborted or a new prompt starts). */
  function discardTurnActivity(): void {
    turnActivityRef.current = [];
    runAssistantIdsRef.current = new Set();
    toolSinceMessageRef.current = false;
    activityStartRef.current = null;
    activityEndRef.current = null;
    setLiveSteps(null);
  }

  /**
   * Run finished: providers sometimes start a trailing thinking-only turn
   * after the final answer. Fold whatever is still pending into the last
   * assistant message and clear the live card so it does not linger.
   */
  function settleTurnActivity(): void {
    const steps = takeTurnActivity();
    if (!steps) return;
    setFeed((current) => {
      for (let i = current.length - 1; i >= 0; i -= 1) {
        const item: FeedItem | undefined = current[i];
        if (!item || item.kind !== "message" || item.role !== "assistant") continue;
        const next = [...current];
        next[i] = {
          ...item,
          reasoning: {
            steps: [...(item.reasoning?.steps ?? []), ...steps.steps]
          }
        };
        return next;
      }
      return current; // no assistant message at all — drop the trailing thinking
    });
  }

  /**
   * Run finished: drop assistant bubbles that ended up with no text (stray
   * empty blocks from the provider). Their reasoning steps, if any, are
   * appended to the previous answer bubble so nothing is lost.
   */
  function sweepEmptyAssistantBubbles(): void {
    setFeed((current) => {
      let changed = false;
      const next: FeedItem[] = [];
      for (const item of current) {
        if (
          item.kind === "message" &&
          item.role === "assistant" &&
          item.text.trim() === ""
        ) {
          changed = true;
          if (item.reasoning) {
            for (let i = next.length - 1; i >= 0; i -= 1) {
              const prev = next[i];
              if (prev && prev.kind === "message" && prev.role === "assistant") {
                const mergedDuration =
                  (prev.reasoning?.durationMs ?? 0) + (item.reasoning.durationMs ?? 0);
                next[i] = {
                  ...prev,
                  reasoning: {
                    steps: [...(prev.reasoning?.steps ?? []), ...item.reasoning.steps],
                    ...(mergedDuration > 0 ? { durationMs: mergedDuration } : {})
                  }
                };
                break;
              }
            }
          }
          continue;
        }
        next.push(item);
      }
      return changed ? next : current;
    });
  }

  async function sendPrompt() {
    const text = composerText.trim();
    if ((!text && attachments.length === 0) || !canSend) return;
    discardTurnActivity();

    const finalText = buildMessageWithAttachments(text, attachments);
    const imageFiles = attachments.filter(
      (file) => !file.error && file.kind === "image" && attachmentPreviews[file.path]
    );
    // The chat shows only what the user typed; attachment metadata is
    // still sent to the model in `finalText`.
    const userMessage: MessageItem = {
      kind: "message",
      id: crypto.randomUUID(),
      role: "user",
      text: text,
      ...(imageFiles.length > 0
        ? { images: imageFiles.map((file) => attachmentPreviews[file.path] as string) }
        : {})
    };

    setFeed((current) => [...current, userMessage]);
    setComposerText("");
    setAttachments([]);
    setAgentError("");
    assistantMessageId.current = null;

    // A fresh prompt always pulls the view back to the bottom.
    nearBottomRef.current = true;

    const result = await window.kripl.sendAgentMessage(finalText);
    if (!result.ok) {
      setAgentStatus("error");
      setAgentError(result.error ?? "Prompt was rejected.");
    }
  }

  /**
   * Regenerate a disliked answer: drop it (and anything after it), then re-run
   * the preceding user prompt with an explicit regenerate directive, so the
   * model sees its discarded answer and produces a fresh one. Attachment
   * messages cannot be resent and are excluded.
   */
  async function regenerateAnswer(id: string): Promise<void> {
    if (!canSend) return;
    const index = feed.findIndex((item) => item.kind === "message" && item.id === id);
    if (index < 0) return;

    let userMessage: MessageItem | null = null;
    for (let i = index - 1; i >= 0; i -= 1) {
      const item = feed[i];
      if (item && item.kind === "message" && item.role === "user") {
        userMessage = item;
        break;
      }
    }
    if (!userMessage || (userMessage.images && userMessage.images.length > 0)) return;

    discardTurnActivity();
    setFeed((current) => current.slice(0, index)); // keep the prompt, drop the answer
    assistantMessageId.current = null;
    nearBottomRef.current = true;

    const directive = `${userMessage.text}\n\n[Regenerate] Your previous answer to this message was discarded by the user. Produce a fresh answer.`;
    const result = await window.kripl.sendAgentMessage(directive);
    if (!result.ok) {
      setAgentStatus("error");
      setAgentError(result.error ?? "Prompt was rejected.");
    }
  }


  async function respondToInteraction(response: AgentInteractionResponse) {
    const result = await window.kripl.respondToAgentInteraction(response);
    if (!result.ok) {
      setAgentError(result.error ?? "Failed to answer agent permission request.");
      return;
    }
    setInteraction(null);
  }

  async function abortAgent() {
    const result = await window.kripl.abortAgent();
    if (!result.ok) {
      setAgentStatus("error");
      setAgentError(result.error ?? "Failed to stop the current run.");
    }
  }

  return (
    <div className={"app-shell" + (terminalVisible ? " terminal-open" : "")}>
      <header className="titlebar">
        <div className="brand">
          <img className="brand-icon" src={kriplIcon} alt="Kripl Studio" />
          <span>Kripl Studio</span>
        </div>
        <div className="titlebar-controls">
          <button
            type="button"
            className="window-control"
            title="Minimize"
            onClick={() => void window.kripl.minimizeWindow()}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M1.5 6h9" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
          <button
            type="button"
            className="window-control"
            title={windowMaximized ? "Restore" : "Maximize"}
            onClick={() => void window.kripl.toggleMaximizeWindow()}
          >
            {windowMaximized ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <rect x="2" y="4.5" width="6" height="6" stroke="currentColor" strokeWidth="1.2" />
                <path d="M4.5 3h5v5" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <rect x="1.5" y="1.5" width="9" height="9" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="window-control close"
            title="Close"
            onClick={() => void window.kripl.closeWindow()}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        </div>
      </header>

      {workspace && workspaceSearchMode && (
        <WorkspaceSearchPalette
          mode={workspaceSearchMode}
          onModeChange={setWorkspaceSearchMode}
          onClose={() => setWorkspaceSearchMode(null)}
          onOpenFile={openWorkspaceFile}
        />
      )}

      <div className="workspace">
        <WorkspaceSidebar
          workspace={workspace}
          entries={workspaceEntries}
          expanded={expandedDirectories}
          changes={workspaceChanges}
          activePath={activeWorkspacePath(workspaceView)}
          onOpenWorkspace={() => void openWorkspace()}
          onRefresh={() => void refreshWorkspace()}
          onToggleDirectory={(path) => void toggleDirectory(path)}
          onOpenFile={(path) => void openWorkspaceFile(path)}
          onOpenDiff={(path) => void openWorkspaceDiff(path)}
          terminalOpen={terminalVisible}
          onSelectTerminal={() => setTerminalVisible(true)}
          onCloseTerminal={() => setTerminalVisible(false)}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <main
          className="agent-column"
          onDragOver={(event) => {
            if (Array.from(event.dataTransfer.types).includes("Files")) {
              event.preventDefault();
              setDragActive(true);
            }
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragActive(false);
            const paths = Array.from(event.dataTransfer.files)
              .map((file) => (file as File & { path?: string }).path ?? "")
              .filter(Boolean);
            if (paths.length > 0) void addAttachments(paths);
          }}
        >
          {dragActive && (
            <div className="drop-overlay">Drop files to attach them to the chat</div>
          )}

          {lightboxSrc && (
            <div className="image-lightbox" onClick={() => setLightboxSrc(null)}>
              <img src={lightboxSrc} alt="Attachment preview" />
            </div>
          )}

          <WorkspaceTabs
            tabs={workspaceTabs}
            activeView={workspaceView}
            dirtyFiles={dirtyEditorPaths}
            onSelectAgent={() => selectWorkspaceView({ type: "agent" })}
            onSelect={selectWorkspaceView}
            onClose={closeWorkspaceTab}
          />

          {workspaceView.type === "agent" ? (
            <>

          <div
            className="conversation"
            ref={conversationRef}
            onScroll={() => {
              const el = conversationRef.current;
              if (!el) return;
              const nearBottom =
                el.scrollTop + el.clientHeight >= el.scrollHeight - 60;
              nearBottomRef.current = nearBottom;
              if (nearBottom) {
                seenFeedLengthRef.current = feed.length;
                setPendingMessages(0);
              }
            }}
          >
            {feed.length === 0 ? (
              <section className="welcome-card">
                <span className="eyebrow">Kripl Studio</span>
                <h2>Local model → Pi → workspace.</h2>
                <p>
                  Open a project, connect a loopback OpenAI-compatible model server, then start
                  Pi. The selected model is written only to Kripl Studio's isolated Pi config;
                  your normal Pi configuration is not modified.
                </p>
                <div className="capability-row">
                  <span>AgentRuntime</span>
                  <span>Local Model</span>
                  <span>Pi RPC</span>
                  <span>MemoryRuntime</span>
                </div>
              </section>
            ) : (
              <div className="transcript">
                {feed.map((item) =>
                  item.kind === "message" ? (
                    <article key={item.id} className={`chat-message ${item.role}`}>
                      <div className="message-role">
                        <span>{item.role === "user" ? "You" : item.role === "assistant" ? "Kripl" : "System"}</span>
                        {(() => {
                          const tokps =
                            item.role !== "assistant"
                              ? undefined
                              : item.tokps ??
                                (item.id === lastAssistantId ? tokensPerSecond : undefined);
                          return tokps !== undefined ? (
                            <span className="message-tokps">{tokps} tok/s</span>
                          ) : null;
                        })()}
                        {item.role === "assistant" && (
                          <span className="message-actions">
                            {item.text.trim() !== "" && (
                              <CopyIconButton text={item.text} title="Скопировать ответ" />
                            )}
                            {canSend && item.id === lastAssistantId && !item.images?.length ? (
                              <button
                                type="button"
                                className="regenerate-button"
                                title="Перегенерировать: удалить этот ответ и запустить промпт заново"
                                onClick={() => void regenerateAnswer(item.id)}
                              >
                                ↻
                              </button>
                            ) : null}
                          </span>
                        )}
                      </div>
                      {item.role === "assistant" && item.reasoning ? (
                        <CollapsibleDetails
                          className="reasoning"
                          bodyClassName="reasoning-body"
                          summary={
                            <>
                              <span>Рассуждение</span>
                              {item.reasoning.durationMs !== undefined && (
                                <span className="reasoning-duration">
                                  {formatReasoningDuration(item.reasoning.durationMs)}
                                </span>
                              )}
                              <span className="chevrons" aria-hidden="true">
                                <svg className="chevron-down" width="14" height="9" viewBox="0 0 14 9" fill="none">
                                  <path d="M2 2.5l5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                                <svg className="chevron-up" width="14" height="9" viewBox="0 0 14 9" fill="none">
                                  <path d="M2 6.5l5-5 5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              </span>
                            </>
                          }
                        >
                          {item.reasoning.steps.map((step, index) =>
                            step.kind === "thinking" ? (
                              <Markdown key={index} text={step.text} />
                            ) : (
                              <details
                                key={step.tool.callId}
                                className={`reasoning-tool ${step.tool.phase}`}
                              >
                                <summary>
                                  <span>{step.tool.name}</span>
                                  <span>{step.tool.phase}</span>
                                </summary>
                                {step.tool.payload !== undefined && (
                                  <pre>{payloadPreview(step.tool.payload)}</pre>
                                )}
                              </details>
                            )
                          )}
                        </CollapsibleDetails>
                      ) : null}
                      {item.images && item.images.length > 0 && (
                        <div className="message-images">
                          {item.images.map((src, index) => (
                            <button
                              key={index}
                              type="button"
                              className="message-image-button"
                              title="Open full size"
                              onClick={() => setLightboxSrc(src)}
                            >
                              <img src={src} alt="Attached image" />
                            </button>
                          ))}
                        </div>
                      )}
                      {(item.text || !(item.images && item.images.length > 0)) && (
                        <div className="message-text">
                          {item.text ? <Markdown text={item.text} /> : "…"}
                        </div>
                      )}
                    </article>
                  ) : (
                    <details key={item.callId} className={`tool-card ${item.phase}`}>
                      <summary>
                        <span>{item.name}</span>
                        <span>{item.phase}</span>
                      </summary>
                      {item.payload !== undefined && <pre>{payloadPreview(item.payload)}</pre>}
                    </details>
                  )
                )}

                {/* Live reasoning: written into the chat as it streams; folded
                    into the final answer bubble once that message appears. */}
                {liveSteps && (
                  <details className="thinking-card" open>
                    <summary>Рассуждение</summary>
                    <div>
                      {liveSteps.map((step, index) =>
                        step.kind === "thinking" ? (
                          step.text.trim() ? (
                            <Markdown key={index} text={step.text} />
                          ) : null
                        ) : (
                          <details
                            key={step.tool.callId}
                            className={`reasoning-tool ${step.tool.phase}`}
                          >
                            <summary>
                              <span>{step.tool.name}</span>
                              <span>{step.tool.phase}</span>
                            </summary>
                            {step.tool.payload !== undefined && (
                              <pre>{payloadPreview(step.tool.payload)}</pre>
                            )}
                          </details>
                        )
                      )}
                    </div>
                  </details>
                )}
              </div>
            )}

            {agentError && <div className="agent-error">{agentError}</div>}

            {/* Sticky anchor: pins the pill to the visible bottom while the
                user is scrolled up, sits at content end otherwise. */}
            <div className="jump-anchor">
              {pendingMessages > 0 && (
                <button
                  type="button"
                  className="jump-to-bottom"
                  title="К последним сообщениям"
                  onClick={() => {
                    const el = conversationRef.current;
                    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
                  }}
                >
                  ↓ {pendingMessages}
                </button>
              )}
            </div>
          </div>

          <div className="composer">
            {attachments.length > 0 && (
              <>
                {pdfPreviewPath && attachmentPreviews[pdfPreviewPath] ? (
                  <iframe
                    className="attach-pdf-frame"
                    src={attachmentPreviews[pdfPreviewPath]}
                    title={`PDF preview: ${basename(pdfPreviewPath)}`}
                  />
                ) : null}
                <div className="attach-chips">
                  {attachments.map((file, index) => {
                    const preview = attachmentPreviews[file.path];
                    const isPdf = file.name.toLowerCase().endsWith(".pdf");
                    // Images: bare rectangle with a hairline outline, no caption.
                    if (preview && !isPdf) {
                      return (
                        <span
                          key={`${file.path}-${index}`}
                          className="attach-chip attach-image"
                          title={file.name}
                          onClick={() => setLightboxSrc(preview as string)}
                        >
                          <img className="attach-chip-thumb" src={preview} alt={file.name} />
                          <button
                            type="button"
                            className="attach-image-remove"
                            aria-label={`Remove ${file.name}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              removeAttachment(index);
                            }}
                          >
                            ×
                          </button>
                        </span>
                      );
                    }
                    return (
                      <span
                        key={`${file.path}-${index}`}
                        className={"attach-chip" + (file.error ? " error" : "")}
                        title={file.error ?? file.path}
                      >
                        {isPdf ? (
                          "📕"
                        ) : file.kind === "image" ? (
                          "🖼️"
                        ) : file.kind === "archive" ? (
                          "🗜️"
                        ) : (
                          "📄"
                        )}
                        {file.name} · {formatBytes(file.sizeBytes)}
                        {isPdf && preview ? (
                          <button
                            type="button"
                            className="attach-chip-pdf"
                            onClick={() =>
                              setPdfPreviewPath((current) => (current === file.path ? null : file.path))
                            }
                          >
                            {pdfPreviewPath === file.path ? "hide" : "preview"}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="attach-chip-remove"
                          onClick={() => removeAttachment(index)}
                        >
                          ×
                        </button>
                      </span>
                    );
                  })}
                </div>
              </>
            )}
            <textarea
              disabled={!canSend}
              rows={2}
              value={composerText}
              onChange={(event) => setComposerText(event.target.value)}
              onPaste={(event) => void handleComposerPaste(event)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendPrompt();
                }
              }}
              placeholder={
                canSend
                  ? "Ask Kripl to inspect or change the project…"
                  : agentStatus === "running"
                    ? "Agent is working…"
                    : "Open a project, connect a local model, and start Pi…"
              }
            />
            <div className="composer-bottom">
              <button
                type="button"
                className="attach-button"
                title="Attach files (or drag & drop them anywhere on the chat)"
                onClick={() => void pickAttachments()}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M21 12.5l-8.6 8.6a5 5 0 01-7.1-7.1L13.9 5.4a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.6 1.6 0 01-2.3-2.3l8.2-8.2"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <TokenRing used={tokenUsageUsed} limit={contextWindowLimit} />
              <span className="composer-bottom-spacer" />
              {agentStatus === "running" || agentStatus === "stopping" ? (
                <button
                  type="button"
                  className="send-button stop"
                  title="Stop the agent"
                  onClick={() => void abortAgent()}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" />
                  </svg>
                </button>
              ) : (
                <button
                  type="button"
                  className="send-button"
                  title="Send (Enter)"
                  disabled={!canSend || (!composerText.trim() && attachments.length === 0)}
                  onClick={() => void sendPrompt()}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M12 19V5m0 0L6 11m6-6l6 6"
                      stroke="currentColor"
                      strokeWidth="2.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
            </div>
          </div>

            </>
          ) : (
            <WorkspaceContent
              view={workspaceView}
              draft={
                workspaceView.type === "file"
                  ? editorDrafts[workspaceView.file.path]
                  : undefined
              }
              revealTarget={editorRevealTarget}
              onDraftChange={updateEditorDraft}
              onSaveFile={saveWorkspaceFile}
              onStage={stageWorkspaceChange}
              onUnstage={unstageWorkspaceChange}
              onRevert={revertWorkspaceChange}
            />
          )}
        </main>

        <aside className="session-rail">
          <CollapsibleDetails
            className="status-card session-card"
            bodyClassName="sessions-body"
            defaultOpen
            summary={
              <span className="session-heading">
                <span className="eyebrow">Sessions</span>
                <span className="session-heading-actions">
                  <button
                    className="icon-button"
                    type="button"
                    title="New session"
                    disabled={!canStartAgent}
                    onClick={(event) => {
                      event.preventDefault(); // do not toggle the panel
                      void startAgent();
                    }}
                  >
                    +
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    title="Refresh sessions"
                    onClick={(event) => {
                      event.preventDefault(); // do not toggle the panel
                      void refreshSessions();
                    }}
                  >
                    ↻
                  </button>
                  <span className="chevrons" aria-hidden="true">
                    <svg className="chevron-down" width="14" height="9" viewBox="0 0 14 9" fill="none">
                      <path d="M2 2.5l5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <svg className="chevron-up" width="14" height="9" viewBox="0 0 14 9" fill="none">
                      <path d="M2 6.5l5-5 5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </span>
              </span>
            }
          >

            {!workspace ? (
              <p className="sidebar-note">Open a project to list its chats.</p>
            ) : !modelReady || !selectedModel ? (
              <p className="sidebar-note">Connect a local model and pick one first.</p>
            ) : (
              <>
                {sessions.length === 0 && (
                  <p className="sidebar-note">No saved chats yet for this project.</p>
                )}
                <div className="session-list">
                  {[...sessions]
                    .sort((a, b) => b.modifiedAt - a.modifiedAt)
                    .map((session) => (
                      <div
                        key={session.path}
                        className={
                          "session-row" + (binding?.sessionPath === session.path ? " active" : "")
                        }
                      >
                        <button
                          type="button"
                          className="session-resume"
                          disabled={!canStartAgent}
                          title={`Resume ${session.name ?? basename(session.path)}`}
                          onClick={() => void startAgent(session.path)}
                        >
                          <span className="session-name">
                            {session.name && session.name !== basename(session.path)
                              ? session.name
                              : (session.firstMessage?.slice(0, 60) ?? basename(session.path))}
                          </span>
                          <span className="session-meta">
                            {session.messageCount} msg · {new Date(session.modifiedAt).toLocaleString()}
                          </span>
                        </button>
                        {renamingPath === session.path ? (
                          <input
                            className="session-rename-input"
                            autoFocus
                            value={renameValue}
                            placeholder="Chat name (empty = reset)"
                            onChange={(event) => setRenameValue(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") void commitSessionRename(session.path);
                              else if (event.key === "Escape") setRenamingPath(null);
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            className="icon-button session-rename"
                            title="Rename this chat"
                            onClick={() => {
                              const current =
                                session.name && session.name !== basename(session.path)
                                  ? session.name
                                  : "";
                              setRenamingPath(session.path);
                              setRenameValue(current);
                            }}
                          >
                            ✎
                          </button>
                        )}
                      </div>
                    ))}
                </div>
              </>
            )}
          </CollapsibleDetails>

          {runtimeSettings && (
            <AgentPermissionsCard
              settings={runtimeSettings}
              onApply={async (next) => {
                const saved = await window.kripl.saveRuntimeSettings(next);
                setRuntimeSettings(saved);
              }}
            />
          )}

          {runtimeSettings && (
            <ModelTuningCard
              settings={runtimeSettings}
              onApply={async (next) => {
                const saved = await window.kripl.saveRuntimeSettings(next);
                setRuntimeSettings(saved);
              }}
            />
          )}

          <RecentProjectsCard
            projects={recentProjects}
            currentPath={workspace?.path}
            onOpen={(path) => void openRecentProject(path)}
            onForget={(path) => void forgetRecentProject(path)}
          />

          {/* Branding loop pinned to the bottom of the rail. */}
          <img className="rail-gif" src={kriplCodingGif} alt="" aria-hidden="true" />
        </aside>

      </div>

      {settingsOpen && (
        <div className="interaction-backdrop" role="presentation" onClick={() => setSettingsOpen(false)}>
          <section
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-heading">
              <h3>Settings</h3>
              <button
                type="button"
                className="icon-button settings-close"
                title="Close settings"
                onClick={() => setSettingsOpen(false)}
              >
                ×
              </button>
            </div>

            <ContextInspectorCard
              snapshot={contextSnapshot}
              onRetrieve={retrieveMemory}
            />

            <GitStatusCard
              status={gitStatus}
              repository={Boolean(workspace?.gitRepository)}
              onCommit={commitWorkspaceChanges}
            />

            <div className="status-card">
              <span className="eyebrow">Local model server</span>
              <label className="endpoint-field">
                <span>OpenAI-compatible endpoint</span>
                <input
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.target.value)}
                  spellCheck={false}
                  placeholder={DEFAULT_LOCAL_ENDPOINT}
                />
              </label>
              <button
                className="probe-button"
                type="button"
                disabled={probe.status === "checking"}
                onClick={() => void probeModels()}
              >
                {probe.status === "checking" ? "Checking…" : "Connect local server"}
              </button>

              {probe.status === "idle" && <p className="probe-result">Default: LM Studio on port 1234.</p>}
              {probe.status === "error" && <p className="probe-result error">{probe.message}</p>}
              {probe.status === "ready" && probe.models.length === 0 && (
                <p className="probe-result">Server is reachable, but it reports no loaded models.</p>
              )}
              {probe.status === "ready" && probe.models.length > 0 && (
                <>
                  <label className="endpoint-field">
                <span>Context window override (tokens, empty = auto)</span>
                <input
                  value={contextWindowOverride ? String(contextWindowOverride) : ""}
                  onChange={(event) => {
                    const parsed = Number.parseInt(event.target.value, 10);
                    setContextWindowOverride(
                      Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
                    );
                  }}
                  placeholder={String(DEFAULT_CONTEXT_WINDOW)}
                  spellCheck={false}
                />
              </label>
              <p className="probe-result ready">{probe.models.length} local model(s) found.</p>
                  <select
                    className="model-select"
                    value={selectedModel}
                    onChange={(event) => setSelectedModel(event.target.value)}
                  >
                    {probe.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>

            <div className="status-card">
              <span className="eyebrow">Desktop</span>
              <p className="detail">{appInfo ? `${appInfo.name} ${appInfo.version}` : "Loading…"}</p>
              <p className="detail">{appInfo?.platform ?? "—"}</p>
            </div>

            <div className="status-card">
              <span className="eyebrow">Next</span>
              <ol>
                <li>Add local checkpoints/worktree experiments and richer editor ergonomics.</li>
              </ol>
            </div>
          </section>
        </div>
      )}

      <TerminalPanel
        visible={terminalVisible}
        workspaceOpen={Boolean(workspace)}
        workspaceKey={workspace?.path ?? ""}
        onClose={() => setTerminalVisible(false)}
      />

      {interaction && (
        <div className="interaction-backdrop" role="presentation">
          <section className="interaction-dialog" role="dialog" aria-modal="true">
            <span className="eyebrow">Agent permission</span>
            <h3>{interaction.title}</h3>
            {interaction.message && <pre>{interaction.message}</pre>}

            {interaction.kind === "confirm" && (
              <div className="interaction-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void respondToInteraction({ id: interaction.id, confirmed: false })}
                >
                  Block
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void respondToInteraction({ id: interaction.id, confirmed: true })}
                >
                  Allow
                </button>
              </div>
            )}

            {interaction.kind === "select" && (
              <div className="interaction-options">
                {(interaction.options ?? []).map((option) => (
                  <button
                    key={option}
                    className="secondary-button"
                    type="button"
                    onClick={() => void respondToInteraction({ id: interaction.id, value: option })}
                  >
                    {option}
                  </button>
                ))}
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void respondToInteraction({ id: interaction.id, cancelled: true })}
                >
                  Cancel
                </button>
              </div>
            )}

            {(interaction.kind === "input" || interaction.kind === "editor") && (
              <>
                <p className="interaction-note">
                  This interaction type is not exposed by Kripl yet. It is cancelled fail-closed.
                </p>
                <div className="interaction-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void respondToInteraction({ id: interaction.id, cancelled: true })}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}

    </div>
  );
}
