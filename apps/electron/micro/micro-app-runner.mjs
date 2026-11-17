import { mainText } from '../main-text.mjs';

// Page and Bot invocations share this runner so they share grants, records and execution slots.
export function createMicroAppRunner({ apps, authorize, readMaterials, model, kick }) {
  return async (current, input) => {
    const workspaceId = current.workspaceId;
    const info = await apps.internal(workspaceId, 'micro_info', {
      instanceId: input.instanceId,
    });
    if (!info.granted) {
      const accepted = await authorize(info);
      if (!accepted) throw Error(mainText('runMicroApp.005'));
      await apps.internal(workspaceId, 'ai_grant', {
        instanceId: input.instanceId,
        digest: info.aiGrantDigest,
      });
    }

    const ids = (Array.isArray(input.materials) ? input.materials : []).map(String);
    if (
      ids.length > 10 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !current.objects.some((object) => object.id === id))
    )
      throw Error(mainText('runMicroApp.006'));
    const revisions = input.materialRevisions || {};
    const selections = Object.fromEntries(
      Object.entries(input.materialSelections || {}).filter(([id]) => ids.includes(id)),
    );
    const materials = ids.length
      ? await readMaterials({
          objectIds: ids,
          expectedRevisions: Object.fromEntries(
            ids.map((id) => [
              id,
              revisions[id] ?? current.objects.find((object) => object.id === id).revision,
            ]),
          ),
          ...(Object.keys(selections).length ? { selections } : {}),
        })
      : [];
    const run = await apps.internal(workspaceId, 'micro_submit', {
      instanceId: input.instanceId,
      capability: input.capability,
      input: input.input,
      materials,
      requestId: input.requestId,
      model: await model(),
    });
    void kick();
    return run;
  };
}
