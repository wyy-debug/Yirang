import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useState } from 'react';
import type { WorkflowNode } from '../../../packages/contracts/workflows.js';
import { browserCommand } from '../browser/electron-browser-bridge.js';
import { isIntegratedDesktop } from '../workspace/workspace-mode.js';
export function WorkflowPythonEnvironment({
  node,
  change,
}: {
  node: WorkflowNode;
  change: (value: Partial<WorkflowNode['config']>) => void;
}) {
  useUiLocale();
  const [environments, setEnvironments] = useState<{ id: string; name: string }[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    if (!isIntegratedDesktop) return;
    let active = true;
    void browserCommand<{ environments: { id: string; name: string }[] }>('python-environments')
      .then((result) => {
        if (active) setEnvironments(result.environments);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, []);
  if (!isIntegratedDesktop) return null;
  return (
    <>
      <label>
        {uiText('Python 运行环境')}
        <select
          value={node.config.pythonEnvironmentId ?? ''}
          onChange={(event) => change({ pythonEnvironmentId: event.target.value || undefined })}
        >
          <option value="">{uiText('使用桌面默认环境')}</option>
          {environments.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <small>{error || uiText('在对话设置的 Python 环境中登记解释器或创建虚拟环境。')}</small>
    </>
  );
}
