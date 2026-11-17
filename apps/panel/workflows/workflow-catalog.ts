import {
  WORKFLOW_PRESETS as presets,
  WORKFLOW_RECIPES as recipes,
  WORKFLOW_CATEGORIES as categories,
} from '../../../packages/contracts/workflow-presets.js';
import { t } from '../../../packages/components/ui-language.js';
export type { WorkflowPreset } from '../../../packages/contracts/workflow-presets.js';
// Localize catalog metadata only. Stored workflow documents, code and user labels stay intact.
export const WORKFLOW_PRESETS = presets.map((item) => ({
  ...item,
  get name() {
    return t(item.name);
  },
  get description() {
    return t(item.description);
  },
  get tags() {
    return item.tags.map((tag) => t(tag));
  },
}));
export const WORKFLOW_RECIPES = recipes.map((item) => ({
  ...item,
  get name() {
    return t(item.name);
  },
  get description() {
    return t(item.description);
  },
  get tags() {
    return item.tags.map((tag) => t(tag));
  },
}));
export const WORKFLOW_CATEGORIES = categories.map((item) => ({
  ...item,
  get label() {
    return t(item.label);
  },
}));
