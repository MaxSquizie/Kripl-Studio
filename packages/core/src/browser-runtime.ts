export interface BrowserState {
  visible: boolean;
  loading: boolean;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}

export interface BrowserSnapshotElement {
  ref: string;
  role: string;
  text: string;
  href?: string;
  inputType?: string;
  placeholder?: string;
}

export interface BrowserHistoryEntry {
  url: string;
  title: string;
  at: number;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  text: string;
  elements: BrowserSnapshotElement[];
}

export interface ToolBridgeConnection {
  baseUrl: string;
  token: string;
}
