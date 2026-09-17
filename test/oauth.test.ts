import assert from "node:assert/strict";
import test from "node:test";

import {
	CLIENT_ID,
	DEVICE_AUTHORIZATION_URL,
	DEVICE_TOKEN_URL,
	MINT_URL,
	loginMetaMuse,
	mintMuseKey,
	pollForDeviceToken,
	refreshMetaMuse,
	startDeviceAuthorization,
	toMuseAuth,
} from "../src/oauth.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function requestBody(init?: RequestInit): URLSearchParams {
	const body = init?.body;
	if (typeof body !== "string") throw new Error("expected a URL-encoded request body");
	return new URLSearchParams(body);
}

test("starts Meta device authorization with Muse's public client", async () => {
	let request: { url: string; init?: RequestInit } | undefined;
	const fetchImpl: typeof fetch = async (input, init) => {
		request = { url: String(input), init };
		return jsonResponse({
			device_code: "device-secret",
			user_code: "ABCD-EFGH",
			verification_uri: "https://auth.meta.com/oauth/device/",
			verification_uri_complete: "https://auth.meta.com/oauth/device/?code=ABCD-EFGH",
			expires_in: 900,
			interval: 5,
		});
	};

	const result = await startDeviceAuthorization(fetchImpl, new AbortController().signal);

	assert.equal(request?.url, DEVICE_AUTHORIZATION_URL);
	assert.equal(request?.init?.method, "POST");
	assert.equal(requestBody(request?.init).get("client_id"), CLIENT_ID);
	assert.deepEqual(result, {
		deviceCode: "device-secret",
		userCode: "ABCD-EFGH",
		verificationUri: "https://auth.meta.com/oauth/device/?code=ABCD-EFGH",
		expiresInSeconds: 900,
		intervalSeconds: 5,
	});
});

test("polls pending device authorization and returns the identity token", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const responses = [
		jsonResponse({ error: "authorization_pending" }, 400),
		jsonResponse({ access_token: "identity-token", token_type: "Bearer" }),
	];
	const fetchImpl: typeof fetch = async (input, init) => {
		requests.push({ url: String(input), init });
		return responses.shift()!;
	};
	const sleeps: number[] = [];

	const token = await pollForDeviceToken(
		fetchImpl,
		{
			deviceCode: "device-secret",
			userCode: "ABCD-EFGH",
			verificationUri: "https://auth.meta.com/oauth/device/",
			expiresInSeconds: 900,
			intervalSeconds: 5,
		},
		new AbortController().signal,
		async (ms) => {
			sleeps.push(ms);
		},
	);

	assert.equal(token.accessToken, "identity-token");
	assert.equal(requests.length, 2);
	assert.equal(requests[0]?.url, DEVICE_TOKEN_URL);
	assert.equal(requestBody(requests[0]?.init).get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
	assert.equal(requestBody(requests[0]?.init).get("device_code"), "device-secret");
	assert.deepEqual(sleeps, [5_000, 5_000]);
});

test("mints a subscription-backed Model API key", async () => {
	let request: { url: string; init?: RequestInit } | undefined;
	const fetchImpl: typeof fetch = async (input, init) => {
		request = { url: String(input), init };
		return jsonResponse({
			api_key: "model-api-key",
			base_url: "https://api.meta.ai/v1",
			is_subs_active: true,
			subs_tier_name: "Everyday Usage",
		});
	};

	const minted = await mintMuseKey(fetchImpl, "identity-token", new AbortController().signal);

	assert.equal(request?.url, MINT_URL);
	assert.equal(new Headers(request?.init?.headers).get("authorization"), "Bearer identity-token");
	assert.equal(new Headers(request?.init?.headers).get("x-api-version"), "1.0.0");
	assert.deepEqual(JSON.parse(String(request?.init?.body)), { show_subs_upsell: false });
	assert.deepEqual(minted, {
		apiKey: "model-api-key",
		baseUrl: "https://api.meta.ai/v1",
		subscriptionActive: true,
		subscriptionTier: "Everyday Usage",
	});
});

test("refuses a key when Meta does not confirm an active subscription", async () => {
	const fetchImpl: typeof fetch = async () =>
		jsonResponse({ api_key: "paygo-key", base_url: "https://api.meta.ai/v1", is_subs_active: false });

	await assert.rejects(
		mintMuseKey(fetchImpl, "identity-token", new AbortController().signal),
		/active Muse Code subscription/,
	);
});

test("login reports the device code and stores the minted key", async () => {
	const responses = [
		jsonResponse({
			device_code: "device-secret",
			user_code: "ABCD-EFGH",
			verification_uri: "https://auth.meta.com/oauth/device/",
			verification_uri_complete: "https://auth.meta.com/oauth/device/?code=ABCD-EFGH",
			expires_in: 900,
			interval: 1,
		}),
		jsonResponse({ access_token: "identity-token", token_type: "Bearer" }),
		jsonResponse({ api_key: "model-api-key", base_url: "https://api.meta.ai/v1", is_subs_active: true }),
	];
	const fetchImpl: typeof fetch = async () => responses.shift()!;
	const notices: unknown[] = [];

	const credential = await loginMetaMuse(
		{
			signal: new AbortController().signal,
			notify(event) {
				notices.push(event);
			},
			async prompt() {
				throw new Error("prompt should not be called");
			},
		},
		{ fetchImpl, sleep: async () => {} },
	);

	assert.deepEqual(notices, [
		{
			type: "device_code",
			userCode: "ABCD-EFGH",
			verificationUri: "https://auth.meta.com/oauth/device/?code=ABCD-EFGH",
			intervalSeconds: 1,
			expiresInSeconds: 900,
		},
	]);
	assert.equal(credential.type, "oauth");
	assert.equal(credential.access, "model-api-key");
	assert.equal(credential.refresh, "identity-token");
	assert.equal(credential.baseUrl, "https://api.meta.ai/v1");
	assert.equal(credential.subscriptionActive, true);
	assert.ok(credential.expires > Date.now());
	assert.deepEqual(await toMuseAuth(credential), {
		apiKey: "model-api-key",
		baseUrl: "https://api.meta.ai/v1",
	});
});

test("refresh re-mints the subscription key from the stored Meta identity token", async () => {
	let authorization: string | null = null;
	const fetchImpl: typeof fetch = async (_input, init) => {
		authorization = new Headers(init?.headers).get("authorization");
		return jsonResponse({
			api_key: "renewed-model-key",
			base_url: "https://api.meta.ai/v1",
			is_subs_active: true,
			subs_tier_name: "Everyday Usage",
		});
	};

	const refreshed = await refreshMetaMuse(
		{
			type: "oauth",
			access: "old-model-key",
			refresh: "identity-token",
			expires: 0,
			baseUrl: "https://api.meta.ai/v1",
			subscriptionActive: true,
		},
		new AbortController().signal,
		fetchImpl,
	);

	assert.equal(authorization, "Bearer identity-token");
	assert.equal(refreshed.access, "renewed-model-key");
	assert.equal(refreshed.refresh, "identity-token");
	assert.equal(refreshed.subscriptionTier, "Everyday Usage");
	assert.ok(refreshed.expires > Date.now());
});
