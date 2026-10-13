import { Type, type Static } from "typebox";
import type { RemoteTarget } from "./preflight.ts";
import { adoptChangesSchema, type Workflow } from "./model.ts";

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
			allowedPaths: Type.Optional(names),
		}),
		{ minItems: 1 },
	),
	integrationChecks: names,
	integrationReviews: names,
	replanPolicy: Type.Optional(
		Type.Object({ maxReplans: Type.Integer({ minimum: 1, maximum: 5 }) }, { additionalProperties: false }),
	),
	maxImprovementCycles: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
	maxRecoveries: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
});
export type StackPlanInput = Static<typeof stackPlanSchema>;
export type StackPlan = Omit<Required<StackPlanInput>, "replanPolicy"> & Pick<StackPlanInput, "replanPolicy">;
export const stackReplanSchema = Type.Object(
	{
		plan: stackPlanSchema,
		reason: text,
		adoptChanges: Type.Optional(adoptChangesSchema),
		excludedRequirements: Type.Optional(Type.Array(text, { uniqueItems: true })),
	},
	{ additionalProperties: false },
);
export type StackReplanInput = Static<typeof stackReplanSchema>;
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
		initialPlan?: StackPlan;
		target?: RemoteTarget;
	};
	index: number;
	stage: "planned" | "preparing" | "unit" | "integration";
	results: StackUnitResult[];
	revisions?: {
		at: string;
		reason: string;
		via: "scope" | "ui" | "command";
		fromPlanVersion: string;
		toPlanVersion: string;
		previousPlan: StackPlan;
		previousExecution: UnitExecution;
		index: number;
		excludedRequirements: string[];
	}[];
	excludedRequirements?: string[];
	invalidatedFrom?: number;
};
