// Some bundled app-server versions reject thread/read until the stored session
// has been loaded in this process. This is not evidence that its history is gone.
export async function readRecoverableThread(request, threadId) {
  try {
    return (await request('thread/read', { threadId, includeTurns: false })).thread;
  } catch (error) {
    if (!/thread\s+(?:is\s+)?not\s+loaded\b/i.test(String(error?.message))) throw error;
    return (await request('thread/resume', { threadId, excludeTurns: true })).thread;
  }
}
