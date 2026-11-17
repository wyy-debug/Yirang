export function chatProviderMismatch(error) {
  const match = /This chat uses ([\w.-]{1,100}), but your current provider is ([\w.-]{1,100})\. Switch to \1 to continue\./.exec(
    error?.message ?? String(error),
  );
  return match ? { original: match[1], current: match[2] } : null;
}
