import { DEFAULT_API_BASE_URL } from "./oauth.ts";

export const MODELS_URL = `${DEFAULT_API_BASE_URL}/models`;
export const MUSE_USER_AGENT = "muse-build/pi-meta-muse-auth";
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
	thinkingLevelMap: Record<string, string | null>;
	input: Array<"text" | "image">;
	headers: Record<string, string>;
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

function museCodeMetadata(source?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!isRecord(source?.metadata)) return undefined;
	const metadata = source.metadata["muse-code"];
	return isRecord(metadata) ? metadata : undefined;
}

function fallbackThinkingLevelMap(id: string): Record<string, string | null> {
	return {
		off: null,
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: /^muse-spark-1\.3(?:-|$)/.test(id) ? "max" : null,
	};
}

function thinkingLevelMap(id: string, metadata?: Record<string, unknown>): Record<string, string | null> {
	if (!isRecord(metadata?.variants)) return fallbackThinkingLevelMap(id);

	const result: Record<string, string | null> = {
		off: null,
		minimal: null,
		low: null,
		medium: null,
		high: null,
		xhigh: null,
		max: null,
	};
	let recognizedVariant = false;
	for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
		const variant = metadata.variants[level];
		if (isRecord(variant) && typeof variant.reasoningEffort === "string" && variant.reasoningEffort) {
			result[level] = variant.reasoningEffort;
			recognizedVariant = true;
		}
	}
	return recognizedVariant ? result : fallbackThinkingLevelMap(id);
}

function modelInput(metadata?: Record<string, unknown>): Array<"text" | "image"> {
	const modalities = metadata?.modalities;
	if (!isRecord(modalities) || !Array.isArray(modalities.input)) return ["text", "image"];
	const input = modalities.input.filter(
		(value): value is "text" | "image" => value === "text" || value === "image",
	);
	return input.length > 0 ? [...new Set(input)] : ["text", "image"];
}

function createMuseModel(id: string, source?: Record<string, unknown>): MuseModel {
	const metadata = museCodeMetadata(source);
	const limits = isRecord(metadata?.limit) ? metadata.limit : undefined;
	const metadataName = metadata?.name;
	const sourceName = source?.display_name;
	return {
		id,
		name:
			typeof metadataName === "string" && metadataName
				? metadataName
				: typeof sourceName === "string" && sourceName
					? sourceName
					: displayName(id),
		api: "openai-responses",
		provider: PROVIDER_ID,
		baseUrl: DEFAULT_API_BASE_URL,
		reasoning: true,
		thinkingLevelMap: thinkingLevelMap(id, metadata),
		input: modelInput(metadata),
		headers: { "User-Agent": MUSE_USER_AGENT },
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: positiveInteger(limits?.context ?? source?.context_window, DEFAULT_CONTEXT_WINDOW),
		maxTokens: positiveInteger(limits?.output ?? source?.max_output_tokens, DEFAULT_MAX_TOKENS),
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
			"User-Agent": MUSE_USER_AGENT,
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
