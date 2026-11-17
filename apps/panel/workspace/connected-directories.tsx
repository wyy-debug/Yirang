import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useRef, useState } from 'react';
import './external-resources.css';
type Action = (name: string, payload?: Record<string, unknown>) => Promise<any>;
export function ConnectedDirectories({ action }: { action: Action }) {
  useUiLocale();
  const [connections, setConnections] = useState<any[]>([]),
    [id, setId] = useState(''),
    [path, setPath] = useState(''),
    [access, setAccess] = useState('read'),
    [scan, setScan] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [comparison, setComparison] = useState<any>(null),
    [offset, setOffset] = useState(0),
    [rename, setRename] = useState<any>(null);
  const actions = useRef(action),
    current = useRef({ id, offset });
  actions.current = action;
  current.current = { id, offset };
  const call = (command: any) =>
    actions.current('native_workbench', { operation: 'directories', command });
  async function load() {
    setConnections(await call({ operation: 'list' }));
  }
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    if (!id) {
      setScan(null);
      return;
    }
    let live = true,
      running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const result = await call({ operation: 'scan', connectionId: id, offset });
        if (live) setScan(result);
      } catch (e) {
        if (live) setError(String(e));
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [id, offset]);
  async function run(command: any) {
    setBusy(true);
    setError('');
    try {
      const result = await call(command);
      await load();
      if (id && current.current.id === id && command.operation !== 'revoke')
        setScan(
          await call({ operation: 'scan', connectionId: id, offset: current.current.offset }),
        );
      return result;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }
  function choose(value: string) {
    setId(value);
    setOffset(0);
    setComparison(null);
    setRename(null);
    setScan(null);
    setError('');
  }
  async function compare(file: any) {
    const result = await run({
      operation: 'status',
      connectionId: id,
      relativePath: file.relativePath,
    });
    if (result) setComparison({ file, ...result });
  }
  async function inspectRename() {
    if (!rename?.targetPath) return;
    const result = await run({
      operation: 'status',
      connectionId: id,
      relativePath: rename.targetPath,
    });
    if (result) setRename({ ...rename, sourceHash: result.sourceHash });
  }
  return (
    <section className="connected-directories">
      <h2>{uiText('连接本机文件夹')}</h2>
      <p>
        {uiText(
          '连接后可导入文件和同步更新。需要将修改写回原文件时，选择「允许保存回原文件」。',
        )}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run({ operation: 'connect', path, access }).then((c) => {
            if (c) choose(c.id);
          });
        }}
      >
        <label className="directory-path">
          {uiText('文件夹完整路径')}
          <input
            required
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="F:\Documents\Project"
          />
        </label>
        <label className="directory-access">
          {uiText('权限')}
          <select value={access} onChange={(e) => setAccess(e.target.value)}>
            <option value="read">{uiText('只读取')}</option>
            <option value="write">{uiText('允许保存回原文件')}</option>
          </select>
        </label>
        <button className="resource-submit" disabled={busy || !path.trim()}>
          {uiText('连接文件夹')}
        </button>
      </form>
      <nav>
        {connections.map((c) => (
          <button
            key={c.id}
            disabled={busy}
            onClick={() => choose(c.id)}
            aria-pressed={id === c.id}
          >
            {c.path} · {c.access === 'write' ? uiText('可保存回原文件') : uiText('只读取')}
          </button>
        ))}
      </nav>
      {error && <p role="alert">{error}</p>}
      {scan && (
        <>
          <div className="resource-actions">
            <button
              disabled={busy}
              onClick={() => void run({ operation: 'scan', connectionId: id, offset })}
            >
              {uiText('刷新文件')}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void run({ operation: 'revoke', connectionId: id }).then((r) => {
                  if (r) choose('');
                })
              }
            >
              {uiText('断开文件夹（保留桌面上的文件）')}
            </button>
          </div>
          {scan.truncated && (
            <p>
              {uiText(
                '文件夹中的内容太多，只显示了一部分。建议改为连接其中更小的子文件夹；没有显示的文件不会被当作已删除。',
              )}
            </p>
          )}
          {scan.issues.map((s: string) => (
            <p key={s}>{s}</p>
          ))}
          <table>
            <thead>
              <tr>
                <th>{uiText('文件')}</th>
                <th>{uiText('状态')}</th>
                <th>{uiText('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {scan.files.map((f: any) => (
                <tr key={f.relativePath}>
                  <td>{f.relativePath}</td>
                  <td>
                    {f.tooLarge
                      ? uiText('超过 50 MB，无法导入')
                      : !f.objectId
                        ? uiText('未导入')
                        : f.sourceChanged && f.desktopChanged
                          ? uiText('两边都有修改')
                          : f.sourceChanged
                            ? uiText('原文件有更新')
                            : f.desktopChanged
                              ? uiText('桌面上有修改')
                              : uiText('没有变化')}
                  </td>
                  <td>
                    <button
                      disabled={busy || f.tooLarge}
                      onClick={() =>
                        void run({
                          operation: 'pull',
                          connectionId: id,
                          relativePath: f.relativePath,
                          requestId: crypto.randomUUID(),
                        })
                      }
                    >
                      {f.objectId ? uiText('获取最新内容') : uiText('导入桌面')}
                    </button>
                    {f.objectId && (
                      <button disabled={busy} onClick={() => void compare(f)}>
                        {uiText('比较差异')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="resource-actions">
            <button disabled={busy || !offset} onClick={() => setOffset(Math.max(0, offset - 200))}>
              {uiText('上一页')}
            </button>
            <span>
              {scan.totalScanned
                ? uiText('{0}–{1} / {2} 个文件', {
                    '0': offset + 1,
                    '1': Math.min(offset + scan.files.length, scan.totalScanned),
                    '2': scan.totalScanned,
                  })
                : uiText('没有找到可以导入的文件')}
            </span>
            <button
              disabled={busy || scan.nextOffset === null}
              onClick={() => setOffset(scan.nextOffset)}
            >
              {uiText('下一页')}
            </button>
          </div>
          {scan.missing.length > 0 && (
            <div className="resource-missing">
              <h3>{uiText('原文件已不存在')}</h3>
              <p>
                {uiText(
                  '桌面上的文件和历史版本都还在。如果原文件改了名或换了位置，可以重新关联；也可以只解除关联。',
                )}
              </p>
              {scan.missing.map((missing: string) => {
                const suggestions =
                  scan.renameSuggestions?.find((r: any) => r.from === missing)?.candidates ?? [];
                return (
                  <article key={missing}>
                    <strong>{missing}</strong>
                    {suggestions.map((s: any) => (
                      <button
                        disabled={busy}
                        key={s.relativePath}
                        onClick={() =>
                          setRename({ relativePath: missing, targetPath: s.relativePath })
                        }
                      >
                        {uiText('重新关联：')}
                        {s.relativePath} ·{' '}
                        {s.match === 'identity' ? uiText('同一文件') : uiText('内容相同')}
                      </button>
                    ))}
                    <button
                      disabled={busy}
                      onClick={() => setRename({ relativePath: missing, targetPath: '' })}
                    >
                      {uiText('手动填写新位置')}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run({ operation: 'detach', connectionId: id, relativePath: missing })
                      }
                    >
                      {uiText('解除关联（保留桌面上的文件）')}
                    </button>
                  </article>
                );
              })}
            </div>
          )}
          {scan.unknown?.length > 0 && (
            <p>
              {uiText('以下文件暂时无法读取，不会被当作已删除：')}
              {scan.unknown.join('、')}
            </p>
          )}
        </>
      )}
      {rename && (
        <aside className="resource-comparison">
          <h3>{uiText('重新关联原文件')}</h3>
          <p>
            {uiText(
              '为「{0}」填写新的位置（相对于连接的文件夹）。桌面上的文件不会改变，之后可以比较并获取最新内容。',
              { '0': rename.relativePath },
            )}
          </p>
          <input
            aria-label={uiText('新位置（相对于连接的文件夹）')}
            value={rename.targetPath}
            onChange={(e) =>
              setRename({ ...rename, targetPath: e.target.value, sourceHash: undefined })
            }
          />
          <button disabled={busy || !rename.targetPath} onClick={() => void inspectRename()}>
            {uiText('检查这个文件')}
          </button>
          {rename.sourceHash && (
            <>
              <p>{uiText('已找到这个文件，确认后即可关联。')}</p>
              <button
                disabled={busy}
                onClick={() =>
                  void run({
                    operation: 'relink',
                    connectionId: id,
                    relativePath: rename.relativePath,
                    targetPath: rename.targetPath,
                    expectedSourceHash: rename.sourceHash,
                  }).then((r) => {
                    if (r) setRename(null);
                  })
                }
              >
                {uiText('确认关联到此文件')}
              </button>
            </>
          )}
          <button disabled={busy} onClick={() => setRename(null)}>
            {uiText('关闭')}
          </button>
        </aside>
      )}
      {comparison && (
        <aside className="resource-comparison">
          <h3>{comparison.file.relativePath}</h3>
          <p>
            {uiText('原文件：{0} 字节', { '0': comparison.sourceSize })}
            {comparison.desktopSize != null && (
              <>
                <br />
                {uiText('桌面文件：{0} 字节', { '0': comparison.desktopSize })}
              </>
            )}
          </p>
          {comparison.comparison?.kind === 'text' ? (
            <>
              <p>
                {comparison.comparison.identical
                  ? uiText('文字内容相同（编码或换行方式可能不同）。')
                  : uiText('从第 {0} 行开始显示有差异的部分。', {
                      '0': comparison.comparison.startLine,
                    })}
              </p>
              <div className="resource-diff">
                <section>
                  <strong>
                    {uiText('原文件 ·')}
                    {comparison.comparison.sourceEncoding} / {comparison.comparison.sourceNewline}
                  </strong>
                  <pre>{comparison.comparison.source}</pre>
                </section>
                <section>
                  <strong>
                    {uiText('桌面文件 ·')}
                    {comparison.comparison.desktopEncoding} / {comparison.comparison.desktopNewline}
                  </strong>
                  <pre>{comparison.comparison.desktop}</pre>
                </section>
              </div>
              {comparison.comparison.truncated && (
                <p>{uiText('内容较长，只显示了前 24,000 个字符，请打开完整文件确认。')}</p>
              )}
            </>
          ) : (
            <p>{comparison.comparison?.message}</p>
          )}
          <p>{uiText('执行前会再检查一次两边的内容；桌面上原来的内容会保留在历史版本中。')}</p>
          <button
            disabled={busy}
            onClick={() =>
              void run({
                operation: 'pull',
                connectionId: id,
                relativePath: comparison.file.relativePath,
                expectedSourceHash: comparison.sourceHash,
                expectedDesktopHash: comparison.desktopHash,
                requestId: crypto.randomUUID(),
              }).then((r) => {
                if (r) setComparison(null);
              })
            }
          >
            {uiText('用原文件更新桌面')}
          </button>
          {scan?.connection.access === 'write' && (
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void actions
                  .current('native_workbench', {
                    operation: 'directories_push',
                    connectionId: id,
                    relativePath: comparison.file.relativePath,
                    expectedSourceHash: comparison.sourceHash,
                    expectedDesktopHash: comparison.desktopHash,
                  })
                  .then(() => {
                    setComparison(null);
                    return run({ operation: 'scan', connectionId: id, offset });
                  })
                  .catch((e) => setError(String(e)))
                  .finally(() => setBusy(false));
              }}
            >
              {uiText('把桌面版本保存回原文件')}
            </button>
          )}
          <button disabled={busy} onClick={() => setComparison(null)}>
            {uiText('关闭')}
          </button>
        </aside>
      )}
    </section>
  );
}
