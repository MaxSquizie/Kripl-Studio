import type {
  BrowserSnapshot,
  BrowserSnapshotElement,
  BrowserState
} from "@kripl/core";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { BrowserWindow, WebContentsView, session as electronSession } from "electron";

const BROWSER_PARTITION = "persist:kripl-browser";
const ISOLATED_WORLD_ID = 1001;
const TITLEBAR_HEIGHT = 44;
const MIN_BROWSER_WIDTH = 480;
const MAX_BROWSER_WIDTH = 860;

type BrowserStateListener = (state: BrowserState) => void;

function ipv4Parts(address: string): number[] | undefined {
  const parts = address.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return undefined;
  }
  return parts;
}

function isBlockedIpv4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) return true;
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(lower)) return true;
  if (lower.startsWith("ff")) return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isBlockedIpv4(mapped[1] ?? "") : false;
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

function isObviouslyLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".lan") ||
    lower.endsWith(".home") ||
    lower.endsWith(".internal")
  );
}

async function shouldBlockRequestUrl(input: string): Promise<boolean> {
  try {
    const url = new URL(input);
    if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") {
      return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return true;

    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (!hostname || isObviouslyLocalHostname(hostname)) return true;
    if (isIP(hostname)) return isBlockedAddress(hostname);

    try {
      const addresses = await lookup(hostname, { all: true, verbatim: true });
      return addresses.length === 0 || addresses.some((item) => isBlockedAddress(item.address));
    } catch {
      return true;
    }
  } catch {
    return true;
  }
}

async function assertPublicBrowserUrl(input: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid browser URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Browser navigation only supports HTTP(S).");
  }
  if (url.username || url.password) {
    throw new Error("Credential-bearing URLs are not allowed.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname || isObviouslyLocalHostname(hostname)) {
    throw new Error("Local/private browser targets are blocked.");
  }

  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new Error("Local/private browser targets are blocked.");
    return url;
  }

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`Unable to resolve browser host: ${hostname}`);
  }

  if (addresses.length === 0 || addresses.some((item) => isBlockedAddress(item.address))) {
    throw new Error("Browser host resolves to a local/private network address.");
  }

  return url;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /ERR_ABORTED|-3/.test(error.message);
}

function snapshotScript(): string {
  return `(() => {
    for (const element of document.querySelectorAll("[data-kripl-ref]")) {
      element.removeAttribute("data-kripl-ref");
    }

    const isVisible = (element) => {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const roleFor = (element) => {
      const explicit = element.getAttribute("role");
      if (explicit) return explicit;
      const tag = element.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button") return "button";
      if (tag === "textarea") return "textbox";
      if (tag === "select") return "select";
      if (tag === "input") return element.type || "input";
      if (element.isContentEditable) return "textbox";
      return tag;
    };

    const labelFor = (element) => {
      const aria = element.getAttribute("aria-label");
      if (aria) return aria;
      const title = element.getAttribute("title");
      if (title) return title;
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        if (element.placeholder) return element.placeholder;
        if (element.type !== "password" && element.value) return element.value;
      }
      return (element.innerText || element.textContent || "").trim();
    };

    const candidates = Array.from(document.querySelectorAll(
      'a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[contenteditable="true"]'
    )).filter(isVisible).slice(0, 160);

    const elements = candidates.map((element, index) => {
      const ref = "e" + (index + 1);
      element.setAttribute("data-kripl-ref", ref);
      const href = element instanceof HTMLAnchorElement ? element.href : undefined;
      const inputType = element instanceof HTMLInputElement ? element.type : undefined;
      const placeholder =
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.placeholder || undefined
          : undefined;
      return {
        ref,
        role: roleFor(element),
        text: labelFor(element).slice(0, 300),
        ...(href ? { href } : {}),
        ...(inputType ? { inputType } : {}),
        ...(placeholder ? { placeholder } : {})
      };
    });

    return {
      url: location.href,
      title: document.title || "",
      text: (document.body?.innerText || "").replace(/\\n{3,}/g, "\\n\\n").slice(0, 30000),
      elements
    };
  })()`;
}

function clickScript(ref: string): string {
  return `(() => {
    const ref = ${JSON.stringify(ref)};
    const element = Array.from(document.querySelectorAll("[data-kripl-ref]"))
      .find((item) => item.getAttribute("data-kripl-ref") === ref);
    if (!element) throw new Error("Browser element ref is stale. Run browser_snapshot again.");
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    return true;
  })()`;
}

function typeScript(ref: string, text: string, submit: boolean): string {
  return `(() => {
    const ref = ${JSON.stringify(ref)};
    const text = ${JSON.stringify(text)};
    const submit = ${JSON.stringify(submit)};
    const element = Array.from(document.querySelectorAll("[data-kripl-ref]"))
      .find((item) => item.getAttribute("data-kripl-ref") === ref);
    if (!element) throw new Error("Browser element ref is stale. Run browser_snapshot again.");

    element.scrollIntoView({ block: "center", inline: "center" });
    element.focus();

    if (element instanceof HTMLInputElement) {
      if (element.type === "file") throw new Error("File inputs are not supported.");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) throw new Error("Unable to set input value.");
      setter.call(element, text);
    } else if (element instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) throw new Error("Unable to set textarea value.");
      setter.call(element, text);
    } else if (element instanceof HTMLElement && element.isContentEditable) {
      element.textContent = text;
    } else {
      throw new Error("Target element is not editable.");
    }

    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    if (submit) {
      if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.form) {
        element.form.requestSubmit();
      } else {
        element.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          composed: true
        }));
        element.dispatchEvent(new KeyboardEvent("keyup", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          composed: true
        }));
      }
    }

    return true;
  })()`;
}

export class BrowserRuntime {
  private readonly view: WebContentsView;
  private readonly listeners = new Set<BrowserStateListener>();
  private visible = false;
  private loading = false;
  private lastError: string | undefined;
  private redirectGeneration = 0;

  constructor(private readonly window: BrowserWindow) {
    const browserSession = electronSession.fromPartition(BROWSER_PARTITION, { cache: true });
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    browserSession.on("will-download", (event) => event.preventDefault());
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      void shouldBlockRequestUrl(details.url)
        .then((blocked) => callback({ cancel: blocked }))
        .catch(() => callback({ cancel: true }));
    });;

    this.view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        devTools: false,
        allowRunningInsecureContent: false
      }
    });

    this.view.setBackgroundColor("#0d1014");
    this.view.setVisible(false);
    this.window.contentView.addChildView(this.view);
    this.layout();

    const contents = this.view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));

    contents.on("will-navigate", (event, url) => {
      event.preventDefault();
      void this.navigate(url).catch((error) => this.recordError(error));
    });

    contents.on("will-redirect", (event, url) => {
      this.redirectGeneration += 1;
      event.preventDefault();
      void this.navigate(url).catch((error) => this.recordError(error));
    });

    contents.on("did-start-loading", () => {
      this.loading = true;
      this.lastError = undefined;
      this.emit();
    });

    contents.on("did-stop-loading", () => {
      this.loading = false;
      this.emit();
    });

    contents.on("page-title-updated", (_event, _title) => this.emit());
    contents.on("did-navigate", () => this.emit());
    contents.on("did-navigate-in-page", () => this.emit());

    contents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      this.loading = false;
      this.lastError = errorDescription || `Navigation failed (${errorCode}).`;
      this.emit();
    });

    this.window.on("resize", () => this.layout());
  }

  subscribe(listener: BrowserStateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): BrowserState {
    const contents = this.view.webContents;
    const state: BrowserState = {
      visible: this.visible,
      loading: this.loading,
      url: contents.getURL(),
      title: contents.getTitle(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward()
    };
    if (this.lastError) state.error = this.lastError;
    return state;
  }

  setVisible(visible: boolean): BrowserState {
    this.visible = visible;
    this.view.setVisible(visible);
    if (visible) this.layout();
    this.emit();
    return this.getState();
  }

  async navigate(input: string): Promise<BrowserState> {
    const url = await assertPublicBrowserUrl(input);
    this.setVisible(true);
    this.lastError = undefined;
    const redirectGeneration = this.redirectGeneration;

    try {
      await this.view.webContents.loadURL(url.toString());
    } catch (error) {
      if (this.redirectGeneration !== redirectGeneration && isAbortError(error)) {
        return this.getState();
      }
      this.recordError(error);
      throw error;
    }

    return this.getState();
  }

  back(): BrowserState {
    const history = this.view.webContents.navigationHistory;
    if (history.canGoBack()) history.goBack();
    return this.getState();
  }

  forward(): BrowserState {
    const history = this.view.webContents.navigationHistory;
    if (history.canGoForward()) history.goForward();
    return this.getState();
  }

  async snapshot(): Promise<BrowserSnapshot> {
    const result = await this.view.webContents.executeJavaScriptInIsolatedWorld(
      ISOLATED_WORLD_ID,
      [{ code: snapshotScript() }]
    );
    if (!result || typeof result !== "object") {
      throw new Error("Browser snapshot failed.");
    }

    const record = result as Record<string, unknown>;
    const rawElements = Array.isArray(record.elements) ? record.elements : [];
    const elements: BrowserSnapshotElement[] = rawElements
      .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
      .map((value) => {
        const item: BrowserSnapshotElement = {
          ref: typeof value.ref === "string" ? value.ref : "",
          role: typeof value.role === "string" ? value.role : "element",
          text: typeof value.text === "string" ? value.text : ""
        };
        if (typeof value.href === "string") item.href = value.href;
        if (typeof value.inputType === "string") item.inputType = value.inputType;
        if (typeof value.placeholder === "string") item.placeholder = value.placeholder;
        return item;
      })
      .filter((item) => item.ref);

    return {
      url: typeof record.url === "string" ? record.url : this.view.webContents.getURL(),
      title: typeof record.title === "string" ? record.title : this.view.webContents.getTitle(),
      text: typeof record.text === "string" ? record.text.slice(0, 30_000) : "",
      elements
    };
  }

  async click(ref: string): Promise<BrowserState> {
    await this.view.webContents.executeJavaScriptInIsolatedWorld(
      ISOLATED_WORLD_ID,
      [{ code: clickScript(ref) }],
      true
    );
    return this.getState();
  }

  async type(ref: string, text: string, submit = false): Promise<BrowserState> {
    await this.view.webContents.executeJavaScriptInIsolatedWorld(
      ISOLATED_WORLD_ID,
      [{ code: typeScript(ref, text, submit) }],
      true
    );
    return this.getState();
  }

  dispose(): void {
    this.listeners.clear();
    this.window.contentView.removeChildView(this.view);
    if (!this.view.webContents.isDestroyed()) {
      this.view.webContents.close();
    }
  }

  private layout(): void {
    const [width, height] = this.window.getContentSize();
    const browserWidth = Math.min(
      MAX_BROWSER_WIDTH,
      Math.max(MIN_BROWSER_WIDTH, Math.floor(width * 0.52))
    );
    this.view.setBounds({
      x: Math.max(0, width - browserWidth),
      y: TITLEBAR_HEIGHT,
      width: Math.min(browserWidth, width),
      height: Math.max(0, height - TITLEBAR_HEIGHT)
    });
  }

  private recordError(error: unknown): void {
    this.loading = false;
    this.lastError = error instanceof Error ? error.message : String(error);
    this.emit();
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}
