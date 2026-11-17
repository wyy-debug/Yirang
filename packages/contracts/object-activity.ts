export type ObjectActivity = {
  label: string;
  at: string;
  type: string;
  revision?: number;
  taskId?: string;
  events: { type: string; actor: string; at: string; revision?: number }[];
};
