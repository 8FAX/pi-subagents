/**
 * Async file-only structured-output settlement tests.
 *
 * Exercises the real background runner settlement path
 * (src/runs/background/subagent-runner.ts runSingleStepInner → resolveSingleOutput)
 * through executeAsyncSingle with a scripted child session: a validated
 * structured_output value must publish canonical JSON into the bound
 * file-only output path even when the child's final text is only an
 * acceptance-report fence, while missing/schema-invalid/error runs keep
 * failing closed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { JsonSchemaObject } from "../../src/shared/types.ts";
import { makeAgent } from "../support/helpers.ts";
import {
	installAsyncExecutionHooks,
	executeAsyncSingle,
	readAsyncPayload,
	tempDir,
	mockPi,
	isAsyncAvailable,
	available,
} from "../support/async-execution-fixture.ts";

const OK_SCHEMA: JsonSchemaObject = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };

function fenceOnlyFinalText(): string {
	return [
		"```acceptance-report",
		JSON.stringify({
			criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "review findings verified in test" }],
			reviewFindings: [],
			residualRisks: [],
			noStagedFiles: true,
		}),
		"```",
	].join("\n");
}

interface FixtureLaunchParams {
	agent: string;
	task: string;
	agentConfig: ReturnType<typeof makeAgent>;
	output: string;
	outputMode: "file-only" | "inline";
	acceptance: unknown;
	ctx: { pi: { events: { emit(): void } }; cwd: string; currentSessionId: string };
	artifactConfig: { enabled: boolean; includeInput: boolean; includeOutput: boolean; includeJsonl: boolean; includeMetadata: boolean; cleanupDays: number };
	shareEnabled: boolean;
	sessionRoot: string;
	maxSubagentDepth: number;
	structuredOutputSchema?: JsonSchemaObject;
	outputClaimPath?: string;
}

function launchReviewerSingle(id: string, outputPath: string, options: {
	schema?: JsonSchemaObject;
	acceptance?: unknown;
	outputMode?: "file-only" | "inline";
	outputClaimPath?: string;
}): void {
	const params: FixtureLaunchParams = {
		agent: "reviewer",
		task: "Review the fixture and return the report.",
		agentConfig: makeAgent("reviewer", { tools: ["read", "grep", "find"] }),
		output: outputPath,
		outputMode: options.outputMode ?? "file-only",
		acceptance: options.acceptance ?? false,
		ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: `session-${id}` },
		artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
		shareEnabled: false,
		sessionRoot: path.join(tempDir, "sessions"),
		maxSubagentDepth: 2,
	};
	if (options.schema) params.structuredOutputSchema = options.schema;
	if (options.outputClaimPath) params.outputClaimPath = options.outputClaimPath;
	const receipt = executeAsyncSingle(id, params);
	assert.equal(receipt.isError === true, false, JSON.stringify(receipt));
}

describe("async file-only structured-output settlement", { skip: !available || !isAsyncAvailable?.() ? "pi packages not available" : undefined }, () => {
	installAsyncExecutionHooks();

	it("publishes canonical structured JSON to the bound file-only path when the final text is only an acceptance-report fence", async () => {
		const id = `async-structured-file-only-fence-${Date.now().toString(36)}`;
		const outputPath = path.join(tempDir, `${id}.md`);
		mockPi.onCall({ output: fenceOnlyFinalText(), structuredOutput: { ok: true } });
		launchReviewerSingle(id, outputPath, { schema: OK_SCHEMA });

		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true, JSON.stringify(payload.results[0]?.error));
		assert.equal(payload.results[0]?.error, undefined);
		assert.deepEqual(payload.results[0]?.structuredOutput, { ok: true });
		assert.equal(payload.results[0]?.savedOutputPath, outputPath);
		assert.match(payload.results[0]?.output ?? "", /Output saved to:/);
		// Canonical JSON publication, not a sidecar or stripped-text fallback.
		assert.equal(fs.readFileSync(outputPath, "utf-8"), JSON.stringify({ ok: true }, null, 2));
		assert.equal(mockPi.callCount(), 1);
	});

	const falsyCases: Array<{ label: string; schema: JsonSchemaObject; value: unknown }> = [
		{ label: "boolean-false-root", schema: { type: ["object", "boolean"] }, value: false },
		{ label: "null-root", schema: { type: ["object", "null"] }, value: null },
		{ label: "false-member", schema: OK_SCHEMA, value: { ok: false } },
		{ label: "null-member", schema: { type: "object", properties: { ok: { type: ["boolean", "null"] } } }, value: { ok: null } },
	];
	for (const falsyCase of falsyCases) {
		it(`publishes valid falsy structured values (${falsyCase.label}) to the bound file-only path`, async () => {
			const id = `async-structured-file-only-${falsyCase.label}-${Date.now().toString(36)}`;
			const outputPath = path.join(tempDir, `${id}.json`);
			mockPi.onCall({ output: fenceOnlyFinalText(), structuredOutput: falsyCase.value });
			launchReviewerSingle(id, outputPath, { schema: falsyCase.schema });

			const payload = await readAsyncPayload(id);
			assert.equal(payload.success, true, JSON.stringify(payload.results[0]?.error));
			assert.equal(payload.results[0]?.error, undefined);
			assert.equal(fs.existsSync(outputPath), true);
			assert.equal(fs.readFileSync(outputPath, "utf-8"), JSON.stringify(falsyCase.value, null, 2));
			assert.deepEqual(payload.results[0]?.structuredOutput, falsyCase.value);
		});
	}

	/** A cross-platform blocked report path where the parent is an existing regular file, deterministically failing mkdir/write on all OSes without chmod. */
	function withBlockedReportPath(run: (outputPath: string) => Promise<void>): Promise<void> {
		const blockerFile = path.join(tempDir, `blocked-report-parent-${Date.now().toString(36)}`);
		fs.writeFileSync(blockerFile, "regular file collision", "utf-8");
		const outputPath = path.join(blockerFile, "report.md");
		return run(outputPath).finally(() => {
			fs.rmSync(blockerFile, { recursive: true, force: true });
		});
	}

	it("fails settlement when required file-only publication into a blocked report path fails (schema-only result)", async () => {
		await withBlockedReportPath(async (outputPath) => {
			const id = `async-structured-file-only-blocked-${Date.now().toString(36)}`;
			// Schema-validated structured output counts as savable content, so the write failure is what settles the run.
			mockPi.onCall({ output: fenceOnlyFinalText(), structuredOutput: { ok: true } });
			launchReviewerSingle(id, outputPath, { schema: OK_SCHEMA });

			const payload = await readAsyncPayload(id);
			assert.equal(payload.success, false, JSON.stringify(payload.results[0]));
			assert.equal(payload.exitCode, 1);
			assert.match(payload.results[0]?.error ?? "", /EEXIST|EISDIR|ENOTDIR|EPERM|EACCES|file already exists|not a directory|permission denied/i);
			assert.equal(payload.results[0]?.savedOutputPath, undefined, "no durable savedOutputPath without successful publication");
			assert.match(payload.results[0]?.outputSaveError ?? "", /EEXIST|EISDIR|ENOTDIR|EPERM|EACCES|file already exists|not a directory|permission denied/i);
			assert.equal(fs.existsSync(outputPath), false, "the bound canonical file must stay absent when publication fails");
		});
	});

	it("fails settlement when required file-only publication fails for plain final text", async () => {
		await withBlockedReportPath(async (outputPath) => {
			const id = `async-structured-file-only-blocked-plain-${Date.now().toString(36)}`;
			mockPi.onCall({ output: "review findings text" });
			launchReviewerSingle(id, outputPath, {});

			const payload = await readAsyncPayload(id);
			assert.equal(payload.success, false, JSON.stringify(payload.results[0]));
			assert.equal(payload.exitCode, 1);
			assert.match(payload.results[0]?.error ?? "", /EEXIST|EISDIR|ENOTDIR|EPERM|EACCES|file already exists|not a directory|permission denied/i);
			assert.equal(payload.results[0]?.savedOutputPath, undefined);
			assert.equal(fs.existsSync(outputPath), false);
		});
	});

	it("fails settlement with a fatal error when the output claim path is mismatched", async () => {
		const id = `async-structured-file-only-claim-mismatch-${Date.now().toString(36)}`;
		const outputPath = path.join(tempDir, `${id}.md`);
		const claimedPath = path.join(tempDir, `${id}-different.md`);
		mockPi.onCall({ output: fenceOnlyFinalText(), structuredOutput: { ok: true } });
		launchReviewerSingle(id, outputPath, { schema: OK_SCHEMA, outputClaimPath: claimedPath });

		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.match(payload.results[0]?.error ?? "", /Output path changed after it was claimed/);
		assert.equal(payload.results[0]?.savedOutputPath, undefined, "no durable savedOutputPath on claim mismatch");
		assert.equal(fs.existsSync(outputPath), false, "the bound file must stay absent on claim mismatch");
	});

	it("keeps inline optional output-save failure nonfatal", async () => {
		await withBlockedReportPath(async (outputPath) => {
			const id = `async-structured-file-only-blocked-inline-${Date.now().toString(36)}`;
			mockPi.onCall({ output: "inline findings text" });
			launchReviewerSingle(id, outputPath, { outputMode: "inline" });

			const payload = await readAsyncPayload(id);
			assert.equal(payload.success, true, JSON.stringify(payload.results[0]));
			assert.equal(payload.exitCode, 0);
			assert.equal(payload.results[0]?.error, undefined, "inline save failure stays a warning, not a settlement failure");
			assert.match(payload.results[0]?.outputSaveError ?? "", /EEXIST|EISDIR|ENOTDIR|EPERM|EACCES|file already exists|not a directory|permission denied/i);
			assert.match(payload.results[0]?.output ?? "", /Output file error/);
		});
	});

	it("fails closed when the structured_output call is missing and the final text is only an acceptance-report fence", async () => {
		const id = `async-structured-file-only-missing-${Date.now().toString(36)}`;
		const outputPath = path.join(tempDir, `${id}.md`);
		mockPi.onCall({ output: fenceOnlyFinalText() });
		launchReviewerSingle(id, outputPath, { schema: OK_SCHEMA });

		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.match(payload.results[0]?.error ?? "", /structured_output/);
		assert.equal(fs.existsSync(outputPath), false, "the bound file-only path must stay absent on failure");
	});

	it("fails closed when the structured value is schema-invalid and the final text is only an acceptance-report fence", async () => {
		const id = `async-structured-file-only-invalid-${Date.now().toString(36)}`;
		const outputPath = path.join(tempDir, `${id}.md`);
		mockPi.onCall({ output: fenceOnlyFinalText(), structuredOutput: { ok: "yes" } });
		launchReviewerSingle(id, outputPath, { schema: OK_SCHEMA });

		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.match(payload.results[0]?.error ?? "", /validation failed/);
		assert.equal(fs.existsSync(outputPath), false, "the bound file-only path must stay absent on failure");
	});

	it("fails closed when the child errors after capturing a valid structured value", async () => {
		const id = `async-structured-file-only-error-${Date.now().toString(36)}`;
		const outputPath = path.join(tempDir, `${id}.md`);
		mockPi.onCall({ output: fenceOnlyFinalText(), structuredOutput: { ok: true }, exitCode: 1, stderr: "child failed after capture" });
		launchReviewerSingle(id, outputPath, { schema: OK_SCHEMA });

		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.match(payload.results[0]?.error ?? "", /child failed after capture/);
		assert.equal(fs.existsSync(outputPath), false, "the bound file-only path must stay absent on failure");
	});
});
