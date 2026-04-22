export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export type BatchResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: RpcError };

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jittered = (base: number) => base * (0.5 + Math.random());

function describeCall(body: unknown): string {
  if (Array.isArray(body)) {
    const methods = body
      .map((b) => (b as { method?: string })?.method)
      .filter((m): m is string => Boolean(m));
    const head = methods.slice(0, 4).join(",");
    const tail = methods.length > 4 ? `,+${methods.length - 4}` : "";
    return `batch[${head}${tail}]`;
  }
  const b = body as { method?: string; params?: unknown };
  const method = b?.method ?? "<unknown>";
  const params = b?.params;
  if (Array.isArray(params) && params.length > 0) {
    const rendered = params
      .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
      .join(",");
    const snippet = rendered.length <= 120 ? rendered : rendered.slice(0, 117) + "...";
    return `${method}(${snippet})`;
  }
  return method;
}

export class RpcClient {
  private nextId = 1;
  constructor(public readonly url: string) {}

  async call<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const body = { jsonrpc: "2.0", id: this.nextId++, method, params };
    const json = (await this.postWithRetry(body)) as {
      result?: T;
      error?: { code: number; message: string; data?: unknown };
    };
    if (json.error) throw new RpcError(json.error.code, json.error.message, json.error.data);
    return json.result as T;
  }

  async batch<T = unknown>(
    calls: { method: string; params: unknown[] }[]
  ): Promise<BatchResult<T>[]> {
    if (calls.length === 0) return [];
    const reqs = calls.map((c) => ({
      jsonrpc: "2.0" as const,
      id: this.nextId++,
      method: c.method,
      params: c.params,
    }));
    const raw = (await this.postWithRetry(reqs)) as {
      id: number;
      result?: T;
      error?: { code: number; message: string; data?: unknown };
    }[];
    const byId = new Map(raw.map((r) => [r.id, r]));
    return reqs.map((r): BatchResult<T> => {
      const resp = byId.get(r.id);
      if (!resp) return { ok: false, error: new RpcError(-1, "missing response for batch id") };
      if (resp.error) return { ok: false, error: new RpcError(resp.error.code, resp.error.message, resp.error.data) };
      return { ok: true, result: resp.result as T };
    });
  }

  private async postWithRetry(body: unknown): Promise<unknown> {
    const ctx = describeCall(body);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (RETRYABLE_STATUS.has(res.status)) {
          lastErr = new Error(`HTTP ${res.status} from ${ctx}`);
          if (attempt < MAX_ATTEMPTS) {
            await sleep(jittered(200 * 2 ** (attempt - 1)));
            continue;
          }
          throw lastErr;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${ctx}: ${await res.text()}`);
        return await res.json();
      } catch (e) {
        lastErr = e;
        const err = e as Error;
        const isNet = e instanceof TypeError || err?.name === "AbortError";
        const isHttp = err?.message?.startsWith("HTTP ");
        if (attempt < MAX_ATTEMPTS && (isNet || isHttp)) {
          await sleep(jittered(200 * 2 ** (attempt - 1)));
          continue;
        }
        if (isNet) throw new Error(`${err.message} from ${ctx}`);
        throw e;
      }
    }
    throw lastErr;
  }
}

export function isRangeTooLarge(err: RpcError): boolean {
  if (err.code === -32005 || err.code === -32602 || err.code === -32600) return true;
  const m = err.message.toLowerCase();
  if (m.includes("rate limit") || m.includes("rate-limit") || m.includes("too many requests")) {
    return false;
  }
  return (
    m.includes("range") ||
    m.includes("too large") ||
    m.includes("too many") ||
    m.includes("query timeout") ||
    m.includes("log response size") ||
    m.includes("returned more than")
  );
}

export function isStateOverrideUnsupported(err: RpcError): boolean {
  const m = err.message.toLowerCase();
  return (
    m.includes("state override") ||
    m.includes("stateoverride") ||
    (err.code === -32601 && m.includes("not supported")) ||
    (err.code === -32000 && m.includes("not supported"))
  );
}

export function isHistoricalStateMissing(err: RpcError): boolean {
  const m = err.message.toLowerCase();
  return (
    m.includes("missing trie node") ||
    m.includes("historical state") ||
    m.includes("pruned") ||
    m.includes("archive") ||
    (err.code === -32000 && m.includes("state"))
  );
}
