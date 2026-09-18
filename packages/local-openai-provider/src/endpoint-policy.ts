const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "::1"]);

export class NonLocalEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonLocalEndpointError";
  }
}

export function normalizeLocalOpenAIBaseUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new NonLocalEndpointError("Local model endpoint is empty.");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NonLocalEndpointError("Local model endpoint is not a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NonLocalEndpointError("Local model endpoint must use http or https.");
  }

  if (url.username || url.password) {
    throw new NonLocalEndpointError("Credentials are not allowed in the local model endpoint URL.");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost") {
    url.hostname = "127.0.0.1";
  } else if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new NonLocalEndpointError(
      `Endpoint host "${url.hostname}" is not loopback. Kripl Studio offline mode only allows localhost inference.`
    );
  }

  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";

  let pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname || pathname === "/") pathname = "/v1";
  url.pathname = pathname;

  return url.toString().replace(/\/$/, "");
}

export function localModelsUrl(baseUrl: string): string {
  return new URL("models", `${normalizeLocalOpenAIBaseUrl(baseUrl)}/`).toString();
}
