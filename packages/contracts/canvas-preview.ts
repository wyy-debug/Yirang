import type { OfficePage } from './office.js';
import type { XlsxPage } from './xlsx.js';

export type CanvasPreview =
  | { kind: 'svg'; text: string }
  | { kind: 'html'; text: string; truncated: boolean }
  | { kind: 'text' | 'code'; text: string; truncated: boolean; language: string }
  | { kind: 'sheet'; sheet: XlsxPage }
  | { kind: 'office'; page: OfficePage }
  | {
      kind: 'image';
      dataUrl: string;
      width?: number;
      height?: number;
      sourceWidth?: number;
      sourceHeight?: number;
      quality?: 'thumbnail' | 'original';
    }
  | { kind: 'pdf'; dataUrl: string; page: number; pages: number; width: number; height: number }
  | { kind: 'file'; label: string; reason?: string };
export type DesktopLibrary = { favoriteIds: string[]; recentIds: string[] };
