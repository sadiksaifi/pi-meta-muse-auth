import assert from "node:assert/strict";
import test from "node:test";

import {
	FALLBACK_MODEL_IDS,
	MODELS_URL,
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

test("parses Muse Spark models and excludes non-chat models", () => {
	const models = parseMuseModels({
		object: "list",
		data: [
			{ id: "muse-spark-1.4-contributor", object: "model", owned_by: "meta" },
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
	assert.equal(models[0]?.name, "Muse Spark 1.4 Contributor");
	assert.equal(models[0]?.provider, "meta-muse");
	assert.equal(models[0]?.api, "openai-responses");
	assert.equal(models[0]?.reasoning, true);
	assert.deepEqual(models[0]?.input, ["text", "image"]);
	assert.equal(models[0]?.contextWindow, 1_007_997);
	assert.equal(models[0]?.maxTokens, 128_000);
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
