import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React from 'react';
export function WorkflowToolSchema({
  tool,
}: {
  tool?: { available?: boolean; inputSchema?: any; description: string };
}) {
  useUiLocale();
  if (!tool)
    return <p className="error-text">{uiText('当前目录中没有这个工具，请刷新连接后重新选择。')}</p>;
  const schema = tool.inputSchema;
  return (
    <div className="workflow-tool-schema">
      {tool.available === false && (
        <p className="error-text">{uiText('此工具需要登录，当前不能调用。')}</p>
      )}
      <p>{tool.description}</p>
      {schema && (
        <details>
          <summary>
            {uiText('真实参数定义 ·')}
            {(schema.required || []).length} {uiText('项必填')}
          </summary>
          {Object.entries(schema.properties || {}).map(([name, spec]: [string, any]) => (
            <p key={name}>
              <strong>
                {name}
                {schema.required?.includes(name) ? ' *' : ''}
              </strong>{' '}
              · {spec.type || uiText('结构化值')}
              <br />
              {spec.description}
              {spec.enum && uiText(' · 可选：{0}', { '0': spec.enum.join('、') })}
            </p>
          ))}
          <pre>{JSON.stringify(schema, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
