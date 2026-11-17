import React, { useContext, useEffect, useRef, useState } from 'react';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import type {
  DesktopObject,
  EditableContent,
  CanvasGroups,
  Text,
  Table,
  Code,
  Diagram,
  Deck,
  Workbook,
} from '../../../packages/contracts/index.js';
import type { ObjectActivity } from '../../../packages/contracts/object-activity.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { localCodeRuntime } from '../../../packages/components/native-files.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { flushDraftStorage } from '../documents/draft-storage.js';
import { CanvasDetailContext, CanvasFilePreview, CodeThumbnail } from './canvas-file-preview.js';
import { Icon, FileBadge, materialAppearance } from '../ui/icons.js';
import { TableEditor } from '../documents/editors.js';
import { DiagramEditor, DeckEditor, WorkbookEditor } from '../documents/structured-editors.js';
import { isWorkflowObject } from '../workflows/workflow-library.js';
import { WorkflowWidget } from '../workflows/workflow-widget.js';
import { ImagePreview } from '../documents/images.js';
import { isIntegratedDesktop } from '../workspace/workspace-mode.js';
import { ActivityBadge, AiActivityBadge } from '../interaction/object-activity.js';

export type Draft = { base: number; content: EditableContent; error?: string };
export type CardData = {
  object: DesktopObject;
  draft?: Draft;
  edit: (id: string, value: string) => void;
  saveText: (id: string) => void;
  change: (id: string, content: EditableContent) => void;
  expand: (id: string) => void;
  status: string;
  groups: CanvasGroups['items'];
  preview: (id: string) => void;
  activate: (id: string) => void;
  locateOutputSources: (id: string) => void;
  remove: (id: string) => void;
  comment: (id: string) => void;
  activity?: ObjectActivity;
  aiActivity?: string;
  aiLinked?: boolean;
  showActivity: (id: string) => void;
  folder: string;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  resize: (id: string, bounds: DesktopObject['bounds']) => void;
  favorite: boolean;
  setFavorite: (id: string, value: boolean) => void;
  run: (id: string) => void;
};
export const textOf = (c: Text) => c.blocks.map((b) => b.text).join('\n');

function InlineTextCard({
  object,
  draft,
  edit,
  saveText,
}: {
  object: DesktopObject;
  draft?: Draft;
  edit: (id: string, value: string) => void;
  saveText: (id: string) => void;
}) {
  useUiLocale();
  const saved = textOf((draft?.content ?? object.content) as Text);
  const [value, setValue] = useState(saved),
    focused = useRef(false),
    latest = useRef(value),
    committed = useRef(saved);
  latest.current = value;
  useEffect(() => {
    if (!focused.current) {
      committed.current = saved;
      latest.current = saved;
      setValue(saved);
    }
  }, [object.id, saved]);
  useEffect(() => {
    const preserve = () => {
      if (latest.current === committed.current) return;
      edit(object.id, latest.current);
      flushDraftStorage();
      committed.current = latest.current;
    };
    window.addEventListener('pagehide', preserve);
    return () => window.removeEventListener('pagehide', preserve);
  }, [object.id, edit]);
  function commit(text: string, leave = false) {
    if (leave) focused.current = false;
    latest.current = text;
    if (text !== committed.current) {
      edit(object.id, text);
      committed.current = text;
    }
    saveText(object.id);
  }
  return (
    <textarea
      className="card-editor nodrag nopan nowheel"
      aria-label={uiText('编辑 {0}', { '0': object.title })}
      value={value}
      maxLength={50000}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(event) => {
        latest.current = event.currentTarget.value;
        setValue(event.currentTarget.value);
      }}
      onBlur={(event) => commit(event.currentTarget.value, true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          commit(event.currentTarget.value);
        }
      }}
      spellCheck={false}
    />
  );
}

const aiWriteLabels = () => [
  uiText('AI 正在修改文件'),
  uiText('AI 正在保存文件'),
  uiText('AI 正在保存材料'),
];
const ObjectCard = React.memo(
  function ObjectCard({ data, selected }: NodeProps<Node<CardData>>) {
    useUiLocale();
    const { object: o, draft } = data;
    const detail = useContext(CanvasDetailContext),
      [focused, setFocused] = useState(false);
    const overview = detail === 'overview' && !selected && !focused;
    const appearance = materialAppearance(
      o.kind,
      o.kind === 'file' ? (o.content as { fileName: string }).fileName : '',
    );
    const htmlWindow =
      o.kind === 'file' && /\.html?$/i.test((o.content as { fileName: string }).fileName);
    return (
      <article
        className={`object-card material-object tone-${appearance.tone} kind-${o.kind} ${htmlWindow ? 'is-html-window' : ''} ${selected ? 'selected' : ''} ${overview ? 'is-overview' : ''}${data.aiActivity ? ' is-ai-active' : ''}${data.aiActivity && aiWriteLabels().includes(data.aiActivity) ? ' is-ai-writing' : ''}${data.aiLinked ? ' is-ai-linked' : ''}`}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node))
            setFocused(false);
        }}
      >
        <div className="card-edge-drag-zones" aria-hidden="true">
          <div className="card-edge-drag card-edge-top drag-handle" title={uiText('拖动卡片')} />
          <div className="card-edge-drag card-edge-left drag-handle" title={uiText('拖动卡片')} />
          <div className="card-edge-drag card-edge-right drag-handle" title={uiText('拖动卡片')} />
        </div>
        <NodeResizer
          isVisible={!!selected}
          minWidth={220}
          minHeight={170}
          maxWidth={3000}
          maxHeight={3000}
          onResizeEnd={(_, bounds) => data.resize(o.id, bounds)}
        />
        <div
          className="object-paper drag-handle"
          onDoubleClick={(e) => {
            if (
              !(e.target as HTMLElement).closest(
                'button,input,textarea,select,[contenteditable="true"]',
              )
            )
              data.activate(o.id);
          }}
        >
          <div className="paper-hover-tools nodrag">
            <button
              title={uiText('大预览 · 空格')}
              aria-label={uiText('预览 {0}', { '0': o.title })}
              onClick={() => data.preview(o.id)}
            >
              <Icon name="eye" size={15} />
            </button>
            <button
              className="paper-delete"
              title={uiText('删除到回收站')}
              aria-label={uiText('删除 {0}', { '0': o.title })}
              onClick={() => data.remove(o.id)}
            >
              <Icon name="trash" size={14} />
            </button>
            <button
              title={uiText('展开编辑')}
              aria-label={uiText('展开 {0}', { '0': o.title })}
              onClick={() => data.expand(o.id)}
            >
              <Icon name="expand" size={15} />
            </button>
            {localCodeRuntime(o) && (
              <button
                className="paper-run"
                title={uiText('交给 Codex 原对话运行')}
                aria-label={uiText('运行 {0}', { '0': o.title })}
                onClick={() => data.run(o.id)}
              >
                <Icon name="play" size={13} />
              </button>
            )}
          </div>
          <div className="card-detail" style={overview ? { visibility: 'hidden' } : undefined}>
            {o.kind === 'text' ? (
              <InlineTextCard object={o} draft={draft} edit={data.edit} saveText={data.saveText} />
            ) : overview ? null : o.kind === 'table' ? (
              <TableEditor
                value={(draft?.content ?? o.content) as Table}
                change={(c) => data.change(o.id, c)}
                compact
              />
            ) : o.kind === 'code' ? (
              <CodeThumbnail text={((draft?.content ?? o.content) as Code).code} />
            ) : o.kind === 'diagram' ? (
              <DiagramEditor
                value={(draft?.content ?? o.content) as Diagram}
                change={(c) => data.change(o.id, c)}
                compact
              />
            ) : o.kind === 'deck' ? (
              <DeckEditor
                value={(draft?.content ?? o.content) as Deck}
                change={(c) => data.change(o.id, c)}
                compact
              />
            ) : o.kind === 'workbook' ? (
              <WorkbookEditor
                value={(draft?.content ?? o.content) as Workbook}
                change={(c) => data.change(o.id, c)}
                compact
              />
            ) : isWorkflowObject(o) ? (
              <WorkflowWidget object={o} />
            ) : o.kind === 'file' ? (
              <CanvasFilePreview
                key={`${o.id}:${o.revision}`}
                object={o}
                action={data.action}
                interactive={!!selected && detail === 'detail'}
              />
            ) : (
              <ImagePreview object={o} />
            )}
          </div>
          {overview && (
            <div className="card-overview">
              <FileBadge
                kind={o.kind}
                fileName={o.kind === 'file' ? (o.content as { fileName: string }).fileName : ''}
              />
              <strong>{o.title}</strong>
            </div>
          )}
          {o.kind === 'file' && (
            <button
              className="paper-preview-open nodrag nopan"
              title={uiText('打开大预览，可滚动或翻页阅读')}
              onClick={() => data.preview(o.id)}
            >
              <Icon name="eye" size={12} />
              {uiText('打开预览')}
            </button>
          )}
        </div>
        <div
          className="object-caption drag-handle"
          title={`${o.title}${data.folder ? ` · ${data.folder}` : ''}${data.groups.length ? ` · ${data.groups.map((g) => g.name).join('、')}` : ''}`}
        >
          <FileBadge
            kind={o.kind}
            fileName={o.kind === 'file' ? (o.content as { fileName: string }).fileName : ''}
          />
          {o.kind === 'file' && (
            <button
              className="caption-favorite nodrag nopan"
              draggable
              title={uiText('拖入小工具作为输入文件')}
              aria-label={uiText('拖入组件：{0}', { '0': o.title })}
              onDragStart={(event) => {
                event.stopPropagation();
                event.dataTransfer.setData(
                  'application/x-ai-desktop-objects',
                  JSON.stringify([o.id]),
                );
                event.dataTransfer.effectAllowed = 'copy';
              }}
            >
              <Icon name="link" size={13} />
            </button>
          )}
          <button
            className={`caption-title drag-handle ${o.generation ? 'has-generation' : ''}`}
            title={
              o.generation
                ? uiText('{0} · v{1}\n请求：{2}{3}{4}', {
                    '0': o.title,
                    '1': o.revision,
                    '2': o.generation.request ?? o.generation.taskName,
                    '3': o.generation.sources.length
                      ? uiText('\n来源：{0}', {
                          '0': o.generation.sources
                            .map((source) => `${source.title} · v${source.revision}`)
                            .join('、'),
                        })
                      : '',
                    '4': o.generation.syncError ? `\n${o.generation.syncError}` : '',
                  })
                : isIntegratedDesktop && o.kind === 'file'
                  ? uiText('拖动移动 · 双击用系统默认应用打开 · 空格预览')
                  : uiText('拖动移动；点击编辑原文件')
            }
            onClick={() => {
              if (!isIntegratedDesktop || o.kind !== 'file') data.expand(o.id);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              if (isIntegratedDesktop && o.kind === 'file') data.activate(o.id);
            }}
          >
            <span>{o.title}</span>
            {o.browserSource && (
              <small title={o.browserSource.url}>
                {uiText('网页下载 · v')}
                {o.revision}
              </small>
            )}
            {o.generation && (
              <small
                className={
                  o.generation.syncError || o.generation.changedSources?.length
                    ? 'generation-warning'
                    : ''
                }
              >
                v{o.revision} ·{' '}
                {o.generation.syncError
                  ? uiText('文件同步待处理')
                  : o.generation.syncPending
                    ? uiText('正在同步文件')
                    : o.generation.changedSources?.length
                      ? uiText('来源已变化')
                      : `AI ${o.generation.action === 'updated' ? uiText('更新') : uiText('生成')}`}{' '}
                ·{' '}
                {o.generation.request ||
                  (o.generation.sources.length
                    ? uiText('来自 {0}', {
                        '0': o.generation.sources.map((source) => source.title).join('、'),
                      })
                    : o.generation.taskName)}
              </small>
            )}
          </button>
          {!!o.generation?.sources.length && (
            <button
              type="button"
              className="caption-favorite nodrag nopan"
              title={uiText('定位来源与产出')}
              aria-label={uiText('定位来源与产出')}
              onClick={(event) => {
                event.stopPropagation();
                data.locateOutputSources(o.id);
              }}
            >
              <Icon name="link" size={14} />
            </button>
          )}
          {o.generation?.relativePath && isIntegratedDesktop && (
            <button
              className="caption-favorite nodrag nopan"
              title={uiText('打开所在文件夹')}
              aria-label={uiText('打开 {0} 所在文件夹', { '0': o.title })}
              onClick={() =>
                window.parent.postMessage(
                  {
                    type: 'ai-desktop:reveal-output',
                    batchId: o.generation!.batchId,
                    objectId: o.id,
                  },
                  '*',
                )
              }
            >
              <Icon name="folder" size={14} />
            </button>
          )}
          {(o.fileSyncError || o.generation?.syncError) && isIntegratedDesktop && (
            <button
              className="caption-favorite nodrag nopan"
              title={uiText('处理文件同步')}
              onClick={() =>
                window.parent.postMessage({ type: 'ai-desktop:file-sync', objectId: o.id }, '*')
              }
            >
              !
            </button>
          )}
          {!!o.generation?.changedSources?.length && isIntegratedDesktop && (
            <button
              className="caption-favorite nodrag nopan"
              title={uiText('更新结果：{0}', {
                '0': o.generation.changedSources
                  .map(
                    (source) =>
                      `${source.title} v${source.revision} → ${source.currentRevision ?? uiText('不可用')}`,
                  )
                  .join('；'),
              })}
              onClick={() =>
                window.parent.postMessage(
                  {
                    type: 'ai-desktop:refresh-output',
                    objectId: o.id,
                    sourceIds: o.generation!.sources.map((source) => source.id),
                  },
                  '*',
                )
              }
            >
              ↻
            </button>
          )}
          <button
            className="caption-favorite nodrag"
            title={uiText('评论与 AI 处理')}
            aria-label={uiText('评论 {0}', { '0': o.title })}
            onClick={() => data.comment(o.id)}
          >
            <Icon name="comment" size={15} />
          </button>
          {draft && (
            <span
              className={`caption-status ${draft.error ? 'error-text' : ''}`}
              title={
                draft.error ??
                (o.kind === 'text'
                  ? uiText('点击编辑框外后保存')
                  : uiText('停止输入 2 秒后自动保存'))
              }
            >
              {draft.error ? uiText('保存冲突') : uiText('待保存')}
            </span>
          )}
          {o.policy?.locked && <Icon name="lock" size={12} />}
          <button
            className={`caption-favorite nodrag ${data.favorite ? 'is-favorite' : ''}`}
            title={data.favorite ? uiText('取消收藏') : uiText('收藏')}
            aria-label={`${data.favorite ? uiText('取消收藏') : uiText('收藏')} ${o.title}`}
            aria-pressed={data.favorite}
            onClick={() => data.setFavorite(o.id, !data.favorite)}
          >
            <Icon name="star" size={15} />
          </button>
        </div>
        {data.aiActivity ? (
          <AiActivityBadge label={data.aiActivity} />
        ) : (
          <ActivityBadge activity={data.activity} open={() => data.showActivity(o.id)} />
        )}
      </article>
    );
  },
  (previous, next) => previous.data === next.data && previous.selected === next.selected,
);
export const nodeTypes = { object: ObjectCard };
