export const resultSchema: Record<string, any>;
export function isolatedConfig(servers: string[]): Record<string, any>;
export function createAgentPoolRunner(options: {
  call: (w: string, p: any) => Promise<any>;
  request: (method: string, params: any) => Promise<any>;
  workspaces: () => Promise<string[]>;
  cwd: string;
  readTurn: (threadId: string, turnId: string) => Promise<any>;
  interval?: number;
}): {
  start(): Promise<void>;
  stop(): void;
  step(): Promise<void>;
  notification(method: string, params: any): boolean;
  interrupt(list: any[]): Promise<void>;
  owns(id: string): boolean;
};
export function unknownReason(prefix: string, error: unknown, limit?: number): string;
