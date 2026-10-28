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

// Plain words for the Meta error codes a publish can end with.
const PLAIN_WORDS: Record<number, string> = {
  4: "Instagram's limit on requests from this app was reached. Localirs waits and tries again.",
  17: "Instagram's limit on requests for this account was reached. Localirs waits and tries again.",
  32: "Instagram's limit on requests for this account was reached. Localirs waits and tries again.",
  613: "Instagram's limit on requests was reached. Localirs waits and tries again.",
  10: "This account has not allowed Localirs to publish. Reconnect it and allow publishing.",
  200: "This account has not allowed Localirs to publish. Reconnect it and allow publishing.",
  100: "Instagram turned the request down as invalid, usually because of the video or the caption.",
  190: "Instagram no longer accepts this account's login. Reconnect it on the Accounts page.",
  368: "Instagram is blocking this action for now. Wait a while before trying again.",
  9004: "Instagram could not download the video.",
  9007: "The video was not ready on Instagram's side when Localirs tried to publish it.",
};

// Why a post failed, for the screens: plain words for a known Meta error code, otherwise the stored message.
export function describePostError(lastError: string | null, errorCode: number | null): string {
  return (errorCode === null ? undefined : PLAIN_WORDS[errorCode]) ?? lastError ?? "Failed for an unknown reason.";
}
