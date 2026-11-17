export const continuationLimits: Readonly<{ attempts: number; activeMs: number; repeatedFailures: number; transportBackoffMs: readonly number[] }>;
export const continuationInstructions: string;
export const completionReviewInstructions: string;
export const executionReviewInstructions: string;
export const nativeFileInstructions: string;
export function remainingRepairMs(continuation: { spentMs: number; grants?: { activeMs: number }[]; reservation?: { allowanceMs: number } }): number;
