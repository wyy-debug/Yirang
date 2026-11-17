type WindowMetrics = {
  commits: number;
  commitTotal: number;
  commitMax: number;
  batches: number;
  batchTotal: number;
  batchMax: number;
  jobs: number;
};
const empty = (): WindowMetrics => ({
  commits: 0,
  commitTotal: 0,
  commitMax: 0,
  batches: 0,
  batchTotal: 0,
  batchMax: 0,
  jobs: 0,
});
let enabled = false,
  current = empty();
export const renderMetricsEnabled = () => enabled;
export function enableRenderMetrics(value: boolean) {
  enabled = value;
  current = empty();
}
export function recordDesktopCommit(ms: number) {
  if (!enabled) return;
  current.commits++;
  current.commitTotal += ms;
  current.commitMax = Math.max(current.commitMax, ms);
}
export function recordFrameBatch(ms: number, jobs: number) {
  if (!enabled) return;
  current.batches++;
  current.batchTotal += ms;
  current.batchMax = Math.max(current.batchMax, ms);
  current.jobs += jobs;
}
export function takeRenderMetrics() {
  const value = current;
  current = empty();
  return value;
}
