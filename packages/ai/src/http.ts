import type { ProviderFailure, UnifiedModelEvent } from "./contracts.js";

export class ProviderHttpError extends Error {
  constructor(
    readonly failure: ProviderFailure,
    options?: ErrorOptions
  ) {
    super(failure.message, options);
  }
}

export async function checkedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = (): void => controller.abort();
  externalSignal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text();
      throw new ProviderHttpError(classifyFailure(response.status, body, response.headers));
    }
    return response;
  } catch (error) {
    if (error instanceof ProviderHttpError) throw error;
    if (controller.signal.aborted) {
      throw new ProviderHttpError({
        type: externalSignal?.aborted ? "cancelled" : "timeout",
        message: externalSignal?.aborted ? "Request cancelled" : "Provider request timed out",
        retryable: !externalSignal?.aborted,
        retryAfterMs: null,
        statusCode: null
      });
    }
    throw new ProviderHttpError(
      {
        type: "network",
        message: "Provider network request failed",
        retryable: true,
        retryAfterMs: null,
        statusCode: null
      },
      { cause: error }
    );
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abort);
  }
}

export async function* parseSse(response: Response): AsyncIterable<unknown> {
  if (!response.body) throw new Error("Provider response body is empty");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      yield JSON.parse(data) as unknown;
    }
  }
}

export async function* parseNdjson(response: Response): AsyncIterable<unknown> {
  if (!response.body) throw new Error("Provider response body is empty");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) yield JSON.parse(line) as unknown;
  }
  if (buffer.trim()) yield JSON.parse(buffer) as unknown;
}

export function failureEvent(error: unknown): UnifiedModelEvent {
  if (error instanceof ProviderHttpError) {
    if (error.failure.type === "cancelled") return { type: "cancelled" };
    if (error.failure.type === "rate_limit") {
      return { type: "rate-limit", retryAfterMs: error.failure.retryAfterMs };
    }
    return { type: "failed", failure: error.failure };
  }
  return {
    type: "failed",
    failure: {
      type: "unknown",
      message: error instanceof Error ? error.message : "Unknown provider failure",
      retryable: false,
      retryAfterMs: null,
      statusCode: null
    }
  };
}

function classifyFailure(status: number, body: string, headers: Headers): ProviderFailure {
  const lower = body.toLowerCase();
  const type: ProviderFailure["type"] =
    status === 401
      ? "authentication"
      : status === 403
        ? "authorization"
        : status === 429
          ? lower.includes("quota")
            ? "quota"
            : "rate_limit"
          : status === 404
            ? "model_unavailable"
            : lower.includes("context") && lower.includes("limit")
              ? "context_limit"
              : status >= 500
                ? "provider_outage"
                : status >= 400
                  ? "invalid_request"
                  : "unknown";
  const retryAfter = headers.get("retry-after");
  return {
    type,
    message: `Provider request failed (${status})`,
    retryable: ["rate_limit", "provider_outage", "network", "timeout"].includes(type),
    retryAfterMs: retryAfter ? Number(retryAfter) * 1_000 : null,
    statusCode: status
  };
}
