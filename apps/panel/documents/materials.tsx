import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useState } from 'react';
import type { DesktopObject, Workspace } from '../../../packages/contracts/index.js';
import { kindIcons, kindLabels } from '../../../packages/components/content.js';
import { nativeFormat } from '../../../packages/components/native-files.js';
import { Icon, materialAppearance } from '../ui/icons.js';
import { TrashIcon, type DesktopDeletionController } from '../workspace/desktop-delete.js';
type Action = (name: string, payload?: Record<string, unknown>) => Promise<any>;
export function FilePreview({
  object,
  compact = false,
  exportFile,
}: {
  object: DesktopObject;
  compact?: boolean;
  exportFile?: () => void;
}) {
  useUiLocale();
  const c = object.content as {
    fileName: string;
    size: number;
    mime: string;
    assetHash: string;
    sourceRelativePath?: string;
    sourceModifiedAt?: number;
  };
  const format = nativeFormat(c.fileName);
  const ext = c.fileName.split('.').pop()?.toUpperCase() ?? 'FILE';
  const look = materialAppearance('file', c.fileName);
  return (
    <div className={`file-preview tone-${look.tone} ${compact ? 'compact' : ''}`}>
      {object.dataUrl && (
        <img
          src={object.dataUrl}
          alt={object.title}
          style={{ maxWidth: '100%', maxHeight: 150, objectFit: 'contain' }}
        />
      )}
      <div className="file-extension">
        <Icon name={look.icon} size={26} />
        <span>{ext.slice(0, 6)}</span>
      </div>
      <strong>{c.fileName}</strong>
      <span>
        {c.size < 1024 ? `${c.size} B` : `${(c.size / 1024).toFixed(1)} KB`} · {format.label}
      </span>
      {!compact && (
        <>
          <p>
            {['xlsx', 'docx', 'pptx'].includes(format.extension)
              ? uiText('支持在桌面内编辑，保存回同一文件。当前使用本地兼容编辑器。')
              : uiText('保留原生文件，支持引用、更新、导出和历史恢复。')}
          </p>
          <dl>
            <dt>{uiText('文件类型（按文件名）')}</dt>
            <dd>{c.mime}</dd>
            {c.sourceRelativePath && (
              <>
                <dt>{uiText('首次导入路径')}</dt>
                <dd>{c.sourceRelativePath}</dd>
              </>
            )}
            {c.sourceModifiedAt !== undefined && (
              <>
                <dt>{uiText('来源文件修改时间')}</dt>
                <dd>{new Date(c.sourceModifiedAt).toLocaleString(interfaceLocale())}</dd>
              </>
            )}
            <dt>{uiText('当前版本')}</dt>
            <dd>v{object.revision}</dd>
          </dl>
          <button className="primary" onClick={exportFile}>
            {uiText('导出当前文件')}
          </button>
        </>
      )}
    </div>
  );
}
export function Materials({
  workspace,
  action,
  close,
  openObject,
  updated,
  deletion,
  openTrash,
}: {
  workspace: Workspace;
  action: Action;
  close: () => void;
  openObject: (id: string) => void;
  updated: () => Promise<void>;
  deletion: DesktopDeletionController;
  openTrash: () => void;
}) {
  useUiLocale();
  const [query, setQuery] = useState(''),
    [kind, setKind] = useState('all'),
    [chosen, setChosen] = useState<string | null>(null);
  const [title, setTitle] = useState(''),
    [note, setNote] = useState(''),
    [privateOnly, setPrivate] = useState(false),
    [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const items = workspace.objects;
  const object = items.find((o) => o.id === chosen);
  function select(o: DesktopObject) {
    setChosen(o.id);
    setTitle(o.title);
    setPrivate(o.policy?.private ?? false);
    setLocked(o.policy?.locked ?? false);
    setNote(o.policy?.note ?? '');
    setError('');
  }
  async function operate(operation: string) {
    if (!object || busy || deletion.busy) return;
    setBusy(true);
    setError('');
    try {
      const result: DesktopObject = await action('object_manage', {
        requestId: crypto.randomUUID(),
        objectId: object.id,
        expectedRevision: object.revision,
        operation,
        ...(operation === 'rename' ? { title } : {}),
        ...(operation === 'policy'
          ? {
              policy: {
                private: privateOnly,
                locked,
                note,
                revision: object.policy?.revision ?? 0,
                protectedRanges: object.policy?.protectedRanges ?? [],
              },
            }
          : {}),
      });
      await updated();
      if (operation === 'duplicate') {
        setChosen(result.id);
        setTitle(result.title);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="materials-view" role="dialog" aria-label={uiText('材料管理')}>
      <header className="section-header">
        <button onClick={close}>{uiText('返回桌面')}</button>
        <div>
          <strong>{uiText('材料管理')}</strong>
        </div>
        <span>
          {workspace.objects.length} {uiText('份材料')}
        </span>
      </header>
      {error && (
        <div className="banner error">
          <span>{error}</span>
          <button onClick={() => setError('')}>{uiText('关闭')}</button>
        </div>
      )}
      <div className="material-filters">
        <input
          aria-label={uiText('搜索材料')}
          placeholder={uiText('搜索名称…')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label={uiText('材料类型')}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="all">{uiText('全部类型')}</option>
          {Object.entries(kindLabels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <button onClick={openTrash}>
          <TrashIcon /> {uiText('回收站')}
        </button>
      </div>
      <div className="materials-body">
        <div className="material-list">
          {items
            .filter(
              (o) =>
                (kind === 'all' || kind === o.kind) &&
                o.title.toLowerCase().includes(query.toLowerCase()),
            )
            .map((o) => (
              <button
                key={o.id}
                className={o.id === chosen ? 'chosen' : ''}
                onClick={() => select(o)}
              >
                <span className="material-icon">{kindIcons[o.kind]}</span>
                <span>
                  <strong>{o.title}</strong>
                  <small>
                    {kindLabels[o.kind]} · v{o.revision}
                    {o.policy?.private ? uiText(' · 仅自己') : ''}
                    {o.policy?.locked ? uiText(' · AI 只读') : ''}
                  </small>
                </span>
                <span>›</span>
              </button>
            ))}
          {!items.length && <p className="editor-empty">{uiText('先向桌面导入一份材料。')}</p>}
        </div>
        <aside className="material-inspector">
          {object ? (
            <>
              <span className="eyebrow">{uiText('材料设置')}</span>
              <h2>{object.title}</h2>
              <label>
                {uiText('名称')}
                <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
              </label>
              <button
                disabled={busy || deletion.busy || !title.trim() || title === object.title}
                onClick={() => void operate('rename')}
              >
                {uiText('保存名称')}
              </button>
              <div className="material-protection">
                <strong>{uiText('与 AI 协作的边界')}</strong>
                <label>
                  <input
                    type="checkbox"
                    checked={privateOnly}
                    onChange={(e) => setPrivate(e.target.checked)}
                  />
                  <span>
                    {uiText('禁止交给 AI')}
                    <small>{uiText('不进入选区快照或 AI 读取结果。')}</small>
                  </span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={locked}
                    onChange={(e) => setLocked(e.target.checked)}
                  />
                  <span>
                    {uiText('保留已确认内容')}
                    <small>{uiText('AI 只读；你仍可直接编辑。')}</small>
                  </span>
                </label>
                <label className="note-label">
                  {uiText('保留说明')}
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={2000}
                    placeholder={uiText('哪些部分已经确认，为什么需要保留？')}
                  />
                </label>
                <button disabled={busy || deletion.busy} onClick={() => void operate('policy')}>
                  {uiText('保存保护设置')}
                </button>
                <p>
                  {uiText('更改设置会让当前工作区旧的 AI 执行凭据失效，后续任务需重新提交选区。')}
                </p>
              </div>
              <div className="material-actions">
                <button className="primary" onClick={() => openObject(object.id)}>
                  {uiText('打开')}
                </button>
                <button disabled={busy || deletion.busy} onClick={() => void operate('duplicate')}>
                  {uiText('复制一份')}
                </button>
                <button
                  className="material-delete-button"
                  disabled={busy || deletion.busy || !!deletion.pendingCount}
                  onClick={() => void deletion.remove([object.id])}
                >
                  <TrashIcon />
                  {uiText('删除')}
                </button>
              </div>
              <small className="muted">
                {uiText('删除后移入回收站，保留内容与历史，可随时恢复。')}
              </small>
            </>
          ) : (
            <div className="material-placeholder">
              <span>▤</span>
              <p>{uiText('选择一份材料，查看信息、保护范围和管理操作。')}</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
