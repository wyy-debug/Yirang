import { createPortal } from 'react-dom';

/** Modal receipt after a bundle export: shows the ZIP path with copy-to-clipboard. */
export function BundleExportDialog(props: {
  path: string;
  onClose: () => void;
  report: (error: unknown) => void;
}) {
  const { path, onClose, report } = props;
  return createPortal(
    <div className="bundle-export-backdrop" onClick={onClose}>
      <section
        className="bundle-export-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="打包完成"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <h2>打包完成</h2>
        <p>所选材料已保存为 ZIP，文件名称和格式已保留。</p>
        <input
          autoFocus
          readOnly
          aria-label="压缩包路径"
          value={path}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          onClick={() => void window.navigator.clipboard.writeText(path).catch(report)}
        >
          复制路径
        </button>
        <button onClick={onClose}>关闭</button>
      </section>
    </div>,
    document.body,
  );
}
