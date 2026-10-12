import { Type, type Static } from "typebox";
import type { Workflow } from "./model.ts";

const text = Type.String({ minLength: 1, pattern: "\\S" });
const names = Type.Array(text, { minItems: 1, uniqueItems: true });
export const stackPlanSchema = Type.Object({
	title: text,
	objective: text,
	nonGoals: Type.Array(text),
	successCriteria: names,
	rootBase: text,
	units: Type.Array(
		Type.Object({
			id: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$" }),
			title: text,
			objective: text,
			branch: text,
			checks: names,
			requiredReviews: names,
			ciChecks: Type.Array(text, { uniqueItems: true }),
		}),
		{ minItems: 1 },
	),
	integrationChecks: names,
	integrationReviews: names,
	maxImprovementCycles: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
	maxRecoveries: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
});
export type StackPlanInput = Static<typeof stackPlanSchema>;
export type StackPlan = Required<StackPlanInput>;
export type StackUnit = StackPlan["units"][number];
export type UnitExecution = Pick<
	Workflow,
	| "spec"
	| "planVersion"
	| "approval"
	| "attempts"
	| "checks"
	| "verification"
	| "review"
	| "reviewResults"
	| "deliveries"
	| "improvementCycles"
	| "recoveries"
>;
export type StackUnitResult = {
	id: string;
	branch: string;
	base: string;
	parentHead: string;
	head: string;
	fingerprint: string;
	url: string;
	valid: boolean;
	execution: UnitExecution;
};
export type StackState = {
	plan: StackPlan;
	planVersion: string;
	approval?: {
		at: string;
		via: "ui" | "command" | "auto";
		rootHead: string;
		rootFingerprint: string;
		sourceBranch: string;
		sourceHead: string;
	};
	index: number;
	stage: "planned" | "preparing" | "unit" | "integration";
	results: StackUnitResult[];
	invalidatedFrom?: number;
};
