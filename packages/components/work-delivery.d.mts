type Requirement = { sources?: { objectId: string; title?: string; revision?: number }[]; goal?: string; deliverables?: string; delivery?: { formats: string[] } };
export function expectedDeliveryFormats(requirement?: Requirement): string[];
export function reviseDeliveryFormats(previous: Requirement, amendment: string, replacement?: Requirement): string[];
export function missingDeliveries(management: { requirements?: Requirement[] } | undefined,
  artifacts: { objectId?: string; revision?: number; title?: string; fileName?: string; validity?: string }[]): string[];
