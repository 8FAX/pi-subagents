import { previewDisplayText } from "../shared/display-text.ts";
import type { AsyncJobState } from "../shared/types.ts";

const MAX_LISTED_RUNS = 10;
const MAX_LISTED_AGENTS = 3;
const MAX_DESCRIPTION_CHARS = 80;

/**
 * The `active_subagents` prompt section: one line per queued or running background run of this session.
 * Pi diffs prompt sections every turn, so it holds only fields that stay the same while a run is unchanged.
 */
export function buildActiveRunsSection(jobs: Iterable<AsyncJobState>, sessionId: string | null | undefined): string | undefined {
	const active = [...jobs].filter((job) => (job.status === "queued" || job.status === "running")
		&& (typeof sessionId !== "string" || job.sessionId === sessionId));
	if (active.length === 0) return undefined;
	const lines = active.slice(0, MAX_LISTED_RUNS).map((job) => {
		const agents = [...new Set(job.agents ?? [])];
		const agentText = agents.length > MAX_LISTED_AGENTS
			? `${agents.slice(0, MAX_LISTED_AGENTS).join(", ")} +${agents.length - MAX_LISTED_AGENTS}`
			: agents.join(", ") || "subagent";
		const step = job.mode === "chain" && job.currentStep !== undefined && (job.chainStepCount ?? 0) > 1
			? `, step ${job.currentStep + 1}/${job.chainStepCount}`
			: "";
		const description = job.description ? `: ${previewDisplayText(job.description, MAX_DESCRIPTION_CHARS)}` : "";
		return `- ${job.asyncId} ${agentText} (${job.mode ?? "single"}${step})${description}`;
	});
	if (active.length > MAX_LISTED_RUNS) lines.push(`- +${active.length - MAX_LISTED_RUNS} more`);
	return [
		`Background subagent runs still active in this session (${active.length}). Check them with subagent({ action: "status", id }) before launching duplicate work.`,
		...lines,
	].join("\n");
}
