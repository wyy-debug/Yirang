import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { useTransientNotice } from '../ui/use-transient-notice.js';
import React, { useEffect, useState } from 'react';
import './external-resources.css';
type Action = (name: string, payload?: Record<string, unknown>) => Promise<any>;
export function ExternalResources({ action }: { action: Action }) {
  useUiLocale();
  const [items, setItems] = useState<any[]>([]),
    [name, setName] = useState(''),
    [url, setUrl] = useState(''),
    [privateNetwork, setPrivateNetwork] = useState(false),
    [duration, setDuration] = useState('hour'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useTransientNotice();
  const call = (command: any) =>
    action('native_workbench', { operation: 'external_resources', command });
  async function load() {
    setItems(await call({ operation: 'list' }));
  }
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
  }, []);
  async function run(command: any, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await call(command);
      await load();
      setNotice(message);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="external-resources">
      <section>
        <h2>{uiText('添加链接')}</h2>
        <p>
          {uiText(
            '使用无需登录的直链，单个文件最多 20 MB。添加后即可读取并导入。',
          )}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              {
                operation: 'connect',
                name,
                url,
                duration,
                privateNetworkAuthorized: privateNetwork,
              },
              uiText('链接已添加，还没有下载。点击「读取并导入」获取文件。'),
            );
          }}
        >
          <label className="resource-name">
            {uiText('名称')}
            <input
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="resource-link">
            {uiText('文件链接')}
            <input
              required
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/report.pdf"
              maxLength={2048}
            />
          </label>
          <label className="resource-duration">
            {uiText('有效期')}
            <select value={duration} onChange={(e) => setDuration(e.target.value)}>
              <option value="hour">{uiText('一小时')}</option>
              <option value="persistent">{uiText('直到移除')}</option>
            </select>
          </label>
          <label className="resource-check">
            <input
              type="checkbox"
              checked={privateNetwork}
              onChange={(e) => setPrivateNetwork(e.target.checked)}
            />
            {uiText('允许访问本机或局域网地址（包括 http:// 链接）')}
          </label>
          <button className="resource-submit" disabled={busy || !name.trim() || !url.trim()}>
            {uiText('添加链接')}
          </button>
        </form>
        <div className="resource-list">
          {items.map((item) => (
            <article key={item.id}>
              <strong>{item.name}</strong>
              <p className="resource-url">{item.url}</p>
              <small>
                {item.expired
                  ? uiText('链接已过期')
                  : item.expiresAt
                    ? uiText('有效至 {0}', {
                        '0': new Date(item.expiresAt).toLocaleString(interfaceLocale()),
                      })
                    : uiText('直到移除')}{' '}
                {uiText('· 只读')}
                {item.privateNetworkAuthorized ? uiText(' · 允许访问本机或局域网') : ''}
              </small>
              {item.lastReadAt && (
                <p>
                  {uiText('上次读取：')}
                  {new Date(item.lastReadAt).toLocaleString(interfaceLocale())}
                </p>
              )}
              {item.desktopChanged && (
                <p>
                  {uiText(
                    '桌面上的这份文件已被修改。直接读取会提示冲突；选择「采用网络版本」会覆盖它，原来的内容保留在历史版本中。',
                  )}
                </p>
              )}
              <div className="resource-actions">
                <button
                  disabled={busy || item.expired}
                  onClick={() =>
                    void run(
                      { operation: 'pull', resourceId: item.id, requestId: crypto.randomUUID() },
                      item.objectId
                        ? uiText('已读取最新内容，并更新了桌面上的文件。')
                        : uiText('网络文件已导入桌面。'),
                    )
                  }
                >
                  {item.objectId ? uiText('读取最新内容') : uiText('读取并导入')}
                </button>
                {item.desktopChanged && (
                  <button
                    disabled={busy || item.expired}
                    onClick={() =>
                      void run(
                        {
                          operation: 'pull',
                          resourceId: item.id,
                          expectedDesktopHash: item.currentDesktopHash,
                          requestId: crypto.randomUUID(),
                        },
                        uiText('已采用网络版本，原来的内容保留在历史版本中。'),
                      )
                    }
                  >
                    {uiText('采用网络版本')}
                  </button>
                )}
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(
                      { operation: 'revoke', resourceId: item.id },
                      uiText('链接已移除，已导入的文件仍会保留。'),
                    )
                  }
                >
                  {uiText('移除链接')}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
