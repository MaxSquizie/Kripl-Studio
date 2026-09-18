import type { RecentProject } from "@kripl/core";

export function RecentProjectsCard({
  projects,
  currentPath,
  onOpen,
  onForget
}: {
  projects: RecentProject[];
  currentPath?: string;
  onOpen(path: string): void;
  onForget(path: string): void;
}) {
  if (projects.length === 0) return null;

  return (
    <div className="status-card recent-projects-card">
      <span className="eyebrow">Recent projects</span>
      <div className="recent-projects-list">
        {projects.slice(0, 6).map((project) => (
          <div
            className={"recent-project-row" + (project.path === currentPath ? " current" : "")}
            key={project.path}
          >
            <button
              className="recent-project-open"
              type="button"
              onClick={() => onOpen(project.path)}
              title={project.path}
              disabled={project.path === currentPath}
            >
              <strong>{project.name}</strong>
              <span>{project.path}</span>
            </button>
            <button
              className="recent-project-forget"
              type="button"
              onClick={() => onForget(project.path)}
              title="Forget project"
              aria-label={"Forget " + project.name}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
