import { t as uiText } from '../../../packages/components/ui-language.js';
import React from 'react';
import { DESKTOP_VERSION } from '../../../packages/contracts/version.js';
import './panel-error-boundary.css';

/** Keep render failures visible without touching workspace files or chat state. */
export class PanelErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(uiText('工作桌面渲染失败'), error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="panel-render-failure" role="alert">
        <section>
          <span className="panel-failure-symbol" aria-hidden="true">
            ↻
          </span>
          <h1>{uiText('桌面暂时无法显示')}</h1>
          <p>{uiText('已保存的材料仍在本地。重新载入桌面后可以继续使用。')}</p>
          <button type="button" onClick={() => window.location.reload()}>
            {uiText('重新载入桌面')}
          </button>
          <details>
            <summary>
              {uiText('错误详情 ·')}
              {DESKTOP_VERSION}
            </summary>
            <pre>{String(this.state.error)}</pre>
          </details>
        </section>
      </main>
    );
  }
}
