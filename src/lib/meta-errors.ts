const RETRYABLE_CODES = new Set([4, 17, 32, 613]);
const INVALID_TOKEN_CODE = 190;

export class MetaApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

export type ErrorClass = "retry" | "reauth" | "fail";

export function classifyMetaError(err: unknown): ErrorClass {
  if (err instanceof MetaApiError) {
    if (err.code === INVALID_TOKEN_CODE) return "reauth";
    if (err.status >= 500 || (err.code !== undefined && RETRYABLE_CODES.has(err.code))) return "retry";
    return "fail";
  }
  if (err instanceof TypeError) return "retry";
  return "fail";
}
