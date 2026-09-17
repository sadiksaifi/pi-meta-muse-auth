import { DEFAULT_API_BASE_URL } from "./oauth.ts";

export const MODELS_URL = `${DEFAULT_API_BASE_URL}/models`;
export const FALLBACK_MODEL_IDS = [
	"muse-spark-1.3-contributor",
	"muse-spark-1.3",
	"muse-spark-1.2-contributor",
	"muse-spark-1.2",
	"muse-spark-1.1",
] as const;

const PROVIDER_ID = "meta-muse";
const DEFAULT_CONTEXT_WINDOW = 1_007_997;
const DEFAULT_MAX_TOKENS = 128_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface MuseModel {
	id: string;
	name: string;
	api: "openai-responses";
	provider: string;
	baseUrl: string;
	reasoning: boolean;
	thinkingLevelMap: Record<string, string>;
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: {
		supportsDeveloperRole: boolean;
		supportsStrictMode: boolean;
		supportsOpenAIGrammarTools: boolean;
		supportsMaxOutputTokens: boolean;
		supportsLongCacheRetention: boolean;
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function displayName(id: string): string {
	const suffix = id.slice("muse-spark-".length);
	return `Muse Spark ${suffix
		.split("-")
		.map((part) => (part === "contributor" ? "Contributor" : part))
		.join(" ")}`;
}

function createMuseModel(id: string, source?: Record<string, unknown>): MuseModel {
	return {
		id,
		name: typeof source?.display_name === "string" && source.display_name ? source.display_name : displayName(id),
		api: "openai-responses",
		provider: PROVIDER_ID,
		baseUrl: DEFAULT_API_BASE_URL,
		reasoning: true,
		thinkingLevelMap: {
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: positiveInteger(source?.context_window, DEFAULT_CONTEXT_WINDOW),
		maxTokens: positiveInteger(source?.max_output_tokens, DEFAULT_MAX_TOKENS),
		compat: {
			supportsDeveloperRole: false,
			supportsStrictMode: true,
			supportsOpenAIGrammarTools: false,
			supportsMaxOutputTokens: true,
			supportsLongCacheRetention: false,
		},
	};
}

export const FALLBACK_MODELS: MuseModel[] = FALLBACK_MODEL_IDS.map((id) => createMuseModel(id));

export function parseMuseModels(payload: unknown): MuseModel[] {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error("Meta returned an invalid model catalog");
	}

	const seen = new Set<string>();
	const models: MuseModel[] = [];
	for (const entry of payload.data) {
		if (!isRecord(entry) || typeof entry.id !== "string") continue;
		const id = entry.id;
		if (!/^muse-spark-[a-z0-9][a-z0-9._-]*$/i.test(id) || seen.has(id)) continue;
		seen.add(id);
		models.push(createMuseModel(id, entry));
	}
	if (models.length === 0) {
		throw new Error("Meta model catalog contained no Muse Spark models");
	}
	return models;
}

export async function fetchMuseModels(
	fetchImpl: typeof fetch,
	apiKey: string,
	signal: AbortSignal,
): Promise<MuseModel[]> {
	const response = await fetchImpl(MODELS_URL, {
		method: "GET",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
			"x-api-version": "1.0.0",
		},
		redirect: "error",
		signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
	});
	if (!response.ok) {
		throw new Error(`Meta model catalog request failed with status ${response.status}`);
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new Error("Meta returned a non-JSON model catalog");
	}
	return parseMuseModels(payload);
}
