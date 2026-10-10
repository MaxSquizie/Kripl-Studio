import { memo, useState } from "react";
import { CollapsibleDetails } from "./CollapsibleDetails";
import { CopyIconButton, Markdown } from "./Markdown";
import { MessageImages } from "./MessageImages";
import type { FeedItem, MessageItem, ReasoningStep, ToolItem } from "./chat-types";

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}м ${seconds % 60}с` : `${seconds}с`;
}

const ToolDetails = memo(function ToolDetails({ tool, standalone = false }: {
  tool: ToolItem;
  standalone?: boolean;
}) {
  return (
    <CollapsibleDetails
      className={`${standalone ? "tool-card" : "reasoning-tool"} ${tool.phase}`}
      summary={<><span>{tool.name}</span><span>{tool.phase}</span></>}
    >
      {() => tool.preview === undefined ? null : <pre>{tool.preview}</pre>}
    </CollapsibleDetails>
  );
});

const ReasoningSteps = memo(function ReasoningSteps({ steps }: { steps: ReasoningStep[] }) {
  return <>{steps.map((step, index) => step.kind === "thinking"
    ? (step.text.trim() ? <Markdown key={index} text={step.text} /> : null)
    : <ToolDetails key={step.tool.callId} tool={step.tool} />)}</>;
});

interface MessageActions {
  onEdit(id: string | null): void;
  getEditDraft(id: string): string | undefined;
  onEditDraftChange(id: string, text: string): void;
  onResubmit(id: string, text: string): Promise<void>;
  onRegenerate(id: string): Promise<void>;
  onOpenImage(src: string): void;
}

function MessageEditor({ item, onCancel, onSubmit, getEditDraft, onEditDraftChange }: {
  item: MessageItem;
  onCancel(): void;
  onSubmit(id: string, text: string): Promise<void>;
  getEditDraft(id: string): string | undefined;
  onEditDraftChange(id: string, text: string): void;
}) {
  // Editing one message must not re-render the transcript on each keystroke.
  // Its draft survives temporary unmounts when switching tabs / history pages.
  const [value, setValue] = useState(() => getEditDraft(item.id) ?? item.text);
  return (
    <div className="message-edit">
      <textarea
        aria-label="Edit message"
        autoFocus
        value={value}
        onChange={(event) => {
          const text = event.target.value;
          setValue(text);
          onEditDraftChange(item.id, text);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void onSubmit(item.id, value);
          } else if (event.key === "Escape") onCancel();
        }}
      />
      <div className="message-edit-actions">
        <button type="button" className="icon-button" title="Отменить правку (Esc)" onClick={onCancel}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button type="button" className="send-button" title="Отправить заново (Enter)"
          disabled={!value.trim()} onClick={() => void onSubmit(item.id, value)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 19V5m0 0L6 11m6-6l6 6" stroke="currentColor" strokeWidth="2.3"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

const ChatMessage = memo(function ChatMessage({ item, tokps, canRegenerate, editing,
  onEdit, getEditDraft, onEditDraftChange, onResubmit, onRegenerate, onOpenImage }: MessageActions & {
  item: MessageItem;
  tokps: number | undefined;
  canRegenerate: boolean;
  editing: boolean;
}) {
  const hasText = item.text.trim() !== "";
  return (
    <article className={`chat-message ${item.role}`} data-message-id={item.id}>
      <div className="message-role">
        <span className="message-role-left">
          <span>{item.role === "user" ? "You" : item.role === "assistant" ? "Kripl" : "System"}</span>
          {item.role === "assistant" && <span className="message-stats">
            {tokps !== undefined && <span className="message-tokps">{Math.round(tokps)} t/s</span>}
            {hasText && <span className="message-tokens" title="Оценка токенов в сообщении (≈4 символа на токен)">
              ≈{formatTokens(Math.max(1, Math.round(item.text.length / 4)))}
            </span>}
          </span>}
        </span>
        {item.role === "assistant" && <span className="message-actions">
          {hasText && <CopyIconButton text={item.text} title="Скопировать ответ" />}
          {canRegenerate && !item.images?.length && !item.imagePaths?.length && !item.files?.length &&
            <button type="button" className="regenerate-button"
              title="Перегенерировать: удалить этот ответ и запустить промпт заново"
              onClick={() => void onRegenerate(item.id)}>↻</button>}
        </span>}
        {item.role === "user" && <span className="message-actions">
          <button type="button" className="regenerate-button"
            title="Редактировать и отправить заново (хвост диалога будет заменён)"
            onClick={() => onEdit(item.id)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M16.7 3.8a2.3 2.3 0 0 1 3.5 3L8.5 18.5l-4.6 1.3 1.3-4.6L16.7 3.8z"
                stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </span>}
      </div>
      {item.role === "assistant" && item.reasoning &&
        <CollapsibleDetails className="reasoning" bodyClassName="reasoning-body" summary={<>
          <span>Рассуждение</span>
          {item.reasoning.durationMs !== undefined &&
            <span className="reasoning-duration">{formatDuration(item.reasoning.durationMs)}</span>}
          <span className="chevrons" aria-hidden="true">
            <svg className="chevron-down" width="14" height="9" viewBox="0 0 14 9" fill="none">
              <path d="M2 2.5l5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <svg className="chevron-up" width="14" height="9" viewBox="0 0 14 9" fill="none">
              <path d="M2 6.5l5-5 5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </>}>
          {() => <ReasoningSteps steps={item.reasoning!.steps} />}
        </CollapsibleDetails>}
      <MessageImages imagePaths={item.imagePaths} images={item.images} onOpenImage={onOpenImage} />
      {Boolean(item.files?.length) && <div className="message-files">
        {item.files!.map((file, index) => <span key={index} className="file-chip" title={file.path}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 3h8l4 4v14H6V3zM14 3v4h4" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          </svg>{file.name}
        </span>)}
      </div>}
      {editing
        ? <MessageEditor item={item} onCancel={() => onEdit(null)} onSubmit={onResubmit}
            getEditDraft={getEditDraft} onEditDraftChange={onEditDraftChange} />
        : (item.text || (!item.images?.length && !item.imagePaths?.length && !item.files?.length)) &&
          <div className="message-text">{item.text ? <Markdown text={item.text} /> : "…"}</div>}
    </article>
  );
});

/** Stable history rows stay untouched while the current answer streams. */
export const ChatTranscript = memo(function ChatTranscript({ feed, totalCount, hiddenCount,
  liveSteps, lastAssistantId, tokensPerSecond, canSend, editingMessageId, onLoadOlder,
  onEdit, getEditDraft, onEditDraftChange, onResubmit, onRegenerate, onOpenImage }: MessageActions & {
  feed: FeedItem[];
  totalCount: number;
  hiddenCount: number;
  liveSteps: ReasoningStep[] | null;
  lastAssistantId: string | null;
  tokensPerSecond: number | undefined;
  canSend: boolean;
  editingMessageId: string | null;
  onLoadOlder(): void;
}) {
  return <div className="transcript">
    {hiddenCount > 0 && <div className="feed-window-note">
      Показаны последние {feed.length} из {totalCount} сообщений
      <button type="button" onClick={onLoadOlder}>Загрузить ещё {Math.min(150, hiddenCount)}</button>
    </div>}
    {feed.map((item) => item.kind === "message"
      ? <ChatMessage key={item.id} item={item}
          tokps={item.tokps ?? (item.id === lastAssistantId ? tokensPerSecond : undefined)}
          canRegenerate={canSend && item.id === lastAssistantId}
          editing={editingMessageId === item.id}
          getEditDraft={getEditDraft} onEditDraftChange={onEditDraftChange}
          onEdit={onEdit} onResubmit={onResubmit} onRegenerate={onRegenerate} onOpenImage={onOpenImage} />
      : <ToolDetails key={item.callId} tool={item} standalone />)}
    {liveSteps && <CollapsibleDetails className="thinking-card" defaultOpen summary="Рассуждение">
      {() => <ReasoningSteps steps={liveSteps} />}
    </CollapsibleDetails>}
  </div>;
});
