export type ConfirmationPolicy = { required: boolean; sourceRequestId?: string; reason?: string };
export function confirmationPolicy(text: string, previous?: ConfirmationPolicy, sourceRequestId?: string): ConfirmationPolicy;
export function requiresDeliveryConfirmation(management: {
  requirements?: { goal?: string; constraints?: string; reason?: string; sourceRequestId?: string; confirmation?: ConfirmationPolicy }[];
} | undefined): boolean;
