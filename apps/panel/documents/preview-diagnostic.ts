import type { DesktopObject } from '../../../packages/contracts/index.js';

export function previewDiagnostic(
  action: 'open' | 'close' | 'zoom',
  object: DesktopObject,
  zoom?: number,
) {
  const preview = {
    action,
    objectId: object.id,
    kind: object.kind,
    revision: object.revision,
    ...(zoom === undefined ? {} : { zoom }),
  };
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'ai-desktop:preview-diagnostic', preview }, '*');
  } else {
    console.info('YIRANG_PREVIEW_EVENT:' + JSON.stringify(preview));
  }
}
