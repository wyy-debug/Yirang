import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';

// A new operation restarts the timeout, even when its message is identical.
export function useTransientNotice(
  initial = '',
  duration = 4000,
): [string, Dispatch<SetStateAction<string>>] {
  const [notice, setNotice] = useState({ text: initial, sequence: 0 });
  const show = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    setNotice((previous) => ({
      text: typeof value === 'function' ? value(previous.text) : value,
      sequence: previous.sequence + 1,
    }));
  }, []);
  useEffect(() => {
    if (!notice.text) return;
    const timer = setTimeout(
      () =>
        setNotice((current) =>
          current.sequence === notice.sequence ? { ...current, text: '' } : current,
        ),
      duration,
    );
    return () => clearTimeout(timer);
  }, [notice, duration]);
  return [notice.text, show];
}
