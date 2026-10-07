/**
 * pi-dynamic-model-catalog — live model catalogs for custom gateways.
 *
 * Pi treats a custom provider in models.json as a static list, and
 * `pi update --models` only refreshes the built-in radius catalog (that path
 * never loads extensions). This extension wires every custom provider up to
 * the official custom-provider `refreshModels` hook, so its model list is
 * discovered from the OpenAI-compatible `<baseUrl>/v1/models` instead.
 *
 * Key behavior: one refresh pass touches only the provider in use, so several
 * gateways never fan out to the network at once.
 *   - Resolution order: /dynamic-models argument > session model >
 *     settings defaultProvider/defaultModel > PI_DYNAMIC_MODEL_PROVIDER.
 *   - When nothing can be resolved, each pass still fetches only one provider
 *     (the one with the oldest catalog), which self-heals without fanning out.
 *   - Every other provider reuses its persisted catalog with zero requests.
 *
 * Persistence uses Pi's own provider-catalog store ~/.pi/agent/models-store.json
 * (keyed by provider id, with checkedAt): refresh passes write through
 * context.publish({ persist }), the load-time cold start writes the same file and
 * shape directly because no publish context exists yet. No separate cache file.
 * A failed or offline fetch keeps the previous catalog, so available models are
 * never emptied.
 *
 * When it refreshes:
 *   1. Extension load: a managed provider with no catalog yet is fetched once and
 *      persisted (disable with PI_DYNAMIC_MODELS_COLD_START=off), which is what
 *      makes `pi --list-models` and `pi -p` see the full list non-interactively;
 *   2. Interactive startup and a `/model <search>` miss (the allowNetwork pass);
 *   3. Non-interactive calls only run with allowNetwork:false, i.e. cache
 *      restore only;
 *   4. `/dynamic-models [providerId]` forces a refresh.
 *
 * Per-provider knobs live in models.json under `dynamicModels` (Pi's validator
 * allows unknown keys there):
 *   "dynamicModels": false                      # leave this provider alone
 *   "dynamicModels": { "ttlMinutes": 30,        # freshness window, default 10
 *                      "endpoints": ["http://host/custom/models"],
 *                      "headers": { "X-Key": "..." },
 *                      "auth": "x-api-key",     # bearer(default) | x-api-key | none
 *                      "defaults": { "contextWindow": 128000, "maxTokens": 16384 } }
 *
 * Environment variables:
 *   PI_DYNAMIC_MODELS_PROVIDERS=id1,id2   manage only these providers (may
 *                                         override the built-in vendor list)
 *   PI_DYNAMIC_MODEL_PROVIDER=id          declare the provider in use
 *   PI_DYNAMIC_MODELS_TTL_MINUTES=n       global freshness window
 *   PI_DYNAMIC_MODELS_COLD_START=off      disable the first fetch at load time
 *
 * Gateways that serve bare ids with no metadata flatten to the fallback window;
 * pin contextWindow/maxTokens/reasoning/input per model under models.json
 * `modelOverrides`, which Pi applies on top of discovered models. See README.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/** pi-ai's RefreshModelsContext, declared structurally locally to avoid pinning an export path. */
type RefreshContext = {
	credential?: { type: string; key?: string; env?: Record<string, string> };
	stored?: { models?: readonly unknown[]; checkedAt?: number };
	publish(publication: { persist?: unknown; update?: () => void }): Promise<boolean>;
	allowNetwork: boolean;
	force?: boolean;
	signal: AbortSignal;
};

type DynamicSettings = {
	enabled?: boolean;
	ttlMinutes?: number;
	endpoints?: string[];
	headers?: Record<string, string>;
	auth?: "bearer" | "x-api-key" | "none";
	defaults?: { contextWindow?: number; maxTokens?: number };
};

type ProviderEntry = {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	models?: ProviderModelConfig[];
	dynamicModels?: false | DynamicSettings;
};

/** One entry from a gateway's /v1/models, using the common OpenAI-compatible superset. */
type RemoteModel = {
	id?: string;
	name?: string;
	display_name?: string;
	context_length?: number;
	max_output_tokens?: number;
	modalities?: { input?: string[] };
	capabilities?: { reasoning?: boolean; vision?: boolean };
	pricing?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
};

const LOAD_TIMEOUT_MS = 8000;
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 16_384;

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function readJson(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function envList(name: string): string[] {
	return (process.env[name] ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

/**
 * Persist a catalog outside a refresh context, where context.publish does not
 * exist. Same shape and file as pi's own store, re-read on every write so other
 * providers' entries survive a concurrent refresh. A store we cannot parse is
 * left alone -- repairing it is pi's job, not a reason to wipe it.
 */
function persistCatalog(id: string, models: ProviderModelConfig[], checkedAt: number): void {
	const path = join(agentDir(), "models-store.json");
	// No store file yet is normal; an unparseable one is pi's to repair, never ours to replace.
	let store: Record<string, unknown> | undefined = {};
	if (existsSync(path)) store = readJson(path);
	if (!store) return;
	store[id] = { models, checkedAt };
	const json = `${JSON.stringify(store, null, 2)}\n`;
	try {
		writeFileSync(`${path}.tmp`, json, "utf8");
		renameSync(`${path}.tmp`, path);
	} catch {
		try {
			writeFileSync(path, json, "utf8");
		} catch {
			// Read-only or missing agent dir: the catalog stays in memory for this run.
		}
	}
}

function ttlMs(settings: DynamicSettings | undefined): number {
	const minutes =
		Number(process.env.PI_DYNAMIC_MODELS_TTL_MINUTES) || settings?.ttlMinutes || 10;
	return minutes * 60 * 1000;
}

/** `$VAR` / `${VAR}` keys are left for pi to resolve; at load time only literal and env forms. */
function resolveEnvKey(raw: string | undefined): string | undefined {
	if (!raw || raw.startsWith("!")) return undefined;
	const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(raw);
	return match ? process.env[match[1]] : raw;
}

/**
 * Fill any model entry into the shape the extension layer requires.
 * models.json `models` uses its own schema (name/cost may be omitted), but once
 * those entries go back to pi through registerProvider `models` or a
 * refreshModels return value they are validated by the extension layer and the
 * whole list is replaced -- a missing field fails registration outright.
 * So defaults are filled here, and the spread keeps thinkingLevelMap, compat,
 * and any other original fields. 
 */
function toExtensionModel(entry: ProviderModelConfig, spec: Spec): ProviderModelConfig {
	const raw = entry as unknown as Record<string, unknown>;
	const defaults = spec.settings.defaults;
	return {
		...raw,
		id: String(raw.id),
		name: typeof raw.name === "string" && raw.name ? raw.name : String(raw.id),
		reasoning: raw.reasoning === true,
		input: Array.isArray(raw.input) && raw.input.length > 0 ? raw.input : ["text"],
		cost: raw.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: numberOr(raw.contextWindow as number | undefined, numberOr(defaults?.contextWindow, FALLBACK_CONTEXT_WINDOW)),
		maxTokens: numberOr(raw.maxTokens as number | undefined, numberOr(defaults?.maxTokens, FALLBACK_MAX_TOKENS)),
	} as ProviderModelConfig;
}

function endpointsFor(baseUrl: string, settings: DynamicSettings | undefined): string[] {
	if (settings?.endpoints?.length) return settings.endpoints;
	const trimmed = baseUrl.replace(/\/+$/, "");
	return /\/v\d+$/.test(trimmed) ? [`${trimmed}/models`] : [`${trimmed}/v1/models`, `${trimmed}/models`];
}

function authHeaders(spec: Spec): Record<string, string> {
	const style = spec.settings.auth ?? "bearer";
	const key = spec.apiKey ?? "";
	return style === "bearer"
		? { Authorization: `Bearer ${key}` }
		: style === "x-api-key"
			? { "x-api-key": key }
			: {};
}

type Spec = {
	id: string;
	name: string;
	baseUrl: string;
	api?: string;
	/** Raw value from models.json, possibly $VAR; left for pi to resolve credentials. */
	apiKeyRaw?: string;
	/** Already-resolved key used internally during load. */
	apiKey?: string;
	settings: DynamicSettings;
	staticModels: ProviderModelConfig[];
};

/** Providers this extension manages: custom entries in models.json minus built-in vendors. */
async function collectSpecs(): Promise<Spec[]> {
	const config = readJson(join(agentDir(), "models.json"));
	const providers = (config?.providers ?? {}) as Record<string, ProviderEntry>;
	const pinned = envList("PI_DYNAMIC_MODELS_PROVIDERS");
	const builtins = await builtinProviderIds();
	const specs: Spec[] = [];
	for (const [id, entry] of Object.entries(providers)) {
		const settings: DynamicSettings = typeof entry?.dynamicModels === "object" ? entry.dynamicModels : {};
		if (entry?.dynamicModels === false || settings.enabled === false) continue;
		// Built-in vendors come from pi's bundled catalog; taking one over would empty it,
		// unless the user explicitly names it.
		if (pinned.length === 0 ? builtins.has(id) : !pinned.includes(id)) continue;
		const baseUrl = entry?.baseUrl;
		if (!baseUrl) continue;
		specs.push({
			id,
			name: entry?.name ?? id,
			baseUrl,
			api: entry?.api,
			apiKeyRaw: entry?.apiKey,
			apiKey: resolveEnvKey(entry?.apiKey),
			settings,
			staticModels: Array.isArray(entry?.models) ? entry.models : [],
		});
	}
	// Normalize the static fallback list too, so pi's validation never rejects registration.
	for (const spec of specs) spec.staticModels = spec.staticModels.map((model) => toExtensionModel(model, spec));
	return specs;
}

/** pi 1.0.4 built-in vendor snapshot, used only when the runtime import below fails. */
const BUILTIN_PROVIDER_IDS = [
	"amazon-bedrock", "ant-ling", "anthropic", "azure", "baseten", "cerebras", "cloudflare-ai-gateway",
	"cloudflare-workers-ai", "deepseek", "fireworks", "github-copilot", "google", "google-vertex", "groq",
	"huggingface", "kimi-coding", "meta", "minimax", "minimax-cn", "moonshotai", "moonshotai-cn", "nvidia",
	"openai", "openai-codex", "opencode", "opencode-go", "openrouter", "qwen-token-plan", "qwen-token-plan-cn",
	"qwen-token-plan-individual", "radius", "together", "typesafe", "vercel-ai-gateway", "xai", "xiaomi",
	"xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "zai", "zai-coding-cn",
];

/** Prefer pi's real built-in list; fall back to the snapshot above, never take vendors over. */
async function builtinProviderIds(): Promise<Set<string>> {
	try {
		const module = (await import("@earendil-works/pi-ai/providers/all")) as unknown as {
			builtinProviders?: () => Array<{ id: string }>;
		};
		const ids = module.builtinProviders?.().map((provider) => provider.id);
		return new Set(ids && ids.length > 0 ? ids : BUILTIN_PROVIDER_IDS);
	} catch {
		return new Set(BUILTIN_PROVIDER_IDS);
	}
}

function numberOr(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalize(entry: RemoteModel, spec: Spec): ProviderModelConfig | undefined {
	const id = typeof entry.id === "string" && entry.id ? entry.id : undefined;
	if (!id) return undefined;
	const declared = (entry.modalities?.input ?? []).filter((kind) => kind === "text" || kind === "image");
	const input = declared.includes("image") || entry.capabilities?.vision === true ? ["text", "image"] : declared;
	return {
		id,
		name: entry.name ?? entry.display_name ?? id,
		reasoning: entry.capabilities?.reasoning === true,
		input: input.length > 0 ? input : ["text"],
		cost: {
			input: numberOr(entry.pricing?.input, 0),
			output: numberOr(entry.pricing?.output, 0),
			cacheRead: numberOr(entry.pricing?.cache_read, 0),
			cacheWrite: numberOr(entry.pricing?.cache_write, 0),
		},
		contextWindow: numberOr(entry.context_length, numberOr(spec.settings.defaults?.contextWindow, FALLBACK_CONTEXT_WINDOW)),
		maxTokens: numberOr(entry.max_output_tokens, numberOr(spec.settings.defaults?.maxTokens, FALLBACK_MAX_TOKENS)),
	};
}

async function fetchCatalog(spec: Spec, signal: AbortSignal): Promise<ProviderModelConfig[]> {
	const urls = endpointsFor(spec.baseUrl, spec.settings);
	let lastError = "no candidate endpoints";
	for (const url of urls) {
		try {
			const response = await fetch(url, {
				headers: { Accept: "application/json", ...authHeaders(spec) },
				signal,
			});
			if (!response.ok) {
				lastError = `${url} returned HTTP ${response.status}`;
				continue;
			}
			const body = (await response.json()) as { data?: RemoteModel[] } | RemoteModel[];
			const list = Array.isArray(body) ? body : body.data;
			if (!Array.isArray(list)) throw new Error(`${url} returned no model array`);
			const models: ProviderModelConfig[] = [];
			for (const entry of list) {
				const model = normalize(entry, spec);
				if (model) models.push(model);
			}
			if (models.length === 0) throw new Error(`${url} had no usable models`);
			return models;
		} catch (error) {
			if (signal.aborted) throw error;
			lastError = `${url} -> ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	throw new Error(`Model catalog fetch failed: ${lastError}`);
}

export default async function dynamicModels(pi: ExtensionAPI): Promise<void> {
	const specs = await collectSpecs();
	if (specs.length === 0) return;

	// pi's official provider-catalog store: { [providerId]: { models, checkedAt, ... } }
	const store = (readJson(join(agentDir(), "models-store.json")) ?? {}) as Record<
		string,
		{ models?: ProviderModelConfig[]; checkedAt?: number }
	>;
	const catalogs = new Map<string, { models: ProviderModelConfig[]; checkedAt: number }>();
	for (const spec of specs) {
		const stored = store[spec.id];
		if (stored && Array.isArray(stored.models) && stored.models.length > 0) {
			catalogs.set(spec.id, {
				models: stored.models.map((model) => toExtensionModel(model, spec)),
				checkedAt: stored.checkedAt ?? 0,
			});
		}
	}

	if (process.env.PI_DYNAMIC_MODELS_COLD_START !== "off") {
		// Fetch once at load time for a provider with no catalog yet, and persist it: the
		// store entry survives, so the next non-interactive run needs no cold-start fetch.
		await Promise.all(
			specs
				.filter((spec) => !catalogs.has(spec.id) && spec.apiKey)
				.map(async (spec) => {
					try {
						const models = await fetchCatalog(spec, AbortSignal.timeout(LOAD_TIMEOUT_MS));
						const checkedAt = Date.now();
						catalogs.set(spec.id, { models, checkedAt });
						persistCatalog(spec.id, models, checkedAt);
					} catch {
						// A cold-start failure never blocks loading; the next refresh retries.
					}
				}),
		);
	}

	let sessionProvider: string | undefined;
	/** Provider explicitly named by /dynamic-models, allowed past the one-provider gate. */
	let forcedProvider: string | undefined;

	function settingsDefaultProvider(): string | undefined {
		try {
			const settings = pi.getSettings() as { defaultProvider?: string; defaultModel?: string };
			const fromModel = settings.defaultModel?.includes("/")
				? settings.defaultModel.slice(0, settings.defaultModel.indexOf("/"))
				: undefined;
			const candidate = fromModel ?? settings.defaultProvider;
			return candidate && specs.some((spec) => spec.id === candidate) ? candidate : undefined;
		} catch {
			return undefined;
		}
	}

	/** The provider in use; undefined when it cannot be resolved. */
	function activeProvider(): string | undefined {
		const forced = process.env.PI_DYNAMIC_MODEL_PROVIDER;
		if (forced && specs.some((spec) => spec.id === forced)) return forced;
		if (sessionProvider && specs.some((spec) => spec.id === sessionProvider)) return sessionProvider;
		return settingsDefaultProvider();
	}

	/**
	 * Fallback when the active provider cannot be resolved: the whole process pins
	 * the single provider with the oldest catalog. It must stay pinned, because
	 * refreshes are awaited one by one -- after the first fetch its checkedAt is
	 * newest, so "oldest" would slide to the next provider and one pass would hit
	 * every gateway.
	 */
	let designatedProvider: string | undefined;
	function designated(): string | undefined {
		if (designatedProvider) return designatedProvider;
		let best: { id: string; checkedAt: number } | undefined;
		for (const spec of specs) {
			const checkedAt = catalogs.get(spec.id)?.checkedAt ?? 0;
			if (!best || checkedAt < best.checkedAt || (checkedAt === best.checkedAt && spec.id < best.id)) {
				best = { id: spec.id, checkedAt };
			}
		}
		designatedProvider = best?.id;
		return designatedProvider;
	}

	function currentModels(spec: Spec): ProviderModelConfig[] {
		return catalogs.get(spec.id)?.models ?? spec.staticModels;
	}

	function refreshModels(spec: Spec, context: RefreshContext): Promise<ProviderModelConfig[]> {
		const cached = currentModels(spec);
		// The allowNetwork:false pass only restores cache; non-interactive runs stop here.
		if (!context.allowNetwork) return Promise.resolve(cached);
		// One refresh admits one provider: the active one, else the oldest catalog, else the named one.
		if (forcedProvider !== spec.id) {
			const active = activeProvider();
			if (active ? active !== spec.id : designated() !== spec.id) return Promise.resolve(cached);
		}
		if (!context.force) {
			const checkedAt = catalogs.get(spec.id)?.checkedAt ?? 0;
			if (checkedAt && Date.now() - checkedAt < ttlMs(spec.settings)) return Promise.resolve(cached);
		}
		// Prefer pi's already-resolved credential ($VAR, !command, /login results).
		const key = context.credential?.key ?? spec.apiKey;
		if (!key) return Promise.resolve(cached);
		return fetchCatalog({ ...spec, apiKey: key }, context.signal)
			.then((models) => {
				const checkedAt = Date.now();
				catalogs.set(spec.id, { models, checkedAt });
				// Persist through pi's catalog store so later cold starts and offline runs reuse it.
				void context.publish({ persist: { models, checkedAt } });
				return models;
			})
			.catch(() => cached); // Keep the last catalog on gateway restart or network loss
	}

	for (const spec of specs) {
		const models = currentModels(spec);
		pi.registerProvider(spec.id, {
			name: spec.name,
			baseUrl: spec.baseUrl,
			...(spec.api ? { api: spec.api } : {}),
			// Hand pi the raw apiKey from models.json so it resolves $VAR / !command itself.
			models,
			refreshModels: (context: RefreshContext) => refreshModels(spec, context),
		});
	}

	pi.on("session_start", (_event, ctx) => {
		sessionProvider = ctx.model?.provider;
	});
	pi.on("model_select", (event) => {
		sessionProvider = event.model?.provider;
	});

	pi.registerCommand("dynamic-models", {
		description: "Refresh the model catalog of the current provider (/dynamic-models [providerId])",
		handler: async (args, ctx) => {
			const target = args.trim() || activeProvider() || designated();
			if (!target) {
				ctx.ui.notify("No provider is managed by pi-dynamic-model-catalog", "warning");
				return;
			}
			const spec = specs.find((item) => item.id === target);
			if (!spec) {
				ctx.ui.notify(`${target} is not a provider managed by this extension`, "warning");
				return;
			}
			const before = currentModels(spec).length;
			// Use pi's own refresh path: PI_OFFLINE decides allowNetwork, force bypasses TTL.
			forcedProvider = target;
			let result;
			try {
				result = await ctx.modelRegistry.refresh({ providers: [target], force: true });
			} finally {
				forcedProvider = undefined;
			}
			const after = currentModels(spec).length;
			if (result.errors.size > 0) {
				ctx.ui.notify(`${target}: refresh failed, keeping ${after} cached models`, "error");
			} else if (result.aborted) {
				ctx.ui.notify(`${target}: refresh interrupted, keeping ${after} cached models`, "warning");
			} else {
				ctx.ui.notify(`${target}: model catalog ${before} -> ${after}`, "info");
			}
		},
	});
}
