import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { useWorkspaceRefresh, retainEqual } from '../workspace/workspace-refresh.js';
import React, { useEffect, useState } from 'react';
import type { ObjectActivity } from '../../../packages/contracts/object-activity.js';
export function useObjectActivity(
  workspaceId: string | undefined,
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>,
) {
  const cursor = useWorkspaceRefresh(workspaceId, 'activity');
  const [entries, setEntries] = useState<Record<string, ObjectActivity>>({});
  useEffect(() => {
    setEntries({});
  }, [workspaceId]);
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    const timer = setTimeout(() => {
      void action('object_activity')
        .then((next) => {
          if (live)
            setEntries((previous) => {
              const merged: typeof previous = {};
              for (const [id, value] of Object.entries(next) as [string, ObjectActivity][]) {
                const old = previous[id];
                merged[id] = old && JSON.stringify(old) === JSON.stringify(value) ? old : value;
              }
              return retainEqual(previous, merged);
            });
        })
        .catch(() => {});
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [workspaceId, cursor]);
  return entries;
}
export function ActivityBadge({ activity, open }: { activity?: ObjectActivity; open: () => void }) {
  useUiLocale();
  if (!activity) return null;
  return (
    <button
      className="object-activity-badge nodrag nopan"
      onClick={open}
      title={uiText('{0}\n{1} · 最近记录，非实时进程监控\n点击查看版本与来源', {
        '0': activity.label,
        '1': new Date(activity.at).toLocaleString(interfaceLocale()),
      })}
    >
      <span /> {activity.label}
    </button>
  );
}
export function AiActivityBadge({ label }: { label: string }) {
  useUiLocale();
  return (
    <div
      className="object-activity-badge object-ai-activity"
      role="status"
      aria-label={label}
      title={label}
    >
      <span />
      {label}
    </div>
  );
}
