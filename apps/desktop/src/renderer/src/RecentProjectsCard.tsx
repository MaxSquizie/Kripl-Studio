import type { RecentProject } from "@kripl/core";
import { CollapsibleDetails } from "./CollapsibleDetails";

function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface RecentProjectsCardProps {
  projects: RecentProject[];
  currentPath?: string | undefined;
  onOpen(path: string): void;
  onForget(path: string): void;
}

/** Right-rail card for quick switching between recent repositories. */
export function RecentProjectsCard({
  projects,
  currentPath,
  onOpen,
  onForget
}: RecentProjectsCardProps) {
  const ordered = [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);

  return (
    <CollapsibleDetails
      className="status-card recent-projects-card"
      bodyClassName="recent-projects-body"
      defaultOpen
      summary={
        <>
          <span>Projects</span>
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
      {ordered.length === 0 ? (
        <p className="sidebar-note">No recent projects yet.</p>
      ) : (
        <div className="recent-project-list">
          {ordered.map((project) => (
            <div
              key={project.path}
              className={
                "recent-project-row" +
                (currentPath === project.path ? " active" : "")
              }
            >
              <button
                type="button"
                className="recent-project-open"
                title={project.path}
                onClick={() => onOpen(project.path)}
              >
                <span className="recent-project-name">{project.name}</span>
                <span className="recent-project-meta">
                  {formatRelativeTime(project.lastOpenedAt)}
                </span>
              </button>
              <button
                type="button"
                className="icon-button recent-project-forget"
                title="Forget this project"
                onClick={() => onForget(project.path)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </CollapsibleDetails>
  );
}
