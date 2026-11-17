export type PreviewSourceSpan = { start: number; end: number; text: string };
/** DOM Range boundaries identify occurrences; source text is never searched. */
export function previewSourceSelection(root: HTMLElement, range: Range): PreviewSourceSpan[] {
  const spans: PreviewSourceSpan[] = [];
  for (const element of root.querySelectorAll<HTMLElement>('[data-source-start]')) {
    if (!range.intersectsNode(element)) continue;
    const full = document.createRange();
    full.selectNodeContents(element);
    const clipped = full.cloneRange();
    if (range.compareBoundaryPoints(Range.START_TO_START, full) > 0)
      clipped.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, full) < 0)
      clipped.setEnd(range.endContainer, range.endOffset);
    const text = clipped.toString();
    if (!text) continue;
    const prefix = full.cloneRange();
    prefix.setEnd(clipped.startContainer, clipped.startOffset);
    const start = Number(element.dataset.sourceStart) + prefix.toString().length,
      end = start + text.length;
    if (!Number.isSafeInteger(start) || start < 0) throw Error('Invalid preview source position');
    const previous = spans.at(-1);
    if (previous?.end === start) {
      previous.end = end;
      previous.text += text;
    } else spans.push({ start, end, text });
  }
  return spans;
}
