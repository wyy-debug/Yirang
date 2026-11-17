export type ReviewCriterion = { id: string; source: string; description: string };
export const criteriaReviewInstructions: string;
export function reviewCriteria(requirement: unknown): ReviewCriterion[];
