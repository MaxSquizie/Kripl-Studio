import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  detail: string | null;
}

/**
 * Last line of defense for the renderer: a crash during render used to leave
 * a blank window with no clue. Now it shows what threw and offers a reload,
 * and the error is appended to userData/renderer-errors.log in installed
 * builds so field crashes are diagnosable.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, detail: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error, detail: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const detail = [
      `React crash: ${error.message}`,
      info.componentStack ?? "",
      error.stack ?? ""
    ]
      .filter(Boolean)
      .join("\n");
    this.setState({ detail });
    try {
      void window.kripl?.logRendererError(detail);
    } catch {
      // Logging must never mask the original failure.
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash-screen">
        <div className="crash-card">
          <span className="crash-label">Renderer crashed</span>
          <h1>{this.state.error.message || "Unknown rendering error"}</h1>
          {this.state.detail ? <pre>{this.state.detail}</pre> : null}
          <button type="button" onClick={() => window.location.reload()}>
            Reload Kripl Studio
          </button>
        </div>
      </div>
    );
  }
}
