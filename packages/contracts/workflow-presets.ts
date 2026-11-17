import type { WorkflowNode } from './workflows.js';

export type WorkflowPreset = {
  id: string;
  name: string;
  category: 'input' | 'text' | 'data' | 'ai' | 'browser' | 'output';
  description: string;
  tags: string[];
  node: Omit<WorkflowNode, 'id' | 'position' | 'origin'>;
  pythonSource?: string;
};
export const WORKFLOW_CATEGORIES: { id: WorkflowPreset['category']; label: string }[] = [
  { id: 'input', label: '输入' },
  { id: 'text', label: '文本' },
  { id: 'data', label: '数据处理' },
  { id: 'ai', label: 'AI 处理' },
  { id: 'browser', label: '浏览器' },
  { id: 'output', label: '导出与回写' },
];
export type WorkflowRecipe = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  nodes: { key: string; presetId: string; config?: Partial<WorkflowNode['config']> }[];
  edges: { source: string; sourcePort: string; target: string; targetPort: string }[];
};

// Business tools are user-owned files generated on demand, never bundled presets.
export const WORKFLOW_PRESETS: WorkflowPreset[] = [];
export const WORKFLOW_RECIPES: WorkflowRecipe[] = [];
