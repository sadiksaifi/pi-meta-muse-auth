import assert from "node:assert/strict";
import test from "node:test";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";

import {
	FALLBACK_MODEL_IDS,
	FALLBACK_MODELS,
	MODELS_URL,
	MUSE_USER_AGENT,
	fetchMuseModels,
	parseMuseModels,
} from "../src/models.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

test("fallback catalog includes all known Muse Spark models", () => {
	assert.deepEqual(FALLBACK_MODEL_IDS, [
		"muse-spark-1.3-contributor",
		"muse-spark-1.3",
		"muse-spark-1.2-contributor",
		"muse-spark-1.2",
		"muse-spark-1.1",
	]);
});

test("parses Muse Code model capabilities and excludes non-chat models", () => {
	const models = parseMuseModels({
		object: "list",
		data: [
			{
				id: "muse-spark-1.4-contributor",
				object: "model",
				owned_by: "meta",
				metadata: {
					"muse-code": {
						name: "Muse Spark Preview",
						modalities: { input: ["text"] },
						limit: { context: 500_000, output: 64_000 },
						variants: {
							minimal: { reasoningEffort: "minimal" },
							high: { reasoningEffort: "high" },
							max: { reasoningEffort: "max" },
						},
					},
				},
			},
			{ id: "muse-voice-transcribe-1.0", object: "model", owned_by: "meta" },
			{ id: "other-model", object: "model", owned_by: "other" },
			{ id: "muse-spark-1.4-contributor", object: "model", owned_by: "meta" },
			{ id: "muse-spark-1.4", object: "model", owned_by: "meta" },
		],
	});

	assert.deepEqual(
		models.map((model) => model.id),
		["muse-spark-1.4-contributor", "muse-spark-1.4"],
	);
	assert.equal(models[0]?.name, "Muse Spark Preview");
	assert.equal(models[0]?.provider, "meta-muse");
	assert.equal(models[0]?.api, "openai-responses");
	assert.equal(models[0]?.reasoning, true);
	assert.deepEqual(models[0]?.thinkingLevelMap, {
		off: null,
		minimal: "minimal",
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	});
	assert.deepEqual(models[0]?.input, ["text"]);
	assert.equal(models[0]?.contextWindow, 500_000);
	assert.equal(models[0]?.maxTokens, 64_000);
});

test("fallback models expose only known reasoning variants", () => {
	const spark13 = FALLBACK_MODELS.find((model) => model.id === "muse-spark-1.3");
	const spark12 = FALLBACK_MODELS.find((model) => model.id === "muse-spark-1.2");

	assert.equal(spark13?.thinkingLevelMap.max, "max");
	assert.equal(spark12?.thinkingLevelMap.xhigh, "xhigh");
	assert.equal(spark12?.thinkingLevelMap.max, null);
	assert.equal(spark12?.thinkingLevelMap.off, null);
});

test("falls back when Muse Code metadata has no recognized reasoning variants", () => {
	const [model] = parseMuseModels({
		data: [{ id: "muse-spark-1.3", metadata: { "muse-code": { variants: {} } } }],
	});

	assert.deepEqual(getSupportedThinkingLevels(model!), ["minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("Muse requests use the client identity required for max effort", async () => {
	let userAgent: string | null = null;
	const fetchImpl: typeof fetch = async (_input, init) => {
		userAgent = new Headers(init?.headers).get("user-agent");
		return jsonResponse({ error: { message: "captured" } }, 400);
	};
	const stream = openAIResponsesApi().streamSimple(
		FALLBACK_MODELS[0]!,
		{ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
		{ apiKey: "model-api-key", fetch: fetchImpl, reasoning: "max" },
	);

	const result = await stream.result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /captured/);
	assert.equal(userAgent, MUSE_USER_AGENT);
});

test("rejects a catalog with no usable Muse Spark models", () => {
	assert.throws(
		() => parseMuseModels({ object: "list", data: [{ id: "muse-voice-transcribe-1.0" }] }),
		/no Muse Spark models/,
	);
});

test("fetches the authenticated Meta model catalog", async () => {
	let request: { url: string; init?: RequestInit } | undefined;
	const fetchImpl: typeof fetch = async (input, init) => {
		request = { url: String(input), init };
		return jsonResponse({ data: [{ id: "muse-spark-1.3" }] });
	};

	const models = await fetchMuseModels(fetchImpl, "model-api-key", new AbortController().signal);

	assert.equal(request?.url, MODELS_URL);
	assert.equal(request?.init?.method, "GET");
	assert.equal(new Headers(request?.init?.headers).get("authorization"), "Bearer model-api-key");
	assert.equal(new Headers(request?.init?.headers).get("x-api-version"), "1.0.0");
	assert.deepEqual(models.map((model) => model.id), ["muse-spark-1.3"]);
});
