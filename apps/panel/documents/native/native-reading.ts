import { flushDraftStorage, scheduleDraftWrite } from '../draft-storage.js';

export type ReadingPosition = {
  page: number;
  zoom: number;
  left: number;
  top: number;
  revision: number;
  updatedAt: number;
};
export const readingKey = (workspace: string, objectId: string) =>
  `native-reading:${workspace}:${objectId}`;
const bounded = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
export function readPosition(key: string, objectId: string, revision: number): ReadingPosition {
  let saved: any = null,
    focus: any = null;
  try {
    saved = JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    /* Storage can be unavailable in a host WebView. */
  }
  try {
    focus = JSON.parse(sessionStorage.getItem(`native-focus:${objectId}`) ?? 'null');
    if (Number.isFinite(focus?.page)) sessionStorage.removeItem(`native-focus:${objectId}`);
  } catch {}
  const focusedPage = Number.isFinite(focus?.page)
    ? focus.page + (focus.pageBase === 0 ? 1 : 0)
    : undefined;
  return {
    page: Math.floor(bounded(focusedPage ?? saved?.page, 1, 100000, 1)),
    zoom: bounded(saved?.zoom, 0.25, 3, 1),
    left: focusedPage !== undefined ? 0 : bounded(saved?.left, 0, 10000000, 0),
    top: focusedPage !== undefined ? 0 : bounded(saved?.top, 0, 10000000, 0),
    revision,
    updatedAt: Date.now(),
  };
}
export function rememberPosition(key: string, value: ReadingPosition) {
  scheduleDraftWrite(
    key,
    () => JSON.stringify(value),
    () => {},
    450,
  );
}
export function flushPosition(key: string) {
  flushDraftStorage(key);
}
