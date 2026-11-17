import { createWorkExecution } from './work-execution-view.js';
import { t } from '../../../packages/components/ui-language.js';

// Browsing old runs never resumes them or changes the reply target.
export function createWorkHistory({ workspaceId, expanded = false }) {
  const element = document.createElement('section');
  element.className = 'work-history';
  const picker = document.createElement('select');
  picker.setAttribute('aria-label', t('执行历史'));
  const body = document.createElement('div');
  element.append(picker, body);
  let threads = [], chosen = null, view = null;
  function render() {
    const current = threads.find(run => run.threadId === chosen);
    if (!current) return;
    const live = threads.some(run => run.threadId === chosen &&
      ['starting', 'running', 'waiting', 'stopping'].includes(run.state));
    if (view?.threadId !== chosen) {
      view?.dispose();
      view = { ...createWorkExecution({ workspaceId, threadId: chosen, live, expanded }), threadId: chosen };
      body.replaceChildren(view.element);
    }
    view.setLive(live);
    view.resume();
  }
  picker.onchange = () => { chosen = picker.value; render(); };
  return { element, update(runs = []) {
    const all = runs.filter(run => run.threadId && run.threadId !== 'pending');
    // A resumed CLI thread already contains its previous turns: list it once.
    threads = [...new Map(all.map(run => [run.threadId, run])).values()];
    if (!threads.some(run => run.threadId === chosen)) chosen = threads.at(-1)?.threadId;
    picker.replaceChildren(...threads.map((run, index) => {
      const option = document.createElement('option');
      option.value = run.threadId;
      option.textContent = `${t('执行记录')} ${index + 1}${run.createdAt ? ' · ' + new Date(run.createdAt).toLocaleString() : ''}`;
      return option;
    }));
    picker.value = chosen || '';
    picker.hidden = threads.length < 2;
    element.hidden = !threads.length;
    if (!threads.length) { view?.dispose(); view = null; body.replaceChildren(); }
    else render();
  }, dispose() { view?.dispose(); } };
}
