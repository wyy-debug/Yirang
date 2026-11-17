import { mainText } from '../main-text.mjs';

export function collectTurnReferences(attached, extra) {
  const references = [...attached, ...extra].flatMap((block) =>
    block?._meta?.['ai-desktop/selection'] ? [block._meta['ai-desktop/selection']] : [],
  );
  return {
    quoteOnly:
      attached.some((block) => block?._meta?.['ai-desktop/quote']) &&
      !attached.some((block) => block?._meta?.['ai-desktop/selection']),
    references,
    sourceIds: [
      ...new Set(references.flatMap((ref) => ref.objects?.map((object) => object.id) || [])),
    ],
  };
}

export function buildTurnInput({
  text,
  attached,
  extra,
  work,
  consult,
  queued,
  sendReview,
  batch,
  projectCwd,
  outputRoot,
  quoteOnly,
  workflowDispatchId,
}) {
  const context = {
    type: 'yirang.turn-context',
    interaction: mainText('turnInteraction.instructions'),
    taskId: work?.task.id ?? null,
    runId: work?.run.id ?? null,
    consultation: !!consult,
    quoteOnly,
    review: !!sendReview,
    queueId: queued?.queueId ?? null,
    ...(workflowDispatchId ? { workflowDispatchId } : {}),
    output: consult
      ? null
      : {
          batchId: batch.id,
          instructions: mainText('turnOutput.instructions'),
          directory: batch.directory,
          workspaceDirectory: batch.workspaceDirectory ?? outputRoot,
          cwd: work ? batch.directory : projectCwd || batch.directory,
          existingFiles: batch.baseline || {},
        },
    materials: [...attached, ...extra]
      .filter((block) => block.type === 'text')
      .map((block) => ({ text: block.text, metadata: block._meta })),
  };
  const blocks = [
    { type: 'text', text, text_elements: [] },
    { type: 'text', text: JSON.stringify(context), text_elements: [] },
  ];
  for (const block of [...attached, ...extra]) {
    if (
      block.type === 'image' &&
      typeof block.data === 'string' &&
      typeof block.mimeType === 'string'
    ) {
      blocks.push({ type: 'image', url: `data:${block.mimeType};base64,${block.data}` });
    }
  }
  return blocks;
}
