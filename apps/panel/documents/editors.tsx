import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useState } from 'react';
import type {
  Code,
  DesktopObject,
  EditableContent,
  Revision,
  Workspace,
} from '../../../packages/contracts/index.js';
import { contentText } from '../../../packages/components/content.js';
import { staticHtml } from '../../../packages/components/static-preview.js';
import { textDelta } from '../../../packages/components/protection.js';
import { NativeFileHistory } from './native/native-history.js';

export { TableEditor } from './table-editor.js';
export function CodeEditor({
  value,
  change,
  compact = false,
  selectRange,
}: {
  value: Code;
  change: (next: Code) => void;
  compact?: boolean;
  selectRange?: (start: number, end: number, source: string) => void;
}) {
  useUiLocale();
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [preview, setPreview] = useState(false);
  return (
    <div className={`code-editor nodrag nopan nowheel ${compact ? 'compact' : ''}`}>
      {!compact && (
        <div className="editor-tools">
          <label>
            {uiText('语言')}
            <select
              aria-label={uiText('代码语言')}
              value={value.language}
              onChange={(e) => change({ ...value, language: e.target.value as Code['language'] })}
            >
              {[
                'text',
                'javascript',
                'typescript',
                'python',
                'json',
                'html',
                'css',
                'markdown',
              ].map((language) => (
                <option key={language}>{language}</option>
              ))}
            </select>
          </label>
          <span>{uiText('仅编辑文本 · 代码不会执行')}</span>
        </div>
      )}
      {!compact && selectRange && (
        <div className="range-toolbar">
          <span>
            {selection
              ? uiText('已选择 {0} 个字符', { '0': selection.end - selection.start })
              : uiText('选中代码片段，作为局部上下文')}
          </span>
          <button
            disabled={!selection}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => selection && selectRange(selection.start, selection.end, value.code)}
          >
            {uiText('使用代码片段')}
          </button>
        </div>
      )}
      {!compact && value.language === 'html' && (
        <div className="static-preview-bar">
          <button className={preview ? 'active' : ''} onClick={() => setPreview(!preview)}>
            {preview ? uiText('关闭静态预览') : uiText('打开静态预览')}
          </button>
          <span>{uiText('仅展示基础 HTML 结构；脚本、资源、链接、样式与属性不进入预览。')}</span>
        </div>
      )}
      <div
        className={`code-content ${preview && value.language === 'html' && !compact ? 'with-preview' : ''}`}
      >
        <textarea
          aria-label={compact ? uiText('代码预览编辑') : uiText('完全态代码编辑')}
          className={compact ? 'card-editor' : ''}
          spellCheck={false}
          maxLength={200000}
          value={value.code}
          onChange={(e) => change({ ...value, code: e.target.value })}
          onSelect={(e) => {
            const t = e.currentTarget;
            setSelection(
              t.selectionEnd > t.selectionStart
                ? { start: t.selectionStart, end: t.selectionEnd }
                : null,
            );
          }}
        />
        {preview && value.language === 'html' && !compact && (
          <iframe
            title={uiText('HTML 安全静态预览')}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={staticHtml(value.code)}
          />
        )}
      </div>
    </div>
  );
}
type Action = (name: string, payload?: Record<string, unknown>) => Promise<any>;
export function RevisionHistory({
  object,
  action,
  hasDraft,
  close,
  restored,
  report,
  initialRevision,
  workspace,
  openRevision,
}: {
  object: DesktopObject;
  action: Action;
  hasDraft: boolean;
  close: () => void;
  restored: () => Promise<void>;
  report: (e: unknown) => void;
  initialRevision?: number;
  workspace: Workspace;
  openRevision: (id: string, revision: number) => void;
}) {
  useUiLocale();
  const [items, setItems] = useState<Omit<Revision, 'content'>[]>([]),
    [next, setNext] = useState<number | null>(null),
    [chosen, setChosen] = useState<Revision | null>(null),
    [busy, setBusy] = useState(false);
  const [base, setBase] = useState<Revision | null>(null),
    [error, setError] = useState(''),
    [tab, setTab] = useState<'change' | 'current'>('change'),
    [confirmRestore, setConfirmRestore] = useState(false);
  async function load(before?: number) {
    const result = await action('revisions', {
      objectId: object.id,
      ...(before ? { before } : {}),
    });
    setItems((previous) => (before ? [...previous, ...result.revisions] : result.revisions));
    setNext(result.next);
  }
  useEffect(() => {
    void load().catch(report);
  }, [object.id, object.revision]);
  useEffect(() => {
    void select(initialRevision ?? object.revision);
  }, [object.id, initialRevision]);
  async function select(revision: number) {
    setBusy(true);
    setError('');
    setConfirmRestore(false);
    try {
      const [value, previous] = await Promise.all([
        action('revision', { objectId: object.id, revision }),
        revision > 1
          ? action('revision', { objectId: object.id, revision: revision - 1 })
          : Promise.resolve(null),
      ]);
      setChosen(value);
      setBase(previous);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function restore(operation: 'restore' | 'undo') {
    if (!chosen) return;
    setBusy(true);
    setError('');
    try {
      await action(operation, {
        requestId: crypto.randomUUID(),
        objectId: object.id,
        expectedRevision: object.revision,
        targetRevision: chosen.revision,
      });
      await restored();
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const revisionText = (content: DesktopObject['content']) =>
    ['text', 'code', 'table'].includes(object.kind)
      ? contentText(content)
      : JSON.stringify(content, null, 2);
  const left = chosen
    ? tab === 'change'
      ? base
        ? revisionText(base.content)
        : ''
      : revisionText(chosen.content)
    : '';
  const right = chosen
    ? tab === 'change'
      ? revisionText(chosen.content)
      : revisionText(object.content)
    : '';
  const diff = textDelta(left, right),
    contribution = chosen?.contribution;
  const fieldLabels: Record<string, string> = {
    text: uiText('文字'),
    title: uiText('标题'),
    subtitle: uiText('副标题'),
    body: uiText('正文'),
    secondary: uiText('辅助内容'),
    notes: uiText('备注'),
    layout: uiText('版式'),
    name: uiText('名称'),
    table: uiText('表格内容'),
    formats: uiText('列格式'),
    formulas: uiText('公式模式'),
    accent: uiText('主题色'),
    footer: uiText('页脚'),
    width: uiText('宽度'),
    height: uiText('高度'),
    x: uiText('横向位置'),
    y: uiText('纵向位置'),
    color: uiText('颜色'),
    shape: uiText('形状'),
    from: uiText('起点'),
    to: uiText('终点'),
    label: uiText('说明'),
    note: uiText('批注文字'),
    points: uiText('路径'),
    type: uiText('类型'),
  };
  const partLabels: Record<string, string> = {
    node: uiText('节点'),
    edge: uiText('连线'),
    slide: uiText('幻灯片'),
    sheet: uiText('工作表'),
    annotation: uiText('批注'),
  };
  return (
    <section className="revision-view" role="dialog" aria-label={uiText('修改与来源')}>
      <header>
        <strong>
          {object.title} {uiText('· 修改与来源')}
        </strong>
        <button onClick={close}>{uiText('关闭历史')}</button>
      </header>
      <p>{uiText('单独撤销会保留不相交的后续修改；同一位置已被修改时停止并提示你合并。')}</p>
      {error && (
        <div className="banner error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError('')}>{uiText('关闭提示')}</button>
        </div>
      )}
      <div className="revision-body">
        <nav aria-label={uiText('历史版本')}>
          {items.map((r) => (
            <button
              key={r.revision}
              className={chosen?.revision === r.revision ? 'active' : ''}
              disabled={busy}
              onClick={() => void select(r.revision)}
            >
              <strong>
                v{r.revision} · {r.actor === 'human' ? uiText('你') : 'AI'}
              </strong>
              <span>{r.summary}</span>
              <small>{new Date(r.createdAt).toLocaleString(interfaceLocale())}</small>
            </button>
          ))}
          {next && (
            <button onClick={() => void load(next).catch(report)}>{uiText('更早版本')}</button>
          )}
        </nav>
        <div className="revision-detail">
          {chosen ? (
            <>
              <div className="revision-tabs">
                <button
                  className={tab === 'change' ? 'active' : ''}
                  onClick={() => setTab('change')}
                >
                  {uiText('此次修改')}
                </button>
                <button
                  className={tab === 'current' ? 'active' : ''}
                  onClick={() => setTab('current')}
                >
                  {uiText('与当前比较')}
                </button>
                <span>
                  {chosen.actor === 'human' ? uiText('用户提交') : uiText('执行凭据提交')} · v
                  {chosen.revision}
                </span>
              </div>
              <div className="contribution-evidence">
                <strong>{chosen.summary}</strong>
                {contribution ? (
                  <>
                    <p>
                      {uiText('基于 v')}
                      {contribution.baseRevision} · {contribution.operation}
                      {contribution.undoOf
                        ? uiText(' · 撤销 v{0}', { '0': contribution.undoOf })
                        : ''}
                    </p>
                    {contribution.execution && (
                      <p>
                        {contribution.execution.role === 'writer'
                          ? uiText('写入者')
                          : uiText('审阅者')}{' '}
                        {uiText('· 宿主会话')}
                        {contribution.execution.hostSessionHash.slice(0, 12)}
                        {contribution.execution.feedbackId
                          ? uiText(' · 已引用反馈 {0}', {
                              '0': contribution.execution.feedbackId.slice(-12),
                            })
                          : ''}
                      </p>
                    )}
                    <small>
                      {contribution.location.type === 'text'
                        ? uiText('改后位置：字符 {0} 至 {1}（零长度表示删除）', {
                            '0': contribution.location.start + 1,
                            '1': contribution.location.end,
                          })
                        : contribution.location.type === 'cells'
                          ? uiText('本次修改 {0} 个稳定单元格', {
                              '0': contribution.location.cells.length,
                            })
                          : contribution.location.type === 'parts'
                            ? uiText('涉及 {0} 个子对象', {
                                '0': contribution.location.items.length,
                              })
                            : uiText('对象内容或结构变更')}
                    </small>
                    {contribution.location.type === 'parts' && (
                      <div className="contribution-parts">
                        {contribution.location.settings.length > 0 && (
                          <p>
                            {uiText('全局设置：')}
                            {contribution.location.settings
                              .map((field) => fieldLabels[field] ?? field)
                              .join('、')}
                          </p>
                        )}
                        {contribution.location.order.length > 0 && (
                          <p>
                            {uiText('顺序调整：')}
                            {contribution.location.order.map((kind) => partLabels[kind]).join('、')}
                          </p>
                        )}
                        {contribution.location.items.map((item) => (
                          <details key={`${item.kind}:${item.id}`}>
                            <summary>
                              {
                                {
                                  added: uiText('新增'),
                                  removed: uiText('移除'),
                                  updated: uiText('修改'),
                                }[item.change]
                              }
                              {partLabels[item.kind]} · {item.label}
                            </summary>
                            <small>
                              {item.fields.length
                                ? item.fields.map((field) => fieldLabels[field] ?? field).join('、')
                                : uiText('完整子对象')}{' '}
                              · {item.id}
                            </small>
                          </details>
                        ))}
                      </div>
                    )}
                    <div className="contribution-dependencies">
                      <span>{uiText('依据版本')}</span>
                      {contribution.dependencies.map((source, i) => (
                        <button
                          key={`${source.objectId}:${source.revision}:${i}`}
                          disabled={!workspace.objects.some((o) => o.id === source.objectId)}
                          onClick={() =>
                            source.objectId === object.id
                              ? void select(source.revision)
                              : openRevision(source.objectId, source.revision)
                          }
                        >
                          {workspace.objects.find((o) => o.id === source.objectId)?.title ??
                            uiText('已归档材料')}{' '}
                          · v{source.revision}
                        </button>
                      ))}
                    </div>
                    <details>
                      <summary>{uiText('查看操作记录标识')}</summary>
                      <p>
                        {uiText('请求')}
                        {contribution.requestId}
                      </p>
                      {contribution.snapshotId && (
                        <p>
                          {uiText('材料执行记录')}
                          {contribution.snapshotId}
                          {contribution.execution
                            ? uiText('（身份见任务记录）')
                            : uiText('（未区分真实模型身份）')}
                        </p>
                      )}
                      {contribution.location.type === 'cells' && (
                        <pre>
                          {contribution.location.cells
                            .map((c) => `${c.rowId} / ${c.columnId}`)
                            .join('\n')}
                        </pre>
                      )}
                    </details>
                  </>
                ) : (
                  <p>{uiText('此早期版本保留了内容与提交者标签，没有记录操作范围和依赖版本。')}</p>
                )}
              </div>
              {object.kind === 'file' && (chosen.revision > 1 || tab === 'current') ? (
                <NativeFileHistory
                  object={object}
                  from={tab === 'change' ? chosen.revision - 1 : chosen.revision}
                  to={tab === 'change' ? chosen.revision : object.revision}
                  action={action}
                  disabled={hasDraft || busy}
                  applied={async () => {
                    await restored();
                    close();
                  }}
                />
              ) : (
                <div className="revision-comparison">
                  <div>
                    <strong>
                      {tab === 'change'
                        ? base
                          ? uiText('修改前 v{0}', { '0': base.revision })
                          : uiText('新建前')
                        : uiText('所选 v{0}', { '0': chosen.revision })}
                    </strong>
                    <pre>
                      {left.slice(0, diff.start)}
                      <mark className="removed">{left.slice(diff.start, diff.end)}</mark>
                      {left.slice(diff.end)}
                    </pre>
                  </div>
                  <div>
                    <strong>
                      {tab === 'change'
                        ? uiText('修改后 v{0}', { '0': chosen.revision })
                        : uiText('当前 v{0}', { '0': object.revision })}
                    </strong>
                    <pre>
                      {right.slice(0, diff.start)}
                      <mark>{right.slice(diff.start, diff.newEnd)}</mark>
                      {right.slice(diff.newEnd)}
                    </pre>
                  </div>
                </div>
              )}
              <details className="whole-restore">
                <summary>{uiText('将整个对象恢复到这个版本')}</summary>
                <p>
                  {uiText(
                    '这会将当前整份内容替换为所选历史内容，包括覆盖后续修改。所有修订仍保留在历史中。',
                  )}
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={confirmRestore}
                    onChange={(e) => setConfirmRestore(e.target.checked)}
                  />
                  {uiText('我已比较当前内容，使用所选完整版本')}
                </label>
                <button
                  disabled={
                    busy || hasDraft || !confirmRestore || chosen.revision === object.revision
                  }
                  onClick={() => void restore('restore')}
                >
                  {uiText('恢复整份内容')}
                </button>
              </details>
            </>
          ) : (
            <p>{uiText('选择一个历史版本进行比较。')}</p>
          )}
        </div>
      </div>
      <footer>
        <span>
          {hasDraft
            ? uiText('有未保存草稿，请先保存或处理冲突。')
            : uiText('按字段、单元格和稳定对象撤销；重叠修改、后续依赖或有歧义的排序变更会停止。')}
        </span>
        <button
          className="primary"
          disabled={
            busy ||
            hasDraft ||
            !chosen ||
            chosen.revision < 2 ||
            !['text', 'code', 'table', 'image', 'diagram', 'deck', 'workbook'].includes(object.kind)
          }
          onClick={() => void restore('undo')}
        >
          {uiText('仅撤销这次修改')}
        </button>
      </footer>
    </section>
  );
}
