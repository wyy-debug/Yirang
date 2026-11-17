type ConversationRequest = {
  id: string;
  workRequestIds?: string[];
  [key: string]: unknown;
};
type ConversationPage = {
  workspaceId: string;
  requests: ConversationRequest[];
  [key: string]: unknown;
};
export function attachConversationReports(
  page: ConversationPage,
  snapshot: { workspaceId: string; tasks: unknown[] },
): ConversationPage & { requests: (ConversationRequest & { reports: unknown[] })[] };
