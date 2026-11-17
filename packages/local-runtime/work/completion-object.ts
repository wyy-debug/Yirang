import type { DesktopObject } from '../../contracts/index.js';

// Deletion during inspection is missing evidence, not a failed finish transaction.
// Storage and programming errors must still surface instead of being swallowed.
export function completionObject(read: () => DesktopObject): DesktopObject | undefined {
  try { return read(); }
  catch (error) {
    if ((error as { code?: string })?.code === 'NOT_FOUND') return undefined;
    throw error;
  }
}
