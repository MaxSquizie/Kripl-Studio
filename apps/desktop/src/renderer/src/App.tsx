import type { AgentEvent, AttachedFile, AgentInteractionRequest, AgentInteractionResponse, AgentSessionSearchHit, AgentSessionSnapshot, AgentSessionSummary, AgentStatus, ContextInspectorSnapshot, DesktopRuntimeSettings, DesktopUiState, RecentProject, WorkspaceChange, WorkspaceCommitResult, WorkspaceDescriptor, WorkspaceEntry, WorkspaceFilePreview, WorkspaceGitStatus } from "@kripl/core";
import { cleanAssistantToolText } from "@kripl/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChatTranscript } from "./ChatTranscript";
import { SettingsDialog } from "./SettingsDialog";
import { createAgentEventBuffer } from "./agent-event-buffer";
import { createAttachEventCollector } from "./attach-event-collector";
import { toolPayloadPreview } from "./tool-payload-preview";
import { useLatestCallback } from "./useLatestCallback";
import type { FeedItem, MessageItem, ReasoningBlock, ReasoningStep, ToolItem } from "./chat-types";
import type { ClipboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { WorkspaceContent, activeWorkspacePath, type WorkspaceDocumentView, type WorkspaceEditorRevealTarget, type WorkspaceView } from "./WorkspaceContent";
import { WorkspaceTabs, upsertWorkspaceTab, workspaceViewKey } from "./WorkspaceTabs";
import { TerminalPanel } from "./TerminalPanel";
import kriplIcon from "./assets/kripl-icon.png";
import { CollapsibleDetails } from "./CollapsibleDetails";
import { RecentProjectsCard } from "./RecentProjectsCard";
import { WorkspaceSearchPalette, type WorkspaceSearchMode } from "./WorkspaceSearchPalette";
import { CommandPalette, type CommandItem } from "./CommandPalette";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { ToastStack, type ToastItem, type ToastKind } from "./Toasts";

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

// Last known context usage (input + cache-read tokens), restored on start
// so the ring does not flash 0% before the first live usage event arrives.
// Last known context usage per chat. Keyed by session path; brand-new
// chats that have no file yet share the "__current__" slot.
const CHAT_USAGE_KEY = "kripl.contextUsed.byChat";
const NEW_CHAT_USAGE_SLOT = "__current__";

function loadChatUsageMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(CHAT_USAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
}

function loadChatUsage(key: string):
  | { input?: number; output?: number; cacheRead?: number }
  | null {
  let value = Number(loadChatUsageMap()[key]);
  if ((!Number.isFinite(value) || value <= 0) && key === NEW_CHAT_USAGE_SLOT) {
    // One-time fallback to the old global slot.
    const legacy = Number(readStored("kripl.contextUsed.last", ""));
    if (Number.isFinite(legacy) && legacy > 0) value = legacy;
  }
  return Number.isFinite(value) && value > 0 ? { input: value } : null;
}

function rememberChatUsage(key: string, total: number): void {
  try {
    const map = loadChatUsageMap();
    map[key] = total;
    localStorage.setItem(CHAT_USAGE_KEY, JSON.stringify(map));
  } catch {
    // Best-effort.
  }
}

function migrateNewChatUsage(targetPath: string): void {
  try {
    const map = loadChatUsageMap();
    const value = map[NEW_CHAT_USAGE_SLOT];
    if (value !== undefined) {
      delete map[NEW_CHAT_USAGE_SLOT];
      map[targetPath] = value;
      localStorage.setItem(CHAT_USAGE_KEY, JSON.stringify(map));
    }
  } catch {
    // Best-effort.
  }
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

// Append one line to the shared diagnostics.log (userData) for tracing chat
// open/resume paths and main-thread freezes. Fire-and-forget, size-capped.
function diag(tag: string, detail?: unknown): void {
  try {
    const payload =
      detail === undefined ? "" : ` ${JSON.stringify(detail).slice(0, 400)}`;
    void window.kripl?.diagLog(
      `[${new Date().toISOString()}] [renderer] ${tag}${payload}`
    );
  } catch {
    // Diagnostics must never break the UI.
  }
}

// Last agent binding per workspace, so switching back to a project restores
// its chat (and reattaches if that agent is still running in the background).
function loadSavedBindings(): Record<string, AgentBinding> {
  try {
    const raw = localStorage.getItem("kripl.lastBindings");
    return raw ? (JSON.parse(raw) as Record<string, AgentBinding>) : {};
  } catch {
    return {};
  }
}

function rememberAgentBinding(binding: AgentBinding): void {
  try {
    const map = loadSavedBindings();
    map[binding.workspacePath] = binding;
    localStorage.setItem("kripl.lastBindings", JSON.stringify(map));
  } catch {
    // Best-effort.
  }
}

// How many feed items are mounted at once for long sessions. The full feed
// stays in state (search/edit/regenerate still see everything); only the DOM
// is windowed. Mounting thousands of markdown bubbles kills the renderer.
/**
 * The transcript renders in pages of this many messages. Only the newest page
 * is mounted by default; older pages are loaded on demand (one page per click)
 * so huge sessions do not freeze the renderer.
 */
const FEED_PAGE_SIZE = 150;

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

interface ParsedAttachment {
  name: string;
  kind: string;
  path: string;
}

/**
 * Inverse of buildMessageWithAttachments for hydrated sessions: pull the
 * attachment list out of a stored user message, drop the text transcriptions
 * (they are model-facing noise in the UI) and keep only what the user typed.
 */
function parseAttachedFilesBlock(
  text: string
): { displayText: string; files: ParsedAttachment[] } | null {
  if (!text.startsWith("[Attached files]")) return null;
  const lines = text.split("\n");
  let index = 1;
  const files: ParsedAttachment[] = [];
  for (; index < lines.length; index += 1) {
    const match = /^\s*-\s+(.+?)\s+\(([^,)]+),\s*(\w+)\)\s+—\s+(.+)$/.exec(
      lines[index] ?? ""
    );
    if (!match || !match[1] || !match[3] || !match[4]) break;
    files.push({ name: match[1], kind: match[3], path: match[4] });
  }
  if (files.length === 0) return null;

  // Drop the "Content of …" transcription sections, keep the user's text.
  let rest = lines.slice(index).join("\n");
  rest = rest.replace(/Content of [^\n]*:\n```[\s\S]*?\n```/g, "");
  const displayText = rest.replace(/^\s+/, "").trim();
  return { displayText, files };
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


interface AgentBinding {
  workspacePath: string;
  endpoint: string;
  modelId: string;
  sessionPath: string;
  // Runtime id of the live agent process (background agents keep their own).
  agentId?: number;
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
                : fraction >= 0.8
                  ? " warn"
                  : "")
          }
          strokeDasharray={`${circumference * fraction} ${circumference}`}
          transform="rotate(-90 20 20)"
        />
      </svg>
      {limit !== undefined && (
        <span className="token-ring-label">{Math.round(fraction * 100)}%</span>
      )}
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

/** Compact run stopwatch next to the stop button: “45s”, “3m 12s”. */
function formatRunElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
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
  // Mirrored for async waits (e.g. interrupt-then-resend while generating).
  const agentStatusRef = useRef(agentStatus);
  useEffect(() => {
    agentStatusRef.current = agentStatus;
  }, [agentStatus]);
  const [agentError, setAgentError] = useState("");
  const [binding, setBinding] = useState<AgentBinding | null>(null);
  // Mirrored for the one-shot agent event subscription (background filter).
  const bindingAgentIdRef = useRef<number | null>(null);
  // Storage key for this chat's persisted context usage.
  const chatUsageKeyRef = useRef<string>(NEW_CHAT_USAGE_SLOT);
  useLayoutEffect(() => {
    bindingAgentIdRef.current = binding?.agentId ?? null;
    chatUsageKeyRef.current = binding?.sessionPath || NEW_CHAT_USAGE_SLOT;
  }, [binding]);
  const [composerText, setComposerText] = useState("");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  // User message being edited for a resend (replaces it and everything after).
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  // Preserve one draft across transcript unmounts without rendering App on each key.
  const editDraftRef = useRef<{ id: string; text: string } | null>(null);
  useLayoutEffect(() => {
    if (editDraftRef.current?.id !== editingMessageId) editDraftRef.current = null;
  }, [editingMessageId]);
  const [renameValue, setRenameValue] = useState("");
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  // path -> data URL preview (images and PDFs) for the composer chips
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
  const [pdfPreviewPath, setPdfPreviewPath] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [usage, setUsage] =
    useState<
      { input?: number; output?: number; cacheRead?: number } | null
    >(() => loadChatUsage(NEW_CHAT_USAGE_SLOT));
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  // Chats whose agent is still running (possibly in the background).
  const [liveSessionPaths, setLiveSessionPaths] = useState<Set<string>>(new Set());
  // Projects that currently have a running agent (snake indicator on rows).
  const [liveProjectPaths, setLiveProjectPaths] = useState<Set<string>>(new Set());
  // Full-text search across saved chats.
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionHits, setSessionHits] = useState<AgentSessionSearchHit[]>([]);
  // The search box is hidden behind the magnifier in the Sessions header.
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);

  const [windowMaximized, setWindowMaximized] = useState(false);
  const [contextWindowOverride, setContextWindowOverride] = useState(() => {
    const raw = readStored("kripl.contextWindow", "");
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  });
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const streamBufferRef = useRef<ReturnType<typeof createAgentEventBuffer> | null>(null);
  // A run attached midway may have emitted text before this renderer subscribed.
  const reconcileTranscriptOnReadyRef = useRef(false);
  // Live reasoning timeline (text + tool calls in order) shown while the agent
  // is still working; folded into the answer bubble once it appears.
  const [liveSteps, setLiveSteps] = useState<ReasoningStep[] | null>(null);
  const [interaction, setInteraction] = useState<AgentInteractionRequest | null>(null);
  // Tokens-per-second for the current turn (shown next to KRIPL).
  const turnStartRef = useRef<number | null>(null);
  // Wall-clock start of the current run (for the composer stopwatch).
  const runStartedAtRef = useRef<number | null>(null);
  const [runElapsed, setRunElapsed] = useState(0);
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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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
  const conversationContentRef = useRef<HTMLDivElement | null>(null);
  const scrollAnchorRef = useRef<{ top: number; height: number } | null>(null);
  const lastScrollRef = useRef({ top: 0, height: 0 });
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // Bumped on every workspace hydration; in-flight async flows (resume /
  // start / hydrate) abort their state writes when a newer switch wins.
  const switchSeqRef = useRef(0);
  // In-flight resumeSession promises per session path: a double click (or the
  // auto-start effect racing a manual click) must not start two agents for
  // the same chat — the second call joins the first instead.
  const resumingPathsRef = useRef(
    new Map<string, { promise: Promise<void>; at: number }>()
  );

  // The input grows with the text up to ~3x its base height, then scrolls.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    const capped = Math.min(el.scrollHeight, 156);
    el.style.height = `${capped}px`;
    el.style.overflowY = el.scrollHeight > 156 ? "auto" : "hidden";
  }, [composerText]);
  const nearBottomRef = useRef(true);
  const seenFeedLengthRef = useRef(0);
  const [pendingMessages, setPendingMessages] = useState(0);
  // True while the user is scrolled away from the bottom (shows the pill).
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  // Huge sessions (thousands of messages) crash the renderer when every
  // bubble is mounted at once; render a tail window by default.
  /** How many older messages are currently hidden above the visible window. */
  const [feedHidden, setFeedHidden] = useState(0);

  // Transient top-right notifications (file saved, model probe, …).
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Right-click action menu for chat / project rows.
  const [rowMenu, setRowMenu] = useState<ContextMenuState | null>(null);
  const toastIdRef = useRef(0);

  function pushToast(kind: ToastKind, message: string) {
    const id = ++toastIdRef.current;
    setToasts((current) => [...current.slice(-3), { id, kind, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 4000);
  }

  function dismissToast(id: number) {
    setToasts((current) => current.filter((item) => item.id !== id));
  }

  // Ctrl+K command palette.
  const [paletteOpen, setPaletteOpen] = useState(false);
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

    const applyLiveAgents = (
      live: Array<{ sessionPath?: string; workspacePath?: string; running: boolean }>
    ): void => {
      setLiveSessionPaths(
        new Set(live.map((item) => item.sessionPath).filter((path): path is string => Boolean(path)))
      );
      setLiveProjectPaths(
        new Set(
          live
            .map((item) => item.workspacePath)
            .filter((path): path is string => Boolean(path))
        )
      );
    };
    const unsubscribeLive = window.kripl.onAgentLiveChanged((live) => {
      if (!disposed) applyLiveAgents(live);
    });
    void window.kripl.listLiveAgents().then((live) => {
      if (!disposed) applyLiveAgents(live);
    });
    const unsubscribeWindowMaximized = window.kripl.onWindowMaximized((maximized) => {
      if (!disposed) setWindowMaximized(maximized);
    });

    return () => {
      disposed = true;
      unsubscribeContext();
      unsubscribeSessionsChanged();
      unsubscribeLive();
      unsubscribeWindowMaximized();
    };
  }, []);

  // Reconnect to the local model server used in the previous run.
  useEffect(() => {
    void probeModels();
  }, []);

  const refreshSessions = useLatestCallback(async () => {
    const seq = switchSeqRef.current;
    if (!workspace) {
      setSessions([]);
      return;
    }
    try {
      const next = await window.kripl.listAgentSessions();
      if (switchSeqRef.current === seq) setSessions(next);
    } catch {
      if (switchSeqRef.current === seq) setSessions([]);
    }
  });

  // Keep the session picker in sync with the workspace's Pi session catalog.
  useEffect(() => {
    void refreshSessions();
  }, [workspace?.path]);

  // Mark renderer (re)mounts: any gap before this line in diagnostics.log
  // means the previous renderer process died and main reloaded it.
  useEffect(() => {
    diag("app mounted", { workspace: workspace?.path ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Report freezes without scanning the entire DOM during an overloaded frame.
  useEffect(() => {
    let observer: PerformanceObserver | null = null;
    let lastReport = -Infinity;
    try {
      observer = new PerformanceObserver((list) => {
        const now = performance.now();
        if (now - lastReport < 5000) return;
        lastReport = now;
        const entries = list.getEntries();
        diag("longtask", {
          ms: Math.round(Math.max(...entries.map((entry) => entry.duration))),
          count: entries.length
        });
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // Long-task tracing is optional.
    }
    return () => observer?.disconnect();
  }, []);

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

  // Debounced session search; empty results while the query is too short.
  useEffect(() => {
    const query = sessionQuery.trim();
    if (!workspace || query.length < 2) {
      setSessionHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.kripl
        .searchAgentSessions(query)
        .then((hits) => {
          if (!cancelled) setSessionHits(hits);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sessionQuery, workspace]);

  // Ctrl+K toggles the command palette (works without a workspace too).
  useEffect(() => {
    function onCommandKey(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setPaletteOpen((open) => !open);
    }

    window.addEventListener("keydown", onCommandKey);
    return () => window.removeEventListener("keydown", onCommandKey);
  }, []);

  // Tick the composer stopwatch once a second while the run is live.
  useEffect(() => {
    if (agentStatus !== "running" && agentStatus !== "stopping") return;
    const startedAt = runStartedAtRef.current;
    if (startedAt === null) return;
    const tick = (): void =>
      setRunElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [agentStatus]);

  // Keep the tail bounded during a live session too, not only on hydration.
  // Loading older messages preserves the current reading position.
  useLayoutEffect(() => {
    const el = conversationRef.current;
    if (!el) return;
    const anchor = scrollAnchorRef.current;
    if (anchor) {
      el.scrollTop = anchor.top + el.scrollHeight - anchor.height;
      lastScrollRef.current = { top: el.scrollTop, height: el.scrollHeight };
      scrollAnchorRef.current = null;
    } else if (nearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      lastScrollRef.current = { top: el.scrollTop, height: el.scrollHeight };
      seenFeedLengthRef.current = feed.length;
      setPendingMessages(0);
      setFeedHidden(Math.max(0, feed.length - FEED_PAGE_SIZE));
    } else if (feed.length > seenFeedLengthRef.current) {
      setPendingMessages(feed.length - seenFeedLengthRef.current);
    }
  }, [feed.length, feedHidden, workspaceView.type, binding?.sessionPath, binding?.agentId]);

  // A single size observer covers streamed text, image decode and resizing.
  // No subtree mutation walk or repeated synchronous layout on every token.
  useEffect(() => {
    const el = conversationRef.current;
    const content = conversationContentRef.current;
    if (!el || !content) return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (!nearBottomRef.current || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (nearBottomRef.current) {
          el.scrollTop = el.scrollHeight;
          lastScrollRef.current = { top: el.scrollTop, height: el.scrollHeight };
        }
      });
    });
    observer.observe(content);
    observer.observe(el);
    if (nearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      lastScrollRef.current = { top: el.scrollTop, height: el.scrollHeight };
    }
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [workspace?.path, workspaceView.type]);

  const handleAgentEvent = useLatestCallback((rawEvent: AgentEvent) => {
      // Drop events from other (background) agent runtimes.
      const event = rawEvent as AgentEvent & { agentId?: number };
      const boundId = bindingAgentIdRef.current;
      if (
        boundId !== null &&
        typeof event.agentId === "number" &&
        event.agentId !== boundId
      ) {
        return;
      }
      if (event.type === "agent.status") {
        diag("agentStatus", { status: event.status, agentId: event.agentId });
        setAgentStatus(event.status);
        if (event.status === "running" && runStartedAtRef.current === null) {
          runStartedAtRef.current = Date.now();
          setRunElapsed(0);
        }
        if (event.status !== "running" && event.status !== "stopping") {
          runStartedAtRef.current = null;
        }
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
          steps[steps.length - 1] = { ...last, text: last.text + event.delta };
        } else {
          // Completed without deltas: fill the block in once.
          const last = steps[steps.length - 1];
          if (last && last.kind === "thinking" && last.text === "") {
            steps[steps.length - 1] = { ...last, text: event.content };
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
        setFeed((current) => {
          // The streaming answer is normally the tail item; do not visit the
          // entire history or recreate unchanged message objects per token.
          const index = current.findLastIndex((item) => item.kind === "message" && item.id === targetId);
          const item = current[index];
          if (!item || item.kind !== "message") return current;
          const text = event.phase === "delta" ? item.text + event.delta : (item.text || event.content);
          if (text === item.text) return current;
          const next = current.slice();
          next[index] = { ...item, text };
          return next;
        });
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
        const usedTotal = (next.input ?? 0) + (next.cacheRead ?? 0);
        if (usedTotal > 0) rememberChatUsage(chatUsageKeyRef.current, usedTotal);
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
          ...(event.payload === undefined ? {} : { preview: toolPayloadPreview(event.payload) })
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

  useEffect(() => {
    const buffer = createAgentEventBuffer(
      handleAgentEvent,
      (flush) => window.requestAnimationFrame(flush),
      (frame) => window.cancelAnimationFrame(frame)
    );
    streamBufferRef.current = buffer;
    const unsubscribe = window.kripl.onAgentEvent((event) => {
      const boundId = bindingAgentIdRef.current;
      const sourceId = (event as AgentEvent & { agentId?: number }).agentId;
      if (sourceId !== undefined && sourceId !== boundId) return;
      buffer.push(event);
    });
    return () => {
      unsubscribe();
      buffer.clear();
      streamBufferRef.current = null;
    };
  }, [handleAgentEvent]);

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
  const visibleFeed = useMemo(() => {
    // Never hide more than everything except the newest page; if messages get
    // removed (regenerate / session switch) the window widens automatically.
    const hidden = Math.min(feedHidden, Math.max(0, feed.length - FEED_PAGE_SIZE));
    return hidden === 0 ? feed : feed.slice(hidden);
  }, [feed, feedHidden]);
  const lastAssistantId = useMemo(() => {
    for (let index = feed.length - 1; index >= 0; index -= 1) {
      const item = feed[index];
      if (item && item.kind === "message" && item.role === "assistant") return item.id;
    }
    return null;
  }, [feed]);
  const tokenUsageUsed = usage ? (usage.input ?? 0) + (usage.cacheRead ?? 0) : 0;

  // One toast per run when the context window crosses 90%.
  const contextWarnedRef = useRef(false);
  useEffect(() => {
    if (!contextWindowLimit || contextWindowLimit <= 0) return;
    const fraction = tokenUsageUsed / contextWindowLimit;
    if (fraction >= 0.9 && !contextWarnedRef.current) {
      contextWarnedRef.current = true;
      pushToast(
        "info",
        `Context is ${Math.round(fraction * 100)}% used — consider starting a new chat.`
      );
    }
    if (fraction < 0.75) contextWarnedRef.current = false;
  }, [tokenUsageUsed, contextWindowLimit]);

  // Command palette entries, rebuilt when the relevant state changes.
  const paletteItems = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [];

    if (agentStatus === "running" || agentStatus === "stopping") {
      items.push({ id: "stop", label: "Stop agent", hint: "run", run: () => void abortAgent() });
    } else if (canStartAgent) {
      items.push({ id: "new-session", label: "New session", hint: "agent", run: () => void startAgent() });
    }

    items.push(
      { id: "open-project", label: "Open project…", hint: "workspace", run: () => void openWorkspace() },
      {
        id: "terminal",
        label: terminalVisible ? "Hide terminal" : "Show terminal",
        hint: "view",
        run: () => setTerminalVisible((visible) => !visible)
      },
      { id: "settings", label: "Open settings", hint: "view", run: () => setSettingsOpen(true) },
      {
        id: "shortcuts",
        label: "Keyboard shortcuts",
        hint: "view",
        run: () => setShortcutsOpen(true)
      },
      { id: "probe", label: "Probe local model server", hint: "model", run: () => void probeModels() }
    );

    if (workspace) {
      items.push(
        { id: "search-files", label: "Search files", hint: "Ctrl+P", run: () => setWorkspaceSearchMode("files") },
        { id: "search-text", label: "Search text", hint: "Ctrl+Shift+F", run: () => setWorkspaceSearchMode("text") },
        { id: "refresh-sessions", label: "Refresh sessions", hint: "sessions", run: () => void refreshSessions() }
      );
    }

    for (const project of recentProjects) {
      if (project.path === workspace?.path) continue;
      items.push({
        id: `switch-${project.path}`,
        label: `Switch to ${project.name}`,
        hint: "project",
        run: () => void openRecentProject(project.path)
      });
    }

    const resumable = [...sessions]
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .slice(0, 8);
    for (const session of resumable) {
      items.push({
        id: `resume-${session.path}`,
        label: `Resume chat: ${session.name && session.name !== basename(session.path) ? session.name : session.firstMessage ?? basename(session.path)}`,
        hint: "session",
        run: () => void resumeSession(session.path)
      });
    }

    return items;
  }, [agentStatus, canStartAgent, workspace, terminalVisible, recentProjects, sessions]);

  // Auto-reconnect: when a workspace becomes active (app start or project
  // switch), rebind its last chat if the server/model selection still matches.
  const autoStartedWorkspaces = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!workspace || !modelReady) return;
    if (autoStartedWorkspaces.current.has(workspace.path)) return;
    // Crash-reload backstop: the in-memory set above resets on every renderer
    // reload, so a fatal auto-resume would otherwise repeat forever. Remember
    // when we last auto-started this workspace and skip it for 10 minutes.
    const lastAutoStart = Number(
      readStored(`kripl.autoStarted.${workspace.path}`, "0")
    );
    if (Date.now() - lastAutoStart < 10 * 60_000) {
      diag("autoStart skipped", {
        reason: "guard",
        remainingMs: 10 * 60_000 - (Date.now() - lastAutoStart)
      });
      autoStartedWorkspaces.current.add(workspace.path);
      return;
    }
    // Never auto-start over a live run or an existing binding for this
    // workspace: modelReady can re-evaluate mid-generation (e.g. after a
    // probe), and restarting here would clobber the active feed.
    const alreadyBound =
      Boolean(binding) && binding?.workspacePath === workspace.path;
    if (
      alreadyBound ||
      agentStatus === "running" ||
      agentStatus === "stopping"
    ) {
      diag("autoStart skipped", {
        reason: alreadyBound ? "already bound" : `agent ${agentStatus}`
      });
      autoStartedWorkspaces.current.add(workspace.path);
      return;
    }
    const saved = loadSavedBindings()[workspace.path];
    // A stale server/model selection must not auto-start the wrong runtime.
    if (saved && (saved.endpoint !== endpoint || saved.modelId !== selectedModel)) {
      diag("autoStart skipped", { reason: "model mismatch" });
      return;
    }
    autoStartedWorkspaces.current.add(workspace.path);
    writeStored(`kripl.autoStarted.${workspace.path}`, String(Date.now()));
    // Resume this project's last chat, or open a fresh session so the
    // composer is never left dead after a project switch.
    diag("autoStart firing", { sessionPath: saved?.sessionPath ?? null });
    if (saved?.sessionPath) void resumeSession(saved.sessionPath);
    else void startAgent();
  }, [workspace, modelReady, agentStatus, binding]);

  const dirtyEditorPaths = useMemo(() => {
    const dirty = new Set<string>();
    for (const tab of workspaceTabs) {
      if (tab.type !== "file" || tab.file.binary || tab.file.truncated) continue;
      const draft = editorDrafts[tab.file.path] ?? tab.file.content ?? "";
      if (draft !== (tab.file.content ?? "")) dirty.add(tab.file.path);
    }
    return dirty;
  }, [editorDrafts, workspaceTabs]);

  // Release composer previews when attachments leave it. Late reads from a
  // previous selection must not refill the cache after sending or switching.
  useEffect(() => {
    let cancelled = false;
    const paths = new Set(attachments.map((file) => file.path));
    setAttachmentPreviews((current) => {
      const entries = Object.entries(current).filter(([path]) => paths.has(path));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
    for (const file of attachments) {
      if (file.error || attachmentPreviews[file.path]) continue;
      if (file.kind !== "image" && !file.name.toLowerCase().endsWith(".pdf")) continue;
      void window.kripl.readAttachPreview(file.path).then((result) => {
        if (!cancelled && result.ok && result.dataUrl) {
          const dataUrl = result.dataUrl;
          setAttachmentPreviews((current) => ({ ...current, [file.path]: dataUrl }));
        }
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [attachments]);


  async function disconnectAgent() {
    await window.kripl.stopAgent();
    setAgentStatus("stopped");
    bindingAgentIdRef.current = null;
    setBinding(null);
    assistantMessageId.current = null;
  }

  function hydrateSessionSnapshot(snapshot: AgentSessionSnapshot) {
    streamBufferRef.current?.clear();
    diag("hydrate begin", { messages: snapshot.messageCount });
    const t0 = Date.now();
    const restored: FeedItem[] = snapshot.messages
      .filter((message) => message.role !== "tool")
      .map((message) => {
        if (message.role === "user") {
          // Stored prompts carry the attachment block; restore chips and
          // hide the model-facing transcriptions.
          const parsed = parseAttachedFilesBlock(message.text);
          if (parsed) {
            const imagePaths = parsed.files
              .filter((file) => file.kind === "image")
              .map((file) => file.path);
            const files = parsed.files
              .filter((file) => file.kind !== "image")
              .map((file) => ({ name: file.name, path: file.path }));
            return {
              kind: "message" as const,
              id: crypto.randomUUID(),
              role: "user" as const,
              text: parsed.displayText,
              ...(imagePaths.length > 0 ? { imagePaths } : {}),
              ...(files.length > 0 ? { files } : {})
            };
          }
        }
        return {
          kind: "message" as const,
          id: crypto.randomUUID(),
          role:
            message.role === "user"
              ? ("user" as const)
              : message.role === "assistant"
                ? ("assistant" as const)
                : ("system" as const),
          text: message.text
        };
      });

    diag("hydrate mapped", {
      restored: restored.length,
      ms: Date.now() - t0
    });
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
    // Large restored sessions start at the newest page; older ones load on demand.
    setFeedHidden(Math.max(0, restored.length - FEED_PAGE_SIZE));
    setLiveSteps(null);
    assistantMessageId.current = null;
    diag("hydrate done", {
      feed: restored.length,
      totalMs: Date.now() - t0
    });

  }

  const syncActiveSessionFromRuntime = useLatestCallback(async () => {
    const seq = switchSeqRef.current;
    const agentId = bindingAgentIdRef.current;
    const runIds = runAssistantIdsRef.current;
    const reconcileTranscript = reconcileTranscriptOnReadyRef.current;
    const streamedOwnRun = runIds.size > 0 && !reconcileTranscript;
    try {
      const snapshot = streamedOwnRun
        ? await window.kripl.getAgentSessionInfo()
        : await window.kripl.getAgentSessionSnapshot();
      if (!snapshot || switchSeqRef.current !== seq || bindingAgentIdRef.current !== agentId) return;
      if (!streamedOwnRun && runAssistantIdsRef.current === runIds &&
          (reconcileTranscript || runIds.size === 0) && "messages" in snapshot) {
        hydrateSessionSnapshot(snapshot as AgentSessionSnapshot);
        reconcileTranscriptOnReadyRef.current = false;
      }
      const persistedPath = snapshot.sessionFile;
      if (persistedPath) {
        const hadNoPath = !binding?.sessionPath;
        setBinding((current) => current ? { ...current, sessionPath: persistedPath } : current);
        if (hadNoPath) migrateNewChatUsage(persistedPath);
      }
    } catch {
      // Metadata refresh must not interrupt the live UI.
    }
  });

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
    const seq = ++switchSeqRef.current;
    const stale = () => switchSeqRef.current !== seq;

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
      if (stale()) return;
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

    if (stale()) return;
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
    bindingAgentIdRef.current = null;
    setBinding(null);
    setEditingMessageId(null);
    reconcileTranscriptOnReadyRef.current = false;
    scrollAnchorRef.current = null;
    setAgentStatus("idle");
    streamBufferRef.current?.clear();
    setFeed([]);
    setAttachments([]);
    setPdfPreviewPath(null);
    setFeedHidden(0);
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
    try {
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
      pushToast("success", `Saved ${basename(path)}`);
    } catch (error) {
      pushToast(
        "error",
        error instanceof Error ? error.message : "Failed to save file"
      );
    }
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
      pushToast("error", result.error ?? "Local model server unreachable");
      return;
    }

    setEndpoint(result.endpoint);
    setProbe({ status: "ready", models: result.models });
    pushToast(
      "success",
      result.models.length > 0
        ? `${result.models.length} local model(s) found`
        : "Local server reachable, no loaded models"
    );
    setSelectedModel((current) => {
      if (result.models.some((model) => model.id === current)) return current;
      return result.models[0]?.id ?? "";
    });
  }

  async function startAgent(resumeSessionPath?: string) {
    if (!workspace || !modelReady || !selectedModel) {
      diag("startAgent skipped", {
        reason: !workspace
          ? "no workspace"
          : !modelReady
            ? "model not ready"
            : "no model selected",
        sessionPath: resumeSessionPath ?? null
      });
      return;
    }
    const seq = ++switchSeqRef.current;
    bindingAgentIdRef.current = null;
    setBinding(null);
    setEditingMessageId(null);
    reconcileTranscriptOnReadyRef.current = false;
    scrollAnchorRef.current = null;
    nearBottomRef.current = true;
    setAwayFromBottom(false);
    discardTurnActivity();

    setAgentError("");
    setAgentStatus("starting");
    setInteraction(null);
    runStartedAtRef.current = null;
    setRunElapsed(0);
    streamBufferRef.current?.clear();
    setFeed([]);
    setAttachments([]);
    setPdfPreviewPath(null);
    setFeedHidden(0);
    setLiveSteps(null);
    // Keep the last known context usage visible until live events replace it.
    // Restore this chat's last known context usage until live events arrive.
    setUsage(loadChatUsage(resumeSessionPath ?? NEW_CHAT_USAGE_SLOT));
    assistantMessageId.current = null;

    const t0 = Date.now();
    diag("startAgent ipc begin", { sessionPath: resumeSessionPath ?? null });
    const result = await window.kripl.startAgent({
      endpoint,
      modelId: selectedModel,
      ...(resumeSessionPath ? { sessionPath: resumeSessionPath } : {})
    });
    // A newer workspace switch won while we were starting — drop the result.
    if (switchSeqRef.current !== seq) return;
    diag("startAgent ipc done", {
      ok: result.ok,
      error: result.error ?? null,
      ms: Date.now() - t0
    });

    if (!result.ok) {
      setAgentStatus("error");
      setAgentError(result.error ?? "Failed to start Pi agent.");
      bindingAgentIdRef.current = null;
      setBinding(null);
      return;
    }

    const tSnap = Date.now();
    const snapshot = await window.kripl
      .getAgentSessionSnapshot()
      .catch((error) => {
        diag("startAgent snapshot failed", { error: String(error) });
        return null;
      });
    if (switchSeqRef.current !== seq) return;
    if (snapshot) {
      diag("startAgent snapshot fetched", {
        messages: snapshot.messageCount,
        ms: Date.now() - tSnap
      });
      hydrateSessionSnapshot(snapshot);
    }

    const nextBinding: AgentBinding = {
      workspacePath: workspace.path,
      endpoint,
      modelId: selectedModel,
      sessionPath: resumeSessionPath ?? "",
      ...(typeof result.agentId === "number" ? { agentId: result.agentId } : {})
    };
    bindingAgentIdRef.current = nextBinding.agentId ?? null;
    setBinding(nextBinding);
    rememberAgentBinding(nextBinding);
    setAgentStatus("ready");
    void refreshSessions();
  }

  /**
   * Switch to a saved chat. If its agent is still running in the background,
   * rebind without restarting; otherwise start it fresh.
   */
  function resumeSession(sessionPath: string): Promise<void> {
    const inFlight = resumingPathsRef.current.get(sessionPath);
    if (inFlight && Date.now() - inFlight.at < 15_000) {
      diag("resumeSession deduped (already opening)", { sessionPath });
      return inFlight.promise;
    }
    const run = doResumeSession(sessionPath).finally(() => {
      resumingPathsRef.current.delete(sessionPath);
    });
    resumingPathsRef.current.set(sessionPath, { promise: run, at: Date.now() });
    return run;
  }

  async function doResumeSession(sessionPath: string): Promise<void> {
    if (!workspace || !modelReady || !selectedModel) {
      diag("resumeSession skipped", {
        reason: !workspace
          ? "no workspace"
          : !modelReady
            ? "model not ready"
            : "no model selected",
        sessionPath
      });
      return;
    }
    const seq = ++switchSeqRef.current;
    bindingAgentIdRef.current = null;
    setBinding(null);
    setEditingMessageId(null);
    reconcileTranscriptOnReadyRef.current = false;
    scrollAnchorRef.current = null;
    nearBottomRef.current = true;
    setAwayFromBottom(false);
    setAgentStatus("starting");
    setAgentError("");
    setInteraction(null);
    setFeed([]);
    setFeedHidden(0);
    setAttachments([]);
    setPdfPreviewPath(null);
    discardTurnActivity();
    assistantMessageId.current = null;
    runStartedAtRef.current = null;
    setRunElapsed(0);
    const t0 = Date.now();
    diag("resumeSession start", { sessionPath, feed: feed.length });

    // Preserve control state while the feed is unbound. A background run can
    // finish or ask for permission while attach or its snapshot is in flight.
    // The snapshot owns transcript data; only the selected runtime's pending
    // interaction and latest status/notification are restored after hydration.
    const controls = createAttachEventCollector();
    const stopCollecting = window.kripl.onAgentEvent((event) => {
      controls.push(event);
    });
    try {
      const attached = await window.kripl.attachAgent(sessionPath);
      if (switchSeqRef.current !== seq) return;
      diag("attach result", {
        ok: attached.ok,
        agentId: attached.agentId,
        status: attached.status,
        ms: Date.now() - t0
      });
      if (attached.ok && typeof attached.agentId === "number") {
        const targetId = attached.agentId;
        const latestStatus = () => controls.forAgent(targetId).status?.status ?? attached.status ?? "ready";
        const statusBeforeSnapshot = latestStatus();
        const tSnap = Date.now();
        let snapshot = await window.kripl.getAgentSessionSnapshot();
        if (switchSeqRef.current !== seq) return;
        if ((statusBeforeSnapshot === "running" || statusBeforeSnapshot === "stopping") &&
            latestStatus() === "ready") {
          // A completed message may have been persisted after the first read.
          snapshot = await window.kripl.getAgentSessionSnapshot();
          if (switchSeqRef.current !== seq) return;
        }
        if (!snapshot) throw new Error("The active session changed while opening. Select the chat again.");
        diag("snapshot fetched", {
          messages: snapshot.messageCount,
          ms: Date.now() - tSnap
        });
        hydrateSessionSnapshot(snapshot);
        setUsage(loadChatUsage(sessionPath));

        const pendingControls = controls.forAgent(targetId);
        const status = pendingControls.status?.status ?? attached.status ?? "ready";
        reconcileTranscriptOnReadyRef.current = status === "running" || status === "stopping";
        const nextBinding: AgentBinding = {
          workspacePath: workspace.path,
          endpoint,
          modelId: selectedModel,
          sessionPath,
          agentId: targetId
        };
        bindingAgentIdRef.current = targetId;
        setBinding(nextBinding);
        rememberAgentBinding(nextBinding);
        setAgentStatus(status);
        setInteraction(pendingControls.interaction ?? null);
        setAgentError(pendingControls.errorText ?? (status === "error" ? "Pi agent failed." : ""));
        if (status === "running" || status === "stopping") runStartedAtRef.current = Date.now();
        void refreshSessions();
        diag("resumeSession done (attached)", { ms: Date.now() - t0 });
        return;
      }
    } catch (error) {
      if (switchSeqRef.current === seq) {
        setAgentStatus("error");
        setAgentError(error instanceof Error ? error.message : String(error));
      }
      return;
    } finally {
      stopCollecting();
    }

    diag("resumeSession falling back to fresh agent.start", {
      sessionPath,
      ms: Date.now() - t0
    });
    await startAgent(sessionPath);
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

  // Download a saved chat as a Markdown file.
  async function exportSessionMarkdown(session: AgentSessionSummary) {
    const snapshot = await window.kripl.exportAgentSession(session.path);
    if (!snapshot || snapshot.messages.length === 0) {
      pushToast("error", "Nothing to export in this chat yet.");
      return;
    }
    const title =
      session.name && session.name !== basename(session.path)
        ? session.name
        : (session.firstMessage?.slice(0, 60) ?? basename(session.path));

    const lines: string[] = [`# ${title}`, ""];
    for (const message of snapshot.messages) {
      if (message.role === "user") {
        lines.push("## User", "", message.text, "");
      } else if (message.role === "assistant") {
        lines.push("## Assistant", "", message.text, "");
      } else {
        const suffix = [message.toolName ?? "tool", message.isError ? "(error)" : ""]
          .filter(Boolean)
          .join(" ");
        lines.push(`### ${suffix}`, "", message.text, "");
      }
    }

    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${title.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 64) || "session"}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    pushToast("success", `Exported “${title}” as Markdown`);
  }

  async function deleteSession(session: AgentSessionSummary): Promise<void> {
    const result = await window.kripl.deleteAgentSession(session.path);
    if (!result.ok) {
      pushToast("error", "Не удалось удалить чат.");
      return;
    }
    // If the deleted chat was open, reset the agent UI for a clean restart.
    if (binding?.sessionPath === session.path) {
      bindingAgentIdRef.current = null;
      setBinding(null);
      discardTurnActivity();
      assistantMessageId.current = null;
      runStartedAtRef.current = null;
      setAgentStatus("idle");
      streamBufferRef.current?.clear();
      setFeed([]);
      setAttachments([]);
      setPdfPreviewPath(null);
      setFeedHidden(0);
    }
    pushToast("success", "Чат удалён.");
    void refreshSessions();
  }

  function openSessionMenu(event: ReactMouseEvent, session: AgentSessionSummary): void {
    event.preventDefault();
    setRowMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          label: "Переименовать",
          run: () => {
            const current =
              session.name && session.name !== basename(session.path)
                ? session.name
                : "";
            setRenamingPath(session.path);
            setRenameValue(current);
          }
        },
        { label: "Экспортировать в Markdown", run: () => void exportSessionMarkdown(session) },
        {
          label: "Удалить чат",
          danger: true,
          run: () => void deleteSession(session)
        }
      ]
    });
  }

  function openProjectMenu(event: ReactMouseEvent, project: RecentProject): void {
    event.preventDefault();
    setRowMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          label: "Убрать из списка",
          danger: true,
          run: () => void forgetRecentProject(project.path)
        }
      ]
    });
  }

  async function commitSessionRename(path: string) {
    const name = renameValue.trim();
    setRenamingPath(null);
    const result = await window.kripl.renameAgentSession(path, name);
    if (!result.ok) {
      pushToast("error", result.error ?? "Failed to rename session.");
      return;
    }
    pushToast("success", `Renamed to “${name}”`);
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
    streamBufferRef.current?.clear();
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
      (file) => !file.error && file.kind === "image"
    );
    const otherFiles = attachments
      .filter((file) => !file.error && file.kind !== "image")
      .map((file) => ({ name: file.name, path: file.path }));
    // The chat shows only what the user typed; attachment metadata is
    // still sent to the model in `finalText`.
    const userMessage: MessageItem = {
      kind: "message",
      id: crypto.randomUUID(),
      role: "user",
      text: text,
      ...(imageFiles.length > 0
        ? { imagePaths: imageFiles.map((file) => file.path) }
        : {}),
      ...(otherFiles.length > 0 ? { files: otherFiles } : {})
    };

    setFeed((current) => [...current, userMessage]);
    setComposerText("");
    setAttachments([]);
    setAgentError("");
    assistantMessageId.current = null;

    // A fresh prompt always pulls the view back to the bottom.
    nearBottomRef.current = true;
    setAwayFromBottom(false);

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
    if (
      !userMessage ||
      (userMessage.images && userMessage.images.length > 0) ||
      (userMessage.imagePaths && userMessage.imagePaths.length > 0) ||
      (userMessage.files && userMessage.files.length > 0)
    )
      return;

    discardTurnActivity();
    setFeed((current) => current.slice(0, index)); // keep the prompt, drop the answer
    assistantMessageId.current = null;
    nearBottomRef.current = true;
    setAwayFromBottom(false);

    const directive = `${userMessage.text}\n\n[Regenerate] Your previous answer to this message was discarded by the user. Produce a fresh answer.`;
    const result = await window.kripl.sendAgentMessage(directive);
    if (!result.ok) {
      setAgentStatus("error");
      setAgentError(result.error ?? "Prompt was rejected.");
    }
  }


  /**
   * Edit & resend: replace the user message with the new text, drop everything
   * after it, and send. Attachment metadata from the original prompt is not
   * restored — only the edited text goes out.
   */
  // Poll the mirrored status until the runtime reports ready again.
  function waitForAgentReady(timeoutMs = 15_000): Promise<boolean> {
    if (agentStatusRef.current === "ready") return Promise.resolve(true);
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const timer = window.setInterval(() => {
        const ready = agentStatusRef.current === "ready";
        if (ready || Date.now() - startedAt > timeoutMs) {
          window.clearInterval(timer);
          resolve(ready);
        }
      }, 100);
    });
  }

  async function resubmitEdited(id: string, newText: string): Promise<void> {
    const trimmed = newText.trim();
    if (!trimmed || !binding) return;
    setEditingMessageId(null);
    discardTurnActivity();

    // Editing interrupts an in-flight run and restarts it right away.
    if (agentStatusRef.current === "running" || agentStatusRef.current === "stopping") {
      await window.kripl.abortAgent();
      const ready = await waitForAgentReady();
      if (!ready) {
        setAgentError("Агент не вернулся в готовность после прерывания.");
        return;
      }
    }

    setFeed((current) => {
      const index = current.findIndex((item) => item.kind === "message" && item.id === id);
      if (index < 0) return current;
      return [
        ...current.slice(0, index),
        { kind: "message", id: crypto.randomUUID(), role: "user", text: trimmed }
      ];
    });

    assistantMessageId.current = null;
    nearBottomRef.current = true;
    setAwayFromBottom(false);

    const result = await window.kripl.sendAgentMessage(trimmed);
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

  const resubmitMessage = useLatestCallback(resubmitEdited);
  const regenerateMessage = useLatestCallback(regenerateAnswer);
  const editMessage = useLatestCallback((id: string | null) => {
    if (editDraftRef.current?.id !== id) editDraftRef.current = null;
    setEditingMessageId(id);
  });
  const getEditDraft = useLatestCallback((id: string) =>
    editDraftRef.current?.id === id ? editDraftRef.current.text : undefined);
  const changeEditDraft = useLatestCallback((id: string, text: string) => {
    editDraftRef.current = { id, text };
  });
  const loadOlderMessages = useLatestCallback(() => {
    const el = conversationRef.current;
    if (!el) return;
    scrollAnchorRef.current = { top: el.scrollTop, height: el.scrollHeight };
    nearBottomRef.current = false;
    setAwayFromBottom(true);
    setFeedHidden((current) => Math.max(0, current - FEED_PAGE_SIZE));
  });

  const startSessionAction = useLatestCallback(() => startAgent());
  const resumeSessionAction = useLatestCallback(resumeSession);
  const renameSessionAction = useLatestCallback(commitSessionRename);
  const openSessionMenuAction = useLatestCallback(openSessionMenu);
  const openProjectMenuAction = useLatestCallback(openProjectMenu);
  const openRecentProjectAction = useLatestCallback(openRecentProject);
  const openWorkspaceAction = useLatestCallback(openWorkspace);
  const refreshWorkspaceAction = useLatestCallback(refreshWorkspace);
  const toggleDirectoryAction = useLatestCallback(toggleDirectory);
  const openFileAction = useLatestCallback(openWorkspaceFile);
  const openDiffAction = useLatestCallback(openWorkspaceDiff);
  const showTerminalAction = useLatestCallback(() => setTerminalVisible(true));
  const hideTerminalAction = useLatestCallback(() => setTerminalVisible(false));
  const showSettingsAction = useLatestCallback(() => setSettingsOpen(true));
  const hideSettingsAction = useLatestCallback(() => setSettingsOpen(false));
  const showShortcutsAction = useLatestCallback(() => setShortcutsOpen(true));
  const selectAgentAction = useLatestCallback(() => selectWorkspaceView({ type: "agent" }));
  const selectWorkspaceViewAction = useLatestCallback(selectWorkspaceView);
  const closeWorkspaceTabAction = useLatestCallback(closeWorkspaceTab);
  const updateEditorDraftAction = useLatestCallback(updateEditorDraft);
  const saveWorkspaceFileAction = useLatestCallback(saveWorkspaceFile);
  const stageWorkspaceChangeAction = useLatestCallback(stageWorkspaceChange);
  const unstageWorkspaceChangeAction = useLatestCallback(unstageWorkspaceChange);
  const revertWorkspaceChangeAction = useLatestCallback(revertWorkspaceChange);
  const probeModelsAction = useLatestCallback(probeModels);
  const retrieveMemoryAction = useLatestCallback(retrieveMemory);
  const commitWorkspaceChangesAction = useLatestCallback(commitWorkspaceChanges);
  const applyRuntimeSettingsAction = useLatestCallback(async (next: DesktopRuntimeSettings) => {
    const saved = await window.kripl.saveRuntimeSettings(next);
    setRuntimeSettings(saved);
  });
  const sortedSessions = useMemo(() => [...sessions].sort((a, b) => b.modifiedAt - a.modifiedAt), [sessions]);
  const sessionRail = useMemo(() => (
        <aside className="session-rail">
          <CollapsibleDetails
            className="status-card session-card"
            bodyClassName="sessions-body"
            defaultOpen
            summary={
              <span className="session-heading">
                <span className="eyebrow">Sessions</span>
                <button
                  className={"icon-button session-search-toggle" + (sessionSearchOpen ? " active" : "")}
                  type="button"
                  title={sessionSearchOpen ? "Hide chat search" : "Search across chats"}
                  onClick={(event) => {
                    event.preventDefault(); // do not toggle the panel
                    const next = !sessionSearchOpen;
                    if (!next) setSessionQuery("");
                    setSessionSearchOpen(next);
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
                    <path
                      d="M15.3 15.3L20 20"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
                <span className="session-heading-actions">
                  <button
                    className="icon-button"
                    type="button"
                    title="New session"
                    disabled={!canStartAgent}
                    onClick={(event) => {
                      event.preventDefault(); // do not toggle the panel
                      void startSessionAction();
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
                {sessionSearchOpen && (
                  <input
                    className="session-search"
                    value={sessionQuery}
                    placeholder="Поиск по чатам…"
                    spellCheck={false}
                    autoFocus
                    onChange={(event) => setSessionQuery(event.target.value)}
                  />
                )}
                {sessionSearchOpen && sessionQuery.trim().length >= 2 ? (
                  sessionHits.length === 0 ? (
                    <p className="sidebar-note">Ничего не найдено.</p>
                  ) : (
                    <div className="session-list">
                      {sessionHits.map((hit, index) => (
                        <button
                          key={`${hit.sessionPath}-${index}`}
                          type="button"
                          className="session-hit"
                          title={hit.snippet}
                          onClick={() => void resumeSessionAction(hit.sessionPath)}
                        >
                          <span className="session-name">
                            {hit.sessionName ?? basename(hit.sessionPath)}
                          </span>
                          <span className="session-meta">
                            {hit.role === "user" ? "вы" : hit.role === "assistant" ? "Kripl" : "tool"} ·{" "}
                            {hit.snippet}
                          </span>
                        </button>
                      ))}
                    </div>
                  )
                ) : (
                  <>
                {sessions.length === 0 && (
                  <p className="sidebar-note">No saved chats yet for this project.</p>
                )}
                <div className="session-list">
                  {sortedSessions.map((session) => (
                      <div
                        key={session.path}
                        className={
                          "session-row" +
                          (binding?.sessionPath === session.path ? " active" : "") +
                          (liveSessionPaths.has(session.path) ? " live" : "")
                        }
                        onContextMenu={(event) => openSessionMenuAction(event, session)}
                      >
                        <button
                          type="button"
                          className="session-resume"
                          disabled={!canStartAgent}
                          title={`Resume ${session.name ?? basename(session.path)}`}
                          onClick={() => void resumeSessionAction(session.path)}
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
                              if (event.key === "Enter") void renameSessionAction(session.path);
                              else if (event.key === "Escape") setRenamingPath(null);
                            }}
                          />
                        ) : null}
                      </div>
                    ))}
                </div>
                  </>
                )}
              </>
            )}
          </CollapsibleDetails>

          <RecentProjectsCard
            projects={recentProjects}
            livePaths={liveProjectPaths}
            currentPath={workspace?.path}
            onOpen={(path) => void openRecentProjectAction(path)}
            onContextMenu={(project, event) => openProjectMenuAction(event, project)}
          />

        </aside>
  ), [workspace, modelReady, selectedModel, canStartAgent, binding?.sessionPath,
    sessions, sortedSessions, sessionSearchOpen, sessionQuery, sessionHits, renamingPath,
    renameValue, liveSessionPaths, liveProjectPaths, recentProjects, startSessionAction,
    resumeSessionAction, renameSessionAction, openSessionMenuAction, openProjectMenuAction,
    openRecentProjectAction, refreshSessions]);

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

      {paletteOpen && (
        <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />
      )}

      <div className="workspace">
        <WorkspaceSidebar
          workspace={workspace}
          entries={workspaceEntries}
          expanded={expandedDirectories}
          changes={workspaceChanges}
          activePath={activeWorkspacePath(workspaceView)}
          onOpenWorkspace={openWorkspaceAction}
          onRefresh={refreshWorkspaceAction}
          onToggleDirectory={toggleDirectoryAction}
          onOpenFile={openFileAction}
          onOpenDiff={openDiffAction}
          terminalOpen={terminalVisible}
          onSelectTerminal={showTerminalAction}
          onCloseTerminal={hideTerminalAction}
          onOpenSettings={showSettingsAction}
          onShowShortcuts={showShortcutsAction}
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
            // File.path is gone in modern Electron; resolve via webUtils.
            const paths = Array.from(event.dataTransfer.files)
              .map((file) => window.kripl.dropFilePath(file))
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
            onSelectAgent={selectAgentAction}
            onSelect={selectWorkspaceViewAction}
            onClose={closeWorkspaceTabAction}
          />

          {workspaceView.type === "agent" ? (
            <>

          <div
            className="conversation"
            ref={conversationRef}
            onScroll={() => {
              const el = conversationRef.current;
              if (!el) return;
              const top = el.scrollTop;
              const height = el.scrollHeight;
              const previous = lastScrollRef.current;
              const nearBottom = top + el.clientHeight >= height - 60;
              // Browser anchoring also emits scroll while streamed content
              // grows or a live reasoning block collapses. Only upward motion
              // without a content shrink should release an existing bottom pin.
              const movedUp = top < previous.top - 1 && height >= previous.height;
              const pinned = nearBottom || (nearBottomRef.current && !movedUp);
              lastScrollRef.current = { top, height };
              nearBottomRef.current = pinned;
              setAwayFromBottom(!pinned);
              if (pinned) {
                seenFeedLengthRef.current = feed.length;
                setPendingMessages(0);
                setFeedHidden(Math.max(0, feed.length - FEED_PAGE_SIZE));
              }
            }}
          >
            <div className="conversation-content" ref={conversationContentRef}>
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
              <ChatTranscript
                feed={visibleFeed}
                totalCount={feed.length}
                hiddenCount={feed.length - visibleFeed.length}
                liveSteps={liveSteps}
                lastAssistantId={lastAssistantId}
                tokensPerSecond={tokensPerSecond}
                canSend={canSend}
                editingMessageId={editingMessageId}
                onLoadOlder={loadOlderMessages}
                onEdit={editMessage}
                getEditDraft={getEditDraft}
                onEditDraftChange={changeEditDraft}
                onResubmit={resubmitMessage}
                onRegenerate={regenerateMessage}
                onOpenImage={setLightboxSrc}
              />
            )}

            {agentError && <div className="agent-error">{agentError}</div>}
            </div>

            {/* Sticky anchor: pins the pill to the visible bottom while the
                user is scrolled up, sits at content end otherwise. */}
            <div className="jump-anchor">
              {(pendingMessages > 0 || awayFromBottom) && (
                <button
                  type="button"
                  className="jump-to-bottom"
                  title="К последним сообщениям"
                  onClick={() => {
                    const el = conversationRef.current;
                    if (!el) return;
                    nearBottomRef.current = true;
                    setAwayFromBottom(false);
                    setPendingMessages(0);
                    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M12 5v13m0 0l-5.5-5.5M12 18l5.5-5.5"
                      stroke="currentColor"
                      strokeWidth="2.1"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {pendingMessages > 0 && (
                    <span className="jump-count">{pendingMessages}</span>
                  )}
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
              ref={composerRef}
              disabled={!canSend}
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
                <>
                  <span className="run-timer" title="Run time">
                    {formatRunElapsed(runElapsed)}
                  </span>
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
                </>
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
              onDraftChange={updateEditorDraftAction}
              onSaveFile={saveWorkspaceFileAction}
              onStage={stageWorkspaceChangeAction}
              onUnstage={unstageWorkspaceChangeAction}
              onRevert={revertWorkspaceChangeAction}
            />
          )}
        </main>

        {sessionRail}

      </div>

      {shortcutsOpen && (
        <div
          className="interaction-backdrop"
          role="presentation"
          onClick={() => setShortcutsOpen(false)}
        >
          <section
            className="shortcuts-dialog"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <span>Keyboard shortcuts</span>
              <button
                type="button"
                className="icon-button"
                title="Close"
                onClick={() => setShortcutsOpen(false)}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" strokeWidth="1.2" />
                </svg>
              </button>
            </header>
            <div className="shortcuts-list">
              {[
                ["Ctrl+K", "Command palette (actions, projects, chats)"],
                ["Ctrl+P", "Search files in the workspace"],
                ["Ctrl+Shift+F", "Search text across files"],
                ["Enter", "Send message"],
                ["Shift+Enter", "New line in the composer"],
                ["Esc", "Close dialogs, cancel rename"],
                ["Drag & drop", "Drop files anywhere on the chat to attach"]
              ].map(([keys, label]) => (
                <div key={keys} className="shortcut-row">
                  <span className="shortcut-keys">{keys}</span>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {settingsOpen && (
        <SettingsDialog
          endpoint={endpoint}
          onEndpointChange={setEndpoint}
          defaultEndpoint={DEFAULT_LOCAL_ENDPOINT}
          probe={probe}
          onProbe={probeModelsAction}
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          contextWindowOverride={contextWindowOverride}
          onContextWindowOverrideChange={setContextWindowOverride}
          defaultContextWindow={DEFAULT_CONTEXT_WINDOW}
          contextSnapshot={contextSnapshot}
          onRetrieveMemory={retrieveMemoryAction}
          gitStatus={gitStatus}
          workspace={workspace}
          onCommit={commitWorkspaceChangesAction}
          appInfo={appInfo}
          runtimeSettings={runtimeSettings}
          onApplyRuntimeSettings={applyRuntimeSettingsAction}
          onClose={hideSettingsAction}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      <ContextMenu state={rowMenu} onClose={() => setRowMenu(null)} />

      <TerminalPanel
        visible={terminalVisible}
        workspaceOpen={Boolean(workspace)}
        workspaceKey={workspace?.path ?? ""}
        onClose={hideTerminalAction}
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
