import { mainText } from '../main-text.mjs';

export function createMicroManagement({ evolution, share, confirm, saveExport }) {
  return async (workspaceId, operation, input) => {
    if (operation === 'evolution_list') return evolution.list(workspaceId, input.instanceId);
    if (operation === 'evolution_check') return evolution.check(workspaceId);
    if (operation === 'evolution_regress') return evolution.regress(workspaceId, input.id);
    if (operation === 'evolution_discard') return evolution.discard(workspaceId, input.id);
    if (operation === 'evolution_publish') {
      const improvement = (await evolution.list(workspaceId, input.instanceId)).improvements.find(
        (item) => item.id === input.id,
      );
      if (!improvement) throw Error(mainText('microManage.001'));
      const comparison = improvement.regression?.comparison;
      const accepted = await confirm(
        mainText('microManage.002'),
        mainText('microManage.003') + improvement.version + '？',
        (comparison
          ? mainText('microManage.004') + comparison.reason + '\n'
          : mainText('microManage.005')) +
          (improvement.state === 'held' ? mainText('microManage.006') : '') +
          mainText('microManage.007') +
          improvement.changes.join('、') +
          mainText('microManage.008') +
          improvement.rationale +
          mainText('microManage.009') +
          improvement.diff.prompt.after,
        mainText('host.081'),
      );
      if (!accepted) throw Error(mainText('host.082'));
      return evolution.publish(workspaceId, input.id);
    }
    if (operation === 'evolution_rollback') {
      const accepted = await confirm(
        mainText('microManage.010'),
        mainText('microManage.011'),
        mainText('microManage.012'),
        mainText('microManage.013'),
      );
      if (!accepted) throw Error(mainText('microManage.014'));
      return evolution.rollback(workspaceId, input.id);
    }
    if (operation === 'micro_templates') return share.templates();
    if (operation === 'micro_template_create')
      return share.createFromTemplate(workspaceId, input.templateId);
    if (operation === 'micro_export_plan') return share.exportPlan(workspaceId, input.instanceId);
    if (operation === 'micro_upgrade') {
      const accepted = await confirm(
        mainText('microManage.015'),
        mainText('microManage.016'),
        mainText('microManage.017'),
        mainText('microManage.018'),
      );
      if (!accepted) throw Error(mainText('microManage.019'));
      return share.upgrade(workspaceId, input.instanceId);
    }
    if (operation === 'micro_export') {
      const plan = await share.exportPlan(workspaceId, input.instanceId);
      const examples = new Set(input.decisions?.examples || []);
      const accepted = await confirm(
        mainText('microManage.020'),
        mainText('microManage.021'),
        mainText('microManage.022') +
          plan.files.join('\n') +
          mainText('microManage.023') +
          (examples.size || mainText('host.087')) +
          (input.decisions?.materials?.length
            ? mainText('microManage.024') +
              input.decisions.materials.length +
              mainText('microManage.025')
            : '') +
          (plan.stripped.length ? mainText('microManage.026') : ''),
        mainText('microManage.027'),
      );
      if (!accepted) throw Error(mainText('microManage.028'));
      const result = await share.exportPackage(
        workspaceId,
        input.instanceId,
        input.decisions || {},
      );
      return saveExport(result, plan);
    }
    throw Error(mainText('microManage.030'));
  };
}
