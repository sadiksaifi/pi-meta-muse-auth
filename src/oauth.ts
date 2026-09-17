export const CLIENT_ID = "1031625952748946";
export const DEVICE_AUTHORIZATION_URL = "https://auth.meta.com/oidc/device/authorization/";
export const DEVICE_TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
export const MINT_URL = "https://api.meta.ai/muse-code/key";
export const DEFAULT_API_BASE_URL = "https://api.meta.ai/v1";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_DEVICE_EXPIRY_SECONDS = 15 * 60;
const REQUEST_TIMEOUT_MS = 30_000;
const CREDENTIAL_LIFETIME_MS = 12 * 60 * 60 * 1000;

export interface DeviceAuthorization {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	expiresInSeconds: number;
	intervalSeconds: number;
}

export interface IdentityToken {
	accessToken: string;
	refreshToken?: string;
}

export interface MintedMuseKey {
	apiKey: string;
	baseUrl: string;
	subscriptionActive: boolean;
	subscriptionTier?: string;
}

export interface MuseOAuthCredential {
	[key: string]: unknown;
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
	baseUrl: string;
	subscriptionActive: boolean;
	subscriptionTier?: string;
}

export interface AuthInteractionLike {
	signal: AbortSignal;
	notify(event: {
		type: "device_code";
		userCode: string;
		verificationUri: string;
		intervalSeconds?: number;
		expiresInSeconds?: number;
	}): void;
	prompt(prompt: unknown): Promise<string>;
}

interface OAuthDependencies {
	fetchImpl?: typeof fetch;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function trustedMetaUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.hostname !== "auth.meta.com") return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}

function sanctionedApiBaseUrl(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) return DEFAULT_API_BASE_URL;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.hostname !== "api.meta.ai") {
			throw new Error("Meta returned an untrusted Model API base URL");
		}
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.href.replace(/\/$/, "");
	} catch (error) {
		if (error instanceof Error && error.message.includes("untrusted")) throw error;
		throw new Error("Meta returned an invalid Model API base URL");
	}
}

function requestSignal(signal: AbortSignal): AbortSignal {
	return AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
	try {
		const value: unknown = await response.json();
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const finish = () => {
			signal.removeEventListener("abort", abort);
			resolve();
		};
		const timeout = setTimeout(finish, ms);
		const abort = () => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", abort);
			reject(signal.reason instanceof Error ? signal.reason : new Error("Meta Muse login cancelled"));
		};
		if (signal.aborted) return abort();
		signal.addEventListener("abort", abort, { once: true });
	});
}

export async function startDeviceAuthorization(
	fetchImpl: typeof fetch,
	signal: AbortSignal,
): Promise<DeviceAuthorization> {
	const response = await fetchImpl(DEVICE_AUTHORIZATION_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": "muse-code/launcher-2",
		},
		body: new URLSearchParams({ client_id: CLIENT_ID }).toString(),
		signal: requestSignal(signal),
	});
	if (!response.ok) {
		throw new Error(`Meta Muse device authorization failed with status ${response.status}`);
	}

	const json = await readJson(response);
	const deviceCode = json?.device_code;
	const userCode = json?.user_code;
	const verificationUri = trustedMetaUrl(json?.verification_uri_complete) ?? trustedMetaUrl(json?.verification_uri);
	if (typeof deviceCode !== "string" || !deviceCode || typeof userCode !== "string" || !userCode || !verificationUri) {
		throw new Error("Meta Muse returned an invalid device authorization response");
	}

	return {
		deviceCode,
		userCode,
		verificationUri,
		expiresInSeconds: Math.min(1_800, Math.max(60, positiveNumber(json?.expires_in, DEFAULT_DEVICE_EXPIRY_SECONDS))),
		intervalSeconds: positiveNumber(json?.interval, DEFAULT_POLL_INTERVAL_SECONDS),
	};
}

export async function pollForDeviceToken(
	fetchImpl: typeof fetch,
	device: DeviceAuthorization,
	signal: AbortSignal,
	sleep: (ms: number, signal: AbortSignal) => Promise<void> = defaultSleep,
): Promise<IdentityToken> {
	const deadline = Date.now() + device.expiresInSeconds * 1000;
	let intervalSeconds = device.intervalSeconds;

	while (Date.now() < deadline) {
		await sleep(intervalSeconds * 1000, signal);
		const response = await fetchImpl(DEVICE_TOKEN_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
				"User-Agent": "muse-code/launcher-2",
			},
			body: new URLSearchParams({
				grant_type: DEVICE_CODE_GRANT,
				device_code: device.deviceCode,
				client_id: CLIENT_ID,
			}).toString(),
			signal: requestSignal(signal),
		});
		const json = await readJson(response);

		if (response.ok) {
			const accessToken = json?.access_token;
			const tokenType = json?.token_type;
			if (typeof accessToken !== "string" || !accessToken || (tokenType !== undefined && tokenType !== "Bearer")) {
				throw new Error("Meta Muse returned an invalid device token response");
			}
			return {
				accessToken,
				refreshToken: typeof json?.refresh_token === "string" && json.refresh_token ? json.refresh_token : undefined,
			};
		}

		switch (json?.error) {
			case "authorization_pending":
				continue;
			case "slow_down":
				intervalSeconds += 5;
				continue;
			case "access_denied":
				throw new Error("Meta Muse login was denied");
			case "expired_token":
				throw new Error("Meta Muse device authorization expired; run /login again");
			default:
				throw new Error(`Meta Muse device token request failed with status ${response.status}`);
		}
	}

	throw new Error("Meta Muse device authorization expired; run /login again");
}

export async function mintMuseKey(
	fetchImpl: typeof fetch,
	identityAccessToken: string,
	signal: AbortSignal,
): Promise<MintedMuseKey> {
	const response = await fetchImpl(MINT_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${identityAccessToken}`,
			"Content-Type": "application/json",
			"x-api-version": "1.0.0",
		},
		body: JSON.stringify({ show_subs_upsell: false }),
		signal: requestSignal(signal),
	});
	if (!response.ok) {
		throw new Error(`Meta Muse subscription key exchange failed with status ${response.status}`);
	}

	const json = await readJson(response);
	const apiKey = json?.api_key;
	if (typeof apiKey !== "string" || !apiKey) {
		throw new Error("Meta Muse key exchange returned no API key");
	}
	if (json?.is_subs_active !== true) {
		throw new Error("Meta did not confirm an active Muse Code subscription; refusing to use a potentially pay-as-you-go key");
	}

	return {
		apiKey,
		baseUrl: sanctionedApiBaseUrl(json?.base_url),
		subscriptionActive: true,
		subscriptionTier: typeof json?.subs_tier_name === "string" ? json.subs_tier_name : undefined,
	};
}

function credentialFrom(identityAccessToken: string, minted: MintedMuseKey): MuseOAuthCredential {
	return {
		type: "oauth",
		access: minted.apiKey,
		refresh: identityAccessToken,
		expires: Date.now() + CREDENTIAL_LIFETIME_MS,
		baseUrl: minted.baseUrl,
		subscriptionActive: minted.subscriptionActive,
		subscriptionTier: minted.subscriptionTier,
	};
}

export async function loginMetaMuse(
	interaction: AuthInteractionLike,
	dependencies: OAuthDependencies = {},
): Promise<MuseOAuthCredential> {
	const fetchImpl = dependencies.fetchImpl ?? fetch;
	const device = await startDeviceAuthorization(fetchImpl, interaction.signal);
	interaction.notify({
		type: "device_code",
		userCode: device.userCode,
		verificationUri: device.verificationUri,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
	});
	const identity = await pollForDeviceToken(
		fetchImpl,
		device,
		interaction.signal,
		dependencies.sleep ?? defaultSleep,
	);
	const minted = await mintMuseKey(fetchImpl, identity.accessToken, interaction.signal);
	return credentialFrom(identity.accessToken, minted);
}

export async function refreshMetaMuse(
	credential: MuseOAuthCredential,
	signal: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<MuseOAuthCredential> {
	const minted = await mintMuseKey(fetchImpl, credential.refresh, signal);
	return credentialFrom(credential.refresh, minted);
}

export async function toMuseAuth(credential: MuseOAuthCredential): Promise<{
	apiKey: string;
	baseUrl: string;
}> {
	return {
		apiKey: credential.access,
		baseUrl: sanctionedApiBaseUrl(credential.baseUrl),
	};
}
