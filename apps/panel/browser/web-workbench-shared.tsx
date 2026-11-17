import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../../../packages/contracts/index.js';
import { WebUrl } from '../../../packages/contracts/web-workspace.js';
import { Icon } from '../ui/icons.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import {
  flushDraftStorage,
  scheduleDraftWrite,
} from '../documents/draft-storage.js';

export type TaskMode = 'browse' | 'capture' | 'fill' | 'compare';
export type WebTaskRequest = {
  pageId: string;
  expectedRevision: number;
  captureId?: string;
  instruction: string;
  formDraftId?: string;
  mode: TaskMode;
};
export type WebWorkbenchProps = {
  workspace: Workspace;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  updated: () => Promise<void>;
  close: () => void;
  openObject: (id: string) => void;
  openUrl: (url: string) => void | Promise<void>;
  runTask: (request: WebTaskRequest) => Promise<boolean>;
  continueTask: (taskId: string) => Promise<boolean>;
  canSend: boolean;
  dirtyChanged?: (dirty: boolean) => void;
};
export type Task = {
  id: string;
  pageId: string;
  objectId: string;
  mode: TaskMode;
  instruction: string;
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  summary?: string;
  captureIds: string[];
  executionRef?: { browser: string; tabId: string; url?: string };
  delivery: 'new' | 'preparing' | 'prepared' | 'claimed' | 'sent' | 'unknown' | 'failed';
  restoredAt?: string;
  cancelled?: boolean;
  reports: { status: string; body: string; at: string }[];
};
export type Pending = { payload: Record<string, unknown>; label: string };
export type Selection = { captureId: string; quote: string; start: number; end: number };
export type Dirty = (key: string, value: boolean) => void;
export type Mutate = (payload: Record<string, unknown>, label: string) => Promise<any | null>;

export const uid = () => crypto.randomUUID(),
  message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const date = (value?: string) =>
  value
    ? new Date(value).toLocaleString(interfaceLocale(), {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
export const domain = (value: string) => {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
};
export const urlFor = (value: string) =>
  WebUrl.parse(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
export function local<T>(key: string, fallback: T): T {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    return value && typeof value === 'object' ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}
export function useDraft<T extends object>(key: string, initial: () => T, dirty: Dirty) {
  const [value, setValue] = useState<T>(() => local(key, initial())),
    data = useRef(value),
    live = useRef(true),
    notify = useRef(dirty);
  notify.current = dirty;
  data.current = value;
  const [storageError, setStorageError] = useState('');
  const change = (next: T | ((previous: T) => T)) => {
    const result = typeof next === 'function' ? (next as (previous: T) => T)(data.current) : next;
    data.current = result;
    setValue(result);
    notify.current(key, true);
    scheduleDraftWrite(
      key,
      () => JSON.stringify(data.current),
      (error) => {
        notify.current(key, !!error);
        if (live.current) setStorageError(error ? uiText('本机草稿存储失败，请保留此页面。') : '');
      },
      700,
    );
  };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      flushDraftStorage(key);
      notify.current(key, false);
    };
  }, [key]);
  return [value, change, storageError] as const;
}
export function Empty({
  icon = 'document',
  title,
  children,
  actions,
}: {
  icon?: 'document' | 'link' | 'comment' | 'tasks' | 'sheet';
  title: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  useUiLocale();
  return (
    <div className="ww-empty">
      <span>
        <Icon name={icon} size={29} />
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {actions && <div className="ww-empty-actions">{actions}</div>}
    </div>
  );
}
