import { t as uiText, getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';

const ACTIVITY_LABELS: Record<string, string> = {
  'object.created': uiText('创建对象'),
  'object.changed': uiText('保存修改'),
  'object.restored': uiText('恢复历史版本'),
  'object.undone': uiText('单独撤销修改'),
  'object.policy': uiText('更新内容保护'),
  'worktask.created': uiText('创建本地任务'),
  'worktask.updated': uiText('更新任务记录'),
  'object.read': uiText('读取对象'),
  'object.exported': uiText('导出文件'),
  'view.changed': uiText('调整画布'),
  'selection.prepared': uiText('准备选区'),
  'selection.sent': uiText('发送选区'),
  'selection.draft': uiText('加入输入框'),
  'selection.unknown': uiText('发送结果待确认'),
  'task.cancelled': uiText('停止任务'),
};

/** Slide-over drawer listing the workspace activity feed, one entry per event. */
export function ActivityDrawer(props: {
  events: any[];
  next: number | null;
  objects?: { id: string; title: string }[];
  onClose: () => void;
  onLoadMore: () => void;
  onInspect: (objectId: string, revision: number) => void;
}) {
  const { events, next, objects, onClose, onLoadMore, onInspect } = props;
  return (
    <aside className="history">
      <header>
        <strong>{uiText('实际活动')}</strong>
        <button onClick={onClose}>×</button>
      </header>
      {!events.length ? (
        <p>{uiText('尚无活动记录。')}</p>
      ) : (
        events.map((e) => (
          <div key={e.seq}>
            <strong>
              {e.actor === 'ai' ? 'AI' : e.actor === 'human' ? uiText('你') : uiText('宿主')}
            </strong>
            <span>{ACTIVITY_LABELS[e.type] ?? e.type}</span>
            <small>
              {objects?.find((o) => o.id === e.objectId)?.title} {e.revision ? `v${e.revision}` : ''}{' '}
              · {new Date(e.createdAt).toLocaleString(interfaceLocale())}
            </small>
            {e.objectId && e.revision && objects?.some((o) => o.id === e.objectId) && (
              <button onClick={() => onInspect(e.objectId, e.revision)}>
                {uiText('查看内容与来源')}
              </button>
            )}
          </div>
        ))
      )}
      {next && (
        <button onClick={onLoadMore}>{uiText('更早活动')}</button>
      )}
    </aside>
  );
}
