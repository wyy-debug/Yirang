export function retryAfterMs(error: unknown, now?: number): number | undefined;
export function retryDelayMs(backoff: number, requested?: number): number;
export function canRetrySubmission(error: unknown): boolean;
