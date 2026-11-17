// Canvas cards and streamed text change frequently. Only browser geometry and
// overlays can affect native view placement; unrelated mutations need no layout.
export function observeBrowserGeometry(
  root: () => HTMLElement | null,
  selectors: string,
  schedule: () => void,
) {
  const relevant = (value: Node, descendants = false) => {
    if (!(value instanceof Element)) return false;
    const current = root();
    return !!(
      (current && (value === current || current.contains(value) || value.contains(current))) ||
      value.matches(selectors) ||
      value.closest(selectors) ||
      (descendants && value.querySelector(selectors))
    );
  };
  const observer = new MutationObserver((records) => {
    if (
      records.some((record) =>
        record.type === 'attributes'
          ? relevant(record.target)
          : (record.target instanceof Element &&
              (!!root()?.contains(record.target) || !!record.target.closest(selectors))) ||
            [...record.addedNodes, ...record.removedNodes].some((value) => relevant(value, true)),
      )
    )
      schedule();
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'open'],
  });
  return observer;
}
