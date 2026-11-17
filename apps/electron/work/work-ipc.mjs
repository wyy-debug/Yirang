import { mainText } from '../main-text.mjs';
import { projectWorkReports } from './work-report-journal.mjs';
import { attachConversationReports } from './conversation-reports.mjs';

export function registerWorkIpc({
  ipcMain,
  requireMainFrame,
  workManager,
  desktopValue,
  readChatHistory,
  mainConversation,
}) {
  ipcMain.handle('desktop:work-management', async (event, args = {}) => {
    requireMainFrame(event);
    if (args.command?.operation === 'conversation') {
      const { workspaceId } = await desktopValue('desktop_workspace_overview');
      const [page, snapshot] = await Promise.all([
        mainConversation.page(workspaceId, args.command.payload?.before),
        workManager.command({workspaceId, command: {operation:'list',payload:{compact:true}}}),
      ]);
      return attachConversationReports(page, snapshot);
    }
    if (args.command?.operation === 'conversation_recover') {
      const { workspaceId } = await desktopValue('desktop_workspace_overview');
      const page = await mainConversation.page(workspaceId, args.command.payload?.before);
      await mainConversation.recover(workspaceId, page.requests);
      return mainConversation.page(workspaceId, args.command.payload?.before);
    }
    if (args.command?.operation === 'reports') {
      const snapshot = await workManager.command({
        command: { operation: 'list', payload: { compact: true } },
      });
      return {
        workspaceId: snapshot.workspaceId,
        conversationId: `desktop:${snapshot.workspaceId}:main`,
        events: projectWorkReports(snapshot),
      };
    }
    if (args.command?.operation === 'report_history') {
      return workManager.command({
        command: { operation: 'reports', payload: { before: args.command.payload?.before } },
      });
    }
    if (['execution_history', 'execution_item'].includes(args.command?.operation)) {
      const snapshot = await workManager.command({
        workspaceId: args.workspaceId,
        command: { operation: 'list', payload: { compact: true } },
      });
      const id = args.command.payload?.threadId;
      const cursor = args.command.payload?.cursor;
      if (cursor != null && (typeof cursor !== 'string' || cursor.length > 4096))
        throw Error(mainText('host.130'));
      if (!snapshot.tasks.some((task) => task.management?.runs?.some((run) => run.threadId === id)))
        throw Error(mainText('host.130'));
      const page = await readChatHistory(id, cursor);
      if (args.command.operation === 'execution_item') {
        const { turnId, itemIndex } = args.command.payload || {};
        if (!Number.isSafeInteger(itemIndex) || itemIndex < 0) throw Error(mainText('host.130'));
        const item = page.data?.find(turn => turn.id === turnId)?.items?.[itemIndex];
        if (!item || item.type === 'userMessage') throw Error(mainText('host.130'));
        return item;
      }
      return {...page, data: (page.data || []).map(turn => ({...turn,
        items: (turn.items || []).flatMap((item, itemIndex) => item.type === 'userMessage' ? []
          : [item.type === 'agentMessage' ? item : {type:item.type, id:item.id,
            lazy:{turnId:turn.id, itemIndex, cursor:cursor ?? null}}]),
      }))};
    }
    const privateOperations = [
      'orchestration',
      'delegate',
      'consult_bind',
      'consult_unbind',
      'voice_bind',
      'remind',
      'wait',
      'prepare',
      'dispatch',
      'ack',
      'finish',
      'recover',
      'reconcile',
      'progress',
    ];
    if (privateOperations.includes(args.command?.operation)) throw Error(mainText('host.130'));
    return workManager.command(args);
  });
}
