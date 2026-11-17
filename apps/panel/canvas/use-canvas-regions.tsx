import { getUiLanguage as getUiLocale } from '../../../packages/components/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useMemo, useRef, useState, useEffect } from 'react';
import type { CanvasGroups, Workspace } from '../../../packages/contracts/index.js';
import type { CanvasBoard, CanvasMark } from '../../../packages/contracts/canvas-board.js';
import {
  contains,
  extent,
  overlaps,
  type Rect,
} from '../../../packages/components/canvas-spatial.js';
import { RegionBackgroundEditor, regionBackgroundStyle } from './region-background.js';
import { Icon } from '../ui/icons.js';
import { browserCommand } from '../browser/electron-browser-bridge.js';
import { descendants, regionBoundsFor, regionMemberIds } from '../../../packages/components/canvas-folders.js';
import type { CanvasHistoryStep } from './use-canvas-history.js';
type Group = CanvasGroups['items'][number];
const EMPTY_GROUPS: Group[] = [];
type Position = { id: string; x: number; y: number };
type Options = {
  onHistory: (step: CanvasHistoryStep) => void;
  workspace: Workspace | null;
  board: CanvasBoard;
  view: Rect;
  viewport: { x: number; y: number; zoom: number };
  selected: string[];
  selectedMarks: () => string[];
  ready: () => boolean;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  updated: (workspace: Workspace) => void;
  reload: () => Promise<void>;
  previewCards: (positions: Position[], phase: 'preview' | 'cancel') => void;
  fit: (bounds: Rect) => void;
  notice: (message: string) => void;
};
// Region overlays sit above the React Flow pane, so wheel events would never reach its zoom handler.
function forwardWheel(event: React.WheelEvent) {
  const target = document
    .elementsFromPoint(event.clientX, event.clientY)
    .find((el) => el.classList.contains('react-flow__pane'));
  target?.dispatchEvent(new WheelEvent('wheel', event.nativeEvent));
}
type Drag = {
  group: Group;
  cards: Position[];
  marks: CanvasMark[];
  start: { x: number; y: number };
  zoom: number;
  dx: number;
  dy: number;
  mode: 'move' | 'resize';
  workspace: Workspace;
  boardRevision: number;
};
export function useCanvasRegions(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const drag = useRef<Drag | null>(null),
    [preview, setPreview] = useState<Drag | null>(null),
    [busy, setBusy] = useState(false),
    saving = useRef(false);
  const [edit, setEdit] = useState<{ id: string; value: string } | null>(null),
    [remove, setRemove] = useState<string | null>(null);
  const [backgroundId, setBackgroundId] = useState<string | null>(null);
  const [placement, setPlacement] = useState<{ workspaceId: string; group: Group } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const groups = options.workspace?.groups.items ?? EMPTY_GROUPS,
    regions = useMemo(() => groups.filter((group) => group.bounds), [groups]);
  const objects = options.workspace?.objects,
    objectIds = useMemo(() => new Set(objects?.map((object) => object.id)), [objects]);
  const active = regions.find((g) => g.id === focus),
    scope = useMemo(() => (active ? descendants(groups, active.id) : null), [groups, active]);
  const visibleGroups = useMemo(() => {
    const hidden = new Set<string>();
    for (const group of regions)
      if (group.collapsed && group.id !== focus)
        for (const id of descendants(groups, group.id)) if (id !== group.id) hidden.add(id);
    return regions.filter((g) => !hidden.has(g.id) && (!scope || scope.has(g.id)));
  }, [groups, regions, focus, scope]);
  const collapsed = useMemo(() => {
    const hidden = new Set<string>();
    for (const group of regions)
      if (group.collapsed && group.id !== focus)
        for (const id of descendants(groups, group.id)) hidden.add(id);
    const hiddenContainers = regions.filter((g) => hidden.has(g.id)),
      allowed = regions.filter((g) => !scope || scope.has(g.id));
    const cards = new Set(hiddenContainers.flatMap((g) => g.objectIds)),
      marks = new Set(hiddenContainers.flatMap((g) => g.markIds ?? []));
    if (scope) {
      const cardIds = new Set(allowed.flatMap(regionMemberIds)),
        markIds = new Set(allowed.flatMap((g) => g.markIds ?? []));
      for (const o of options.workspace?.objects ?? []) if (!cardIds.has(o.id)) cards.add(o.id);
      for (const m of options.board.items) if (!markIds.has(m.id)) marks.add(m.id);
    }
    return { cards, marks };
  }, [
    options.workspace?.objects,
    options.workspace?.groups,
    options.board.items,
    focus,
    getUiLocale(),
  ]);
  async function openFolder(group: Group) {
    try {
      await browserCommand(
        'open-region',
        { regionId: group.id, workspaceId: latest.current.workspace?.id },
        120000,
      );
    } catch (error) {
      latest.current.notice(String(error));
    }
  }
  useEffect(() => {
    const open = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        !target?.closest('.react-flow') ||
        target.closest(
          '.react-flow__node,button,input,textarea,select,.canvas-region-header,.canvas-folder-preview',
        )
      )
        return;
      const area = [
        ...document.querySelectorAll<HTMLElement>('.canvas-region-fill[data-file-ai-object]'),
      ]
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter(
          ({ rect: r }) =>
            event.clientX >= r.left &&
            event.clientX <= r.right &&
            event.clientY >= r.top &&
            event.clientY <= r.bottom,
        )
        .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0];
      const group = latest.current.workspace?.groups.items.find(
        (g) => g.id === area?.node.dataset.fileAiObject,
      );
      if (group) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void openFolder(group);
      }
    };
    document.addEventListener('dblclick', open, true);
    return () => document.removeEventListener('dblclick', open, true);
  }, []);
  function enter(group?: Group) {
    setFocus(group?.id ?? null);
    if (group?.bounds) {
      if (group.collapsed) update(group, { collapsed: false });
      options.fit(group.bounds);
    } else {
      const bounds = extent(regions.filter((g) => !g.parentId).map((g) => g.bounds!));
      if (bounds) options.fit(bounds);
    }
  }
  async function saveGroups(items: Group[]) {
    if (saving.current || !latest.current.workspace) return;
    saving.current = true;
    setBusy(true);
    try {
      await latest.current.action('groups_save', {
        requestId: crypto.randomUUID(),
        revision: latest.current.workspace.groups.revision,
        items,
      });
      await latest.current.reload();
      return true;
    } catch (error) {
      latest.current.notice(String(error));
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  function create(parentId?: string, selection?: string[]) {
    const state = latest.current;
    if (!state.workspace || !state.ready() || busy || saving.current) return;
    if (state.workspace.groups.items.length >= 40) {
      state.notice(uiText('最多保留 40 个区域。'));
      return;
    }
    const parent = groups.find((g) => g.id === (typeof parentId === 'string' ? parentId : focus)),
      view = parent?.bounds ?? state.view;
    const selected = typeof parentId === 'string' ? [] : selection ?? state.selected;
    const cards = state.workspace.objects.filter((object) => selected.includes(object.id));
    const marks = typeof parentId === 'string' ? [] : state.selectedMarks();
    const selectedMarks = state.board.items.filter((mark) => marks.includes(mark.id));
    const objectIds = cards.map((object) => object.id);
    const markIds = selectedMarks.map((mark) => mark.id);
    const enclosing = regionBoundsFor([...cards.map((card) => card.bounds), ...selectedMarks]);
    const bounds = enclosing ?? {
      x: Math.max(-100000, Math.min(99000, view.x + view.width / 2 - 380)),
      y: Math.max(-100000, Math.min(99000, view.y + view.height / 2 - 260)),
      width: 760,
      height: 520,
    };
    const group: Group = {
      id: 'region-' + crypto.randomUUID(),
      name: uiText('区域 {0}', { '0': regions.length + 1 }),
      color: 'blue',
      bounds,
      collapsed: false,
      folder: true,
      layout: 'free',
      parentId: parent?.id,
      objectIds,
      markIds,
    };
    if (enclosing) {
      setPlacement(null);
      const updated = state.workspace.groups.items.map((area) => ({
        ...area,
        objectIds: area.objectIds.filter((id) => !objectIds.includes(id)),
        ...(area.markIds ? { markIds: area.markIds.filter((id) => !markIds.includes(id)) } : {}),
      }));
      void saveGroups([...updated, group]).then((saved) => {
        if (saved && latest.current.workspace?.id === state.workspace?.id) {
          state.fit(bounds);
          setEdit({ id: group.id, value: group.name });
        }
      });
      return;
    }
    setPlacement({ workspaceId: state.workspace.id, group });
  }
  useEffect(() => {
    setPlacement(null);
  }, [options.workspace?.id]);
  useEffect(() => {
    if (!placement) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPlacement(null);
      }
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [!!placement]);
  function placementAt(event: React.PointerEvent<HTMLDivElement>) {
    if (!placement) return null;
    const box = event.currentTarget.getBoundingClientRect(),
      v = latest.current.viewport,
      b = placement.group.bounds!;
    return {
      ...placement.group,
      bounds: {
        ...b,
        x: Math.max(
          -100000,
          Math.min(100000, (event.clientX - box.left - v.x) / v.zoom - b.width / 2),
        ),
        y: Math.max(
          -100000,
          Math.min(100000, (event.clientY - box.top - v.y) / v.zoom - b.height / 2),
        ),
      },
    };
  }
  async function place(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || saving.current || !placement) return;
    const state = latest.current,
      group = placementAt(event);
    if (
      !state.workspace ||
      state.workspace.id !== placement.workspaceId ||
      !group ||
      !state.ready()
    )
      return;
    if (group.parentId && !state.workspace.groups.items.some((g) => g.id === group.parentId)) {
      state.notice('父区域已改变，请重新新建');
      setPlacement(null);
      return;
    }
    setPlacement({ ...placement, group });
    if (await saveGroups([...state.workspace.groups.items, group])) setPlacement(null);
  }

  function begin(event: React.PointerEvent, group: Group, mode: 'move' | 'resize') {
    if (
      event.button !== 0 ||
      busy ||
      !latest.current.ready() ||
      !group.bounds ||
      !latest.current.workspace
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const state = latest.current,
      area = group.bounds;
    const ids = descendants(groups, group.id),
      members = groups.filter((g) => ids.has(g.id)),
      cards = new Set(members.flatMap((g) => g.objectIds)),
      marks = new Set(members.flatMap((g) => g.markIds ?? []));
    const item: Drag = {
      group,
      cards: state
        .workspace!.objects.filter((object) => cards.has(object.id))
        .map((object) => ({ id: object.id, x: object.bounds.x, y: object.bounds.y })),
      marks: state.board.items.filter((mark) => marks.has(mark.id)),
      start: { x: event.clientX, y: event.clientY },
      zoom: state.viewport.zoom,
      dx: 0,
      dy: 0,
      mode,
      workspace: { ...state.workspace!, canvasBoard: state.board },
      boardRevision: state.board.revision,
    };
    drag.current = item;
    setPreview(item);
    setBusy(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: React.PointerEvent) {
    const item = drag.current;
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = item.group.bounds!,
      all = [bounds, ...item.cards, ...item.marks];
    let dx = (event.clientX - item.start.x) / item.zoom,
      dy = (event.clientY - item.start.y) / item.zoom;
    if (item.mode === 'move') {
      dx = Math.max(
        Math.max(...all.map((r) => -100000 - r.x)),
        Math.min(Math.min(...all.map((r) => 100000 - r.x)), dx),
      );
      dy = Math.max(
        Math.max(...all.map((r) => -100000 - r.y)),
        Math.min(Math.min(...all.map((r) => 100000 - r.y)), dy),
      );
      latest.current.previewCards(
        item.cards.map((card) => ({ ...card, x: card.x + dx, y: card.y + dy })),
        'preview',
      );
    } else {
      dx = Math.max(320 - bounds.width, Math.min(200000 - bounds.width, dx));
      dy = Math.max(200 - bounds.height, Math.min(200000 - bounds.height, dy));
    }
    item.dx = dx;
    item.dy = dy;
    setPreview({ ...item });
  }
  function cancel() {
    const item = drag.current;
    drag.current = null;
    if (item) latest.current.previewCards(item.cards, 'cancel');
    setPreview(null);
    setBusy(false);
  }
  async function finish(event: React.PointerEvent) {
    const item = drag.current;
    if (!item) return;
    move(event);
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    try {
      if (Math.abs(item.dx) + Math.abs(item.dy) < 0.5) {
        latest.current.previewCards(item.cards, 'cancel');
        return;
      }
      if (item.mode === 'resize') {
        const bounds = {
          ...item.group.bounds!,
          width: item.group.bounds!.width + item.dx,
          height: item.group.bounds!.height + item.dy,
        };
        await latest.current.action('groups_save', {
          requestId: crypto.randomUUID(),
          revision: item.workspace.groups.revision,
          items: item.workspace.groups.items.map((group) =>
            group.id === item.group.id ? { ...group, bounds } : group,
          ),
        });
        await latest.current.reload();
      } else {
        const workspace = await latest.current.action('canvas_region_move', {
          requestId: crypto.randomUUID(),
          id: item.group.id,
          groupsRevision: item.workspace.groups.revision,
          viewRevision: item.workspace.viewRevision,
          boardRevision: item.boardRevision,
          dx: item.dx,
          dy: item.dy,
        });
        latest.current.previewCards(
          item.cards.map((card) => ({ ...card, x: card.x + item.dx, y: card.y + item.dy })),
          'cancel',
        );
        latest.current.updated(workspace);
        recordMove(item, workspace);
      }
    } catch (error) {
      latest.current.previewCards(item.cards, 'cancel');
      latest.current.notice(
        uiText('区域保存未确认，正在重新读取已保存的位置：{0}', { '0': String(error) }),
      );
      await latest.current.reload().catch(() => {});
    } finally {
      setPreview(null);
      setBusy(false);
    }
  }
  function recordMove(item: Drag, after: Workspace) {
    const ids = descendants(item.workspace.groups.items, item.group.id),
      cardIds = new Set(item.cards.map((card) => card.id)),
      markIds = new Set(item.marks.map((mark) => mark.id));
    const signature = (w: Workspace) =>
      JSON.stringify({
        groups: w.groups.items
          .filter((g) => ids.has(g.id))
          .map((g) => ({
            id: g.id,
            bounds: g.bounds,
            objectIds: g.objectIds,
            markIds: g.markIds,
            parentId: g.parentId,
          })),
        cards: w.objects
          .filter((o) => cardIds.has(o.id))
          .map((o) => ({ id: o.id, bounds: o.bounds })),
        marks: (w.canvasBoard?.items ?? []).filter((m) => markIds.has(m.id)),
      });
    const beforeSignature = signature(item.workspace),
      afterSignature = signature(after);
    latest.current.onHistory({
      check: (redo) => {
        const w = latest.current.workspace;
        if (
          !w ||
          w.id !== item.workspace.id ||
          signature({ ...w, canvasBoard: latest.current.board }) !==
            (redo ? beforeSignature : afterSignature)
        )
          throw Error(uiText('区域或内部材料已有后续修改，无法撤销这次移动。'));
      },
      apply: async (redo) => {
        const state = latest.current,
          w = state.workspace!;
        setBusy(true);
        try {
          const result = await state.action('canvas_region_move', {
            requestId: crypto.randomUUID(),
            id: item.group.id,
            groupsRevision: w.groups.revision,
            viewRevision: w.viewRevision,
            boardRevision: state.board.revision,
            dx: item.dx * (redo ? 1 : -1),
            dy: item.dy * (redo ? 1 : -1),
          });
          state.updated(result);
        } finally {
          setBusy(false);
        }
      },
    });
  }
  function update(group: Group, patch: Partial<Group>) {
    if (!latest.current.ready() || busy) return;
    void saveGroups(groups.map((item) => (item.id === group.id ? { ...item, ...patch } : item)));
  }
  async function layout(group: Group, value: 'free' | 'grid' | 'list') {
    const state = latest.current;
    if (!state.workspace || busy || !state.ready()) return;
    setBusy(true);
    try {
      const result = await state.action('canvas_region_move', {
        requestId: crypto.randomUUID(),
        id: group.id,
        groupsRevision: state.workspace.groups.revision,
        viewRevision: state.workspace.viewRevision,
        boardRevision: state.board.revision,
        dx: 0,
        dy: 0,
        layout: value,
      });
      state.updated(result);
      const bounds = result.groups.items.find((g: Group) => g.id === group.id)?.bounds;
      if (bounds) state.fit(bounds);
    } catch (error) {
      state.notice(String(error));
    } finally {
      setBusy(false);
    }
  }
  async function saveName() {
    if (!edit || saving.current) return;
    const group = groups.find((group) => group.id === edit.id);
    const name = edit.value.trim();
    if (!group || !name || name === group.name) {
      setEdit(null);
      return;
    }
    if (await saveGroups(groups.map((item) => item.id === group.id ? { ...item, name } : item)))
      setEdit((current) => current === edit ? null : current);
  }
  const presentationMarks =
    preview?.mode === 'move'
      ? preview.marks.map((mark) => ({ ...mark, x: mark.x + preview.dx, y: mark.y + preview.dy }))
      : [];
  const visible = visibleGroups.filter(
    (group) =>
      overlaps(group.bounds!, {
        x: options.view.x - 500,
        y: options.view.y - 500,
        width: options.view.width + 1000,
        height: options.view.height + 1000,
      }) || preview?.group.id === group.id,
  );
  const boxes = visible.map((group) => {
    const moving =
        preview &&
        (preview.group.id === group.id ||
          (preview.mode === 'move' && descendants(groups, preview.group.id).has(group.id)))
          ? preview
          : null,
      bounds = { ...group.bounds! };
    if (moving) {
      if (moving.mode === 'move') {
        bounds.x += moving.dx;
        bounds.y += moving.dy;
      } else {
        bounds.width += moving.dx;
        bounds.height += moving.dy;
      }
    }
    return { group, bounds };
  });
  const layer = (
    <>
      {placement && (
        <div
          className="canvas-region-placement"
          data-canvas-toolbar
          onPointerMove={(event) => {
            if (saving.current) return;
            const group = placementAt(event);
            if (group) setPlacement({ ...placement, group });
          }}
          onPointerDown={(event) => void place(event)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!saving.current) setPlacement(null);
          }}
        >
          <div
            className="canvas-region-placement-ghost"
            style={{
              left: options.viewport.x + placement.group.bounds!.x * options.viewport.zoom,
              top: options.viewport.y + placement.group.bounds!.y * options.viewport.zoom,
              width: placement.group.bounds!.width * options.viewport.zoom,
              height: placement.group.bounds!.height * options.viewport.zoom,
            }}
          >
            <strong>{placement.group.name}</strong>
          </div>
          <div
            className="canvas-region-placement-hint"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <span>{busy ? '正在保存区域…' : '移动鼠标摆放 · 点击确定 · Esc 取消'}</span>
            <button disabled={busy} onClick={() => setPlacement(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      {active && (
        <nav className="canvas-folder-path" aria-label={uiText('区域路径')} data-canvas-toolbar>
          <button onClick={() => enter()}>{uiText('桌面')}</button>
          {(() => {
            const path: Group[] = [];
            let g: Group | undefined = active;
            const seen = new Set<string>();
            while (g && !seen.has(g.id)) {
              path.unshift(g);
              seen.add(g.id);
              g = groups.find((p) => p.id === g!.parentId);
            }
            return path.map((g) => (
              <React.Fragment key={g.id}>
                <span>/</span>
                <button aria-current={g.id === focus ? 'page' : undefined} onClick={() => enter(g)}>
                  {g.name}
                </button>
              </React.Fragment>
            ));
          })()}
        </nav>
      )}
      <div className="canvas-regions-background" aria-hidden="true">
        <div
          style={{
            position: 'absolute',
            inset: 0,
            transformOrigin: '0 0',
            transform: `translate(${options.viewport.x}px,${options.viewport.y}px) scale(${options.viewport.zoom})`,
          }}
        >
          {boxes.map(({ group, bounds }) => (
            <div
              key={group.id}
              data-file-ai-object={group.id}
              className={`canvas-region-fill region-${group.color} ${group.collapsed ? 'is-collapsed' : ''}`}
              style={{
                left: bounds.x,
                top: bounds.y,
                width: group.collapsed ? 260 : bounds.width,
                height: group.collapsed ? 110 : bounds.height,
                borderWidth: 1 / options.viewport.zoom,
                borderRadius: 15 / options.viewport.zoom,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  ...regionBackgroundStyle(group.background),
                }}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="canvas-regions-handles" data-canvas-toolbar>
        {boxes.map(({ group, bounds }) => (
          <React.Fragment key={group.id}>
            <div
              data-file-ai-object={group.id}
              className={`canvas-region-header region-${group.color} ${group.collapsed ? 'is-collapsed' : ''}`}
              style={{
                left: options.viewport.x + bounds.x * options.viewport.zoom,
                top: options.viewport.y + (bounds.y - 32) * options.viewport.zoom,
                width: group.collapsed ? 260 : 'max-content',
                transform: `scale(${options.viewport.zoom})`,
                transformOrigin: '0 0',
              }}
              onWheel={forwardWheel}
              onPointerDown={(event) => {
                if (!(event.target as Element).closest('button,input,select'))
                  begin(event, group, 'move');
              }}
              onPointerMove={move}
              onPointerUp={(event) => void finish(event)}
              onPointerCancel={cancel}
              onLostPointerCapture={() => {
                if (drag.current) cancel();
              }}
            >
              <button
                disabled={busy}
                title={group.collapsed ? uiText('展开区域') : uiText('收起区域')}
                aria-label={group.collapsed ? uiText('展开区域') : uiText('收起区域')}
                onClick={() => update(group, { collapsed: !group.collapsed })}
              >
                {group.collapsed ? '▸' : '▾'}
              </button>
              <Icon name="folder" size={15} />
              {edit?.id === group.id ? (
                <input
                  autoFocus
                  value={edit.value}
                  maxLength={80}
                  aria-label={uiText('区域名称')}
                  onChange={(event) => setEdit({ ...edit, value: event.target.value })}
                  onBlur={saveName}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') event.currentTarget.blur();
                    if (event.key === 'Escape') setEdit(null);
                  }}
                />
              ) : (
                <strong
                  title={uiText('拖动移动 · 双击打开文件夹')}
                  onDoubleClick={() => {
                    if (!busy) void openFolder(group);
                  }}
                >
                  {group.name}
                </strong>
              )}
              <small>
                {regionMemberIds(group).filter((id) => objectIds.has(id)).length +
                  (group.markIds?.length ?? 0) +
                  groups.filter((g) => g.parentId === group.id).length}{' '}
                {uiText('项')}
              </small>
              <span className="canvas-region-actions">
                <select
                  disabled={busy}
                  aria-label={uiText('区域排版')}
                  value={group.layout ?? 'free'}
                  onChange={(event) =>
                    void layout(group, event.target.value as 'free' | 'grid' | 'list')
                  }
                >
                  <option value="free">{uiText('自由排版')}</option>
                  <option value="grid">{uiText('网格')}</option>
                  <option value="list">{uiText('列表')}</option>
                </select>
                <button
                  disabled={busy}
                  title={uiText('询问此区域')}
                  aria-label={uiText('询问此区域')}
                  onClick={(event) => {
                    event.stopPropagation();
                    window.dispatchEvent(
                      new CustomEvent('ai-desktop:ask-region', {
                        detail: { node: event.currentTarget.closest('[data-file-ai-object]') },
                      }),
                    );
                  }}
                >
                  <Icon name="comment" size={14} />
                </button>
                <button
                  disabled={busy}
                  title="区域背景"
                  aria-label="区域背景"
                  onClick={() => setBackgroundId(group.id)}
                >
                  <Icon name="image" size={14} />
                </button>
                <button
                  disabled={busy}
                  title={uiText('新建子区域')}
                  aria-label={uiText('新建子区域')}
                  onClick={() => create(group.id)}
                >
                  <Icon name="plus" size={14} />
                </button>
                <button
                  disabled={busy}
                  title={uiText('重命名')}
                  aria-label={uiText('重命名')}
                  onClick={() => setEdit({ id: group.id, value: group.name })}
                >
                  <Icon name="pen" size={14} />
                </button>
                <button
                  title={uiText('进入区域')}
                  aria-label={uiText('进入区域')}
                  onClick={() => enter(group)}
                >
                  <Icon name="expand" size={12} />
                </button>
                <button
                  disabled={busy}
                  title={uiText('移除区域框，保留内部内容')}
                  aria-label={uiText('移除区域框')}
                  onClick={() => setRemove(group.id)}
                >
                  <Icon name="close" size={12} />
                </button>
              </span>
            </div>
            {group.collapsed && (
              <div
                className="canvas-folder-preview"
                style={{
                  left: options.viewport.x + bounds.x * options.viewport.zoom,
                  top: options.viewport.y + bounds.y * options.viewport.zoom,
                  width: 260,
                  height: 110,
                  transform: `scale(${options.viewport.zoom})`,
                  transformOrigin: '0 0',
                }}
                onWheel={forwardWheel}
                onDoubleClick={() => void openFolder(group)}
              >
                {[
                  ...groups.filter((g) => g.parentId === group.id).map((g) => `▸ ${g.name}`),
                  ...(options.workspace?.objects
                    .filter((o) => regionMemberIds(group).includes(o.id))
                    .map((o) => o.title) ?? []),
                ]
                  .slice(0, 3)
                  .map((name, i) => (
                    <span key={i}>{name}</span>
                  ))}
                {!regionMemberIds(group).length && !groups.some((g) => g.parentId === group.id) && (
                  <span>{uiText('空区域')}</span>
                )}
              </div>
            )}
            {!group.collapsed && (
              <button
                className="canvas-region-resize"
                aria-label={uiText('调整 {0} 大小', { '0': group.name })}
                title={uiText('调整区域大小')}
                disabled={busy && !drag.current}
                style={{
                  left: options.viewport.x + (bounds.x + bounds.width - 10) * options.viewport.zoom,
                  top: options.viewport.y + (bounds.y + bounds.height - 10) * options.viewport.zoom,
                  transform: `scale(${options.viewport.zoom})`,
                  transformOrigin: '0 0',
                }}
                onPointerDown={(event) => begin(event, group, 'resize')}
                onPointerMove={move}
                onPointerUp={(event) => void finish(event)}
                onPointerCancel={cancel}
                onLostPointerCapture={() => {
                  if (drag.current) cancel();
                }}
              >
                ⌟
              </button>
            )}
          </React.Fragment>
        ))}
      </div>
      {backgroundId && groups.find((g) => g.id === backgroundId) && (
        <RegionBackgroundEditor
          key={backgroundId}
          group={groups.find((g) => g.id === backgroundId)!}
          close={() => setBackgroundId(null)}
          save={async (background) => {
            const state = latest.current;
            if (!state.workspace || !state.ready()) return false;
            return !!(await saveGroups(
              state.workspace.groups.items.map((g) =>
                g.id === backgroundId ? { ...g, background } : g,
              ),
            ));
          }}
        />
      )}
      {remove && (
        <div
          className="canvas-region-confirm"
          role="alertdialog"
          aria-label={uiText('移除区域')}
          data-canvas-toolbar
        >
          <strong>{uiText('解散这个区域？')}</strong>
          <p>{uiText('内容保留并移到上一级。')}</p>
          <div>
            <button onClick={() => setRemove(null)}>{uiText('取消')}</button>
            <button
              onClick={() => {
                const removed = groups.find((g) => g.id === remove)!;
                void saveGroups(
                  groups
                    .filter((g) => g.id !== remove)
                    .map((g) => ({
                      ...g,
                      parentId: g.parentId === remove ? removed.parentId : g.parentId,
                      ...(g.id === removed.parentId
                        ? {
                            objectIds: [...g.objectIds, ...removed.objectIds],
                            ...((g.linkedObjectIds || removed.linkedObjectIds) ? {
                              linkedObjectIds: [...new Set([
                                ...(g.linkedObjectIds ?? []), ...(removed.linkedObjectIds ?? []),
                              ])],
                            } : {}),
                            markIds: [...(g.markIds ?? []), ...(removed.markIds ?? [])],
                          }
                        : {}),
                    })),
                );
                if (focus === remove) setFocus(removed.parentId ?? null);
                setRemove(null);
              }}
            >
              {uiText('解散区域')}
            </button>
          </div>
        </div>
      )}
    </>
  );
  return {
    regions,
    collapsed,
    busy,
    layer,
    create,
    locate: (group: Group) => {
      if (!group.bounds) return;
      setFocus(null);
      const trail = new Set([group.id]);
      for (let parent = group.parentId; parent && !trail.has(parent); ) {
        trail.add(parent);
        parent = groups.find((item) => item.id === parent)?.parentId;
      }
      if (groups.some((item) => item.collapsed && trail.has(item.id)))
        void saveGroups(groups.map((item) => trail.has(item.id) ? { ...item, collapsed: false } : item));
      options.fit(group.bounds);
    },
    presentationMarks,
    unfoldFor: async (ids: string[]) => {
      setFocus(null);
      const unfold = new Set<string>();
      for (const g of regions)
        if (g.objectIds.some((id) => ids.includes(id))) {
          let owner: Group | undefined = g;
          while (owner && !unfold.has(owner.id)) {
            unfold.add(owner.id);
            owner = groups.find((p) => p.id === owner!.parentId);
          }
        }
      if (groups.some((g) => g.collapsed && unfold.has(g.id)))
        await saveGroups(groups.map((g) => (unfold.has(g.id) ? { ...g, collapsed: false } : g)));
    },
  };
}
