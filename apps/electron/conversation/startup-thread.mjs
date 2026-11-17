// The workspace's primary Bot remains mapped separately from the chat shown at launch.
export function startupThreadCandidates(lastOpened, primary, localDraft) {
  return [...new Set([lastOpened, primary, localDraft, 'new'].filter(Boolean))];
}
