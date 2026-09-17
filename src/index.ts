import {
	createProvider,
	type OAuthCredential,
	openAIResponsesApi,
	type ProviderAuthInteraction,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { FALLBACK_MODELS, fetchMuseModels } from "./models.ts";
import {
	DEFAULT_API_BASE_URL,
	loginMetaMuse,
	refreshMetaMuse,
	toMuseAuth,
	type MuseOAuthCredential,
} from "./oauth.ts";

const PROVIDER_ID = "meta-muse";

function asMuseCredential(credential: OAuthCredential): MuseOAuthCredential {
	if (
		typeof credential.baseUrl !== "string" ||
		typeof credential.subscriptionActive !== "boolean"
	) {
		throw new Error("Stored Meta Muse credential is incomplete; run /login and configure Meta Muse Code again");
	}
	return credential as MuseOAuthCredential;
}

export default function metaMuseExtension(pi: ExtensionAPI): void {
	pi.registerProvider(
		createProvider({
			id: PROVIDER_ID,
			name: "Meta Muse Code",
			baseUrl: DEFAULT_API_BASE_URL,
			auth: {
				oauth: {
					name: "Meta Muse Code (subscription)",
					isSubscription: true,
					loginLabel: "Sign in with Meta Muse Code",
					login: (interaction: ProviderAuthInteraction) => loginMetaMuse(interaction),
					refresh: async (credential: OAuthCredential, signal: AbortSignal) =>
						refreshMetaMuse(asMuseCredential(credential), signal),
					toAuth: async (credential: OAuthCredential) =>
						toMuseAuth(asMuseCredential(credential)),
				},
			},
			models: FALLBACK_MODELS,
			fetchModels: async ({ credential, signal }) => {
				if (credential?.type !== "oauth" || !credential.access) return FALLBACK_MODELS;
				return fetchMuseModels(fetch, credential.access, signal);
			},
			api: openAIResponsesApi(),
		}),
	);
}
