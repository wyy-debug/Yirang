export interface TimingCard {
  element: HTMLDetailsElement;
  refresh(): Promise<void>;
  reset(): void;
  dispose(): void;
}
export function createTimingCard(options: {
  load: () => Promise<unknown>;
  emptyHidden?: boolean;
  onChange?: () => void;
}): TimingCard;
