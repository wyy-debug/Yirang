import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { useTransientNotice } from '../ui/use-transient-notice.js';
import React, { useEffect, useRef, useState } from 'react';
import {
  defaultFileAiShortcut,
  fileAiShortcutLabel,
  fileAiShortcutError,
  fileAiMouseShortcut,
  validFileAiShortcut,
  type FileAiShortcut,
} from '../../../packages/components/file-ai-shortcut.js';

export function FileAiSettings() {
  useUiLocale();
  const [shortcut, setShortcut] = useState<FileAiShortcut | null>(null),
    [recording, setRecording] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useTransientNotice(),
    [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null),
    pending = useRef<string | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const post = (value: Record<string, unknown>) => window.parent.postMessage(value, '*');
  const request = () => {
    setError('');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setError(uiText('暂时无法读取快捷键，请重试。')), 4000);
    post({ type: 'ai-desktop:file-ai-config-request' });
  };
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || window.parent === window) return;
      const value = event.data;
      if (value?.type === 'ai-desktop:file-ai-config' && validFileAiShortcut(value.shortcut)) {
        setShortcut(value.shortcut);
        if (!pending.current) {
          clearTimeout(timer.current);
          setError('');
        }
      }
      if (value?.type === 'ai-desktop:file-ai-config-saved' && value.id === pending.current) {
        clearTimeout(timer.current);
        pending.current = null;
        setBusy(false);
        if (validFileAiShortcut(value.shortcut)) setShortcut(value.shortcut);
        if (value.error) {
          setError(String(value.error));
          setNotice('');
        } else {
          setError('');
          setNotice(uiText('已保存，立即生效'));
          setRecording(false);
          input.current?.blur();
        }
      }
    };
    window.addEventListener('message', receive);
    request();
    return () => {
      window.removeEventListener('message', receive);
      clearTimeout(timer.current);
    };
  }, []);
  function save(value: FileAiShortcut) {
    const validation = fileAiShortcutError(value);
    if (validation) {
      setError(validation);
      setNotice('');
      return;
    }
    setError('');
    setNotice('');
    setBusy(true);
    const id = crypto.randomUUID();
    pending.current = id;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pending.current = null;
      setBusy(false);
      setError(uiText('未收到保存确认，请重试。'));
    }, 4000);
    post({ type: 'ai-desktop:file-ai-config-save', id, shortcut: value });
  }
  const capturedMouse = useRef<number | null>(null);
  useEffect(() => {
    const record = (event: PointerEvent) => {
      const value = fileAiMouseShortcut(event);
      if (!recording || busy || !value) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      capturedMouse.current = event.button;
      save(value);
    };
    const suppress = (event: MouseEvent) => {
      if (capturedMouse.current !== event.button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'auxclick') capturedMouse.current = null;
    };
    window.addEventListener('pointerdown', record, true);
    window.addEventListener('mouseup', suppress, true);
    window.addEventListener('auxclick', suppress, true);
    return () => {
      window.removeEventListener('pointerdown', record, true);
      window.removeEventListener('mouseup', suppress, true);
      window.removeEventListener('auxclick', suppress, true);
    };
  }, [recording, busy]);
  return (
    <section className="file-ai-settings" aria-labelledby="file-ai-settings-title">
      <div className="settings-shortcut-row">
        <div>
          <h3 id="file-ai-settings-title">{uiText('文件 AI 快捷键')}</h3>
          <p>{uiText('按下快捷键，再点击桌面上的文件，即可就地提问。')}</p>
        </div>
        <div className="settings-shortcut-controls">
          <input
            ref={input}
            readOnly
            disabled={!shortcut || busy}
            aria-label={uiText('录入文件 AI 快捷键')}
            aria-describedby="shortcut-instruction shortcut-feedback"
            value={
              recording
                ? uiText('按键盘或鼠标侧键…')
                : shortcut
                  ? fileAiShortcutLabel(shortcut)
                  : uiText('正在读取…')
            }
            onFocus={() => {
              setRecording(true);
              setNotice('');
              setError('');
            }}
            onBlur={() => setRecording(false)}
            onKeyDown={(event) => {
              if (event.key === 'Tab') return;
              event.preventDefault();
              event.stopPropagation();
              if (event.key === 'Escape') {
                setRecording(false);
                setError('');
                input.current?.blur();
                return;
              }
              if (
                event.repeat ||
                event.nativeEvent.isComposing ||
                ['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)
              )
                return;
              save({
                code: event.code,
                ctrl: event.ctrlKey,
                alt: event.altKey,
                shift: event.shiftKey,
                meta: event.metaKey,
              });
            }}
          />
          <button disabled={!shortcut || busy} onClick={() => save(defaultFileAiShortcut)}>
            {uiText('恢复默认')}
          </button>
        </div>
      </div>
      <p id="shortcut-instruction" className="settings-shortcut-help">
        {uiText('点击录入框，再按键盘组合键或鼠标侧键，自动保存。默认 Ctrl+Alt+A。')}
      </p>
      <div
        id="shortcut-feedback"
        className="settings-shortcut-feedback"
        role="status"
        aria-live="polite"
        data-error={!!error}
      >
        {error || (busy ? uiText('正在保存…') : recording ? uiText('正在录入 · Esc 取消') : notice)}
        {error && !shortcut && <button onClick={request}>{uiText('重新读取')}</button>}
      </div>
      <div className="settings-interaction-note">
        <p>{uiText('在一壤窗口内生效，按 Esc 可取消选取。')}</p>
        <p>{uiText('连续追问沿用当前对话，关闭浮窗会保留聊天记录和未发送的内容。')}</p>
      </div>
    </section>
  );
}
