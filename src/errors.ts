/** An error carrying an HTTP status code; rendered by the API error middleware as { error, detail? }. */
export class HttpError extends Error {
  readonly status: number;
  readonly detail?: string;

  constructor(status: number, message: string, detail?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
  }
}

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Like {@link errorMessage}, but unwraps a `cause` chain — the Actual API throws
 * terse errors (`SyncError`, `PostError`) whose useful diagnostics live on the
 * wrapping error we attach at the boundary.
 */
export function errorChainMessage(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current !== undefined && current !== null && parts.length < 5) {
    const message = errorMessage(current);
    // Actual often re-wraps an error whose message already quotes its cause —
    // appending it again would just stutter.
    if (!parts.some((part) => part.includes(message))) {
      parts.push(message);
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(': ');
}
