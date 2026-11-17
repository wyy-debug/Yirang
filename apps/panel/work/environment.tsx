import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { LanguageSetting, useUiLanguage } from '../ui/ui-language.js';
import React, { useState } from 'react';
import { Storage } from '../workspace/storage.js';
import { ConnectedDirectories } from '../workspace/connected-directories.js';
import { ExternalResources } from '../workspace/external-resources.js';
import { FileAiSettings } from '../interaction/file-ai-settings.js';
import { isIntegratedDesktop } from '../workspace/workspace-mode.js';
import type { Workspace } from '../../../packages/contracts/index.js';
import './environment.css';

type Props = {
  workspace: Workspace;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  close: () => void;
};
function SettingDetails({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  useUiLocale();
  const [open, setOpen] = useState(false);
  return (
    <details className="settings-details" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span>
          <strong>{title}</strong>
          <small>{description}</small>
        </span>
        <span className="settings-chevron" aria-hidden="true">
          ›
        </span>
      </summary>
      {open && <div className="settings-details-body">{children}</div>}
    </details>
  );
}
export function Environment({ workspace, action, close }: Props) {
  useUiLanguage();
  return (
    <section
      className="environment-view settings-page"
      aria-label={uiText('设置')}
      data-desktop-overlay
    >
      <div className="settings-scroll">
        <div className="settings-content">
          <header className="settings-heading">
            <button onClick={close}>{uiText('返回桌面')}</button>
            <h2>{uiText('设置')}</h2>
          </header>
          {!isIntegratedDesktop && (
            <>
              <LanguageSetting />
              <FileAiSettings />
            </>
          )}
          <section className="settings-more" aria-labelledby="settings-more-title">
            <h3 id="settings-more-title">{uiText('工作区设置')}</h3>
            <SettingDetails
              title={uiText('本机文件夹')}
              description={uiText('连接文件夹，管理读取与写回权限')}
            >
              <ConnectedDirectories action={action} />
            </SettingDetails>
            <SettingDetails
              title={uiText('网络文件')}
              description={uiText('添加文件链接，管理已连接的文件')}
            >
              <ExternalResources action={action} />
            </SettingDetails>
            <SettingDetails
              title={uiText('存储与历史')}
              description={uiText('查看「{0}」的空间占用与历史版本', { '0': workspace.name })}
            >
              <Storage action={action} />
            </SettingDetails>
          </section>
        </div>
      </div>
    </section>
  );
}
