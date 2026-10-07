# pi-dynamic-model-catalog

Keep custom gateway providers in `~/.pi/agent/models.json` live: the model list is
discovered from the gateway's OpenAI-compatible `/v1/models` instead of a list you
have to hand-edit every time the gateway adds a model.

## Why this exists

Pi only refreshes catalogs for providers that implement `refreshModels`, and on pi
1.0.4 that means the built-in `radius` provider. Two consequences:

- A custom provider in `models.json` is a **static list**. Pi never calls its
  `/v1/models` endpoint.
- `pi update --models` cannot help: that code path builds the model runtime
  **without loading extensions**, so no extension can hook it — and it exits
  silently when no credential resolves, while still printing
  `Model catalogs refreshed`.

This extension registers each custom provider through the official
[custom-provider](https://pi.dev/docs/custom-provider) hook surface
(`registerProvider` + `refreshModels`), so discovery runs on the paths pi does
call: interactive startup, a `/model <search>` miss, post-`/login`, and
`/dynamic-models`.

## Install

```bash
pi install npm:pi-dynamic-model-catalog
```

Try it for a single run without touching settings:

```bash
pi -e npm:pi-dynamic-model-catalog --list-models
```

Nothing to configure — declaring a provider in `models.json` is the opt-in:

```jsonc
{
  "providers": {
    "my-gateway": {
      "baseUrl": "http://127.0.0.1:8787/v1",
      "api": "openai-completions",
      "apiKey": "sk-...",
      "dynamicModels": { "ttlMinutes": 10 }
    }
  }
}
```

Built-in vendors are left alone (their list comes from pi's bundled catalog, and
taking one over would empty it). Provider ids are matched against pi's own list at
runtime, with a pi 1.0.4 snapshot as fallback.

## Gateways that serve bare ids — read this

Some gateways return only `{ id, object, owned_by }`, with no context window,
output cap, modality, or reasoning flag. Discovered entries then fall back to
128 000 / 16 384, `input: ["text"]`, `reasoning: false` — which silently loses the
real window and vision support.

Pin those fields in `modelOverrides`, because pi applies them **on top of**
extension-discovered models (`provider-composer.js`: registry → `models` →
extension → `modelOverrides`):

```jsonc
"my-gateway": {
  "baseUrl": "http://127.0.0.1:8787/v1",
  "api": "openai-completions",
  "models": [
    { "id": "fast-model", "input": ["text", "image"], "reasoning": true,
      "contextWindow": 1048576, "maxTokens": 131072 }
  ],
  "modelOverrides": {
    "fast-model": { "contextWindow": 1048576, "maxTokens": 131072,
                    "reasoning": true, "input": ["text", "image"] }
  }
}
```

`models` alone is not enough: the first refresh replaces the whole list, so every
field that must survive has to sit in `modelOverrides`.

## Configuration

`dynamicModels` accepts an object or `false` (leave that provider to its static
list):

| Key | Default | Meaning |
| --- | --- | --- |
| `ttlMinutes` | `10` | Freshness window; a fresh catalog is reused with zero requests |
| `endpoints` | derived | Explicit list of model-list URLs, tried in order |
| `headers` | – | Extra request headers, e.g. a gateway-specific auth header |
| `auth` | `bearer` | `bearer` \| `x-api-key` \| `none` |
| `defaults` | `128000` / `16384` | `contextWindow` / `maxTokens` for gateways that report neither |

With no `endpoints`, the base URL is probed as `<base>/models` when it already ends
in `/v1` (or `/vN`), otherwise `<base>/v1/models` then `<base>/models` — so both
`http://host:8090/v1` and `http://host:8090` work.

Environment variables:

| Variable | Effect |
| --- | --- |
| `PI_DYNAMIC_MODELS_PROVIDERS=id1,id2` | Manage only these providers (may include built-in ids) |
| `PI_DYNAMIC_MODEL_PROVIDER=id` | Declare which provider is in use |
| `PI_DYNAMIC_MODELS_TTL_MINUTES=n` | Global freshness window |
| `PI_DYNAMIC_MODELS_COLD_START=off` | Skip the first fetch at load time |

## One refresh, one provider

With several gateways configured, each refresh pass fetches **at most one** of
them, chosen in this order:

1. the provider named on `/dynamic-models [providerId]`;
2. the provider in use — session model, then `defaultModel`/`defaultProvider` in
   settings, then `PI_DYNAMIC_MODEL_PROVIDER`;
3. if none can be resolved, the provider with the **oldest** catalog, pinned for
   the whole process so it self-heals without ever fanning out.

Every other provider is served from its persisted catalog with no network access.

## Storage and failure behavior

Catalogs persist into `~/.pi/agent/models-store.json`, keyed by provider id with
`checkedAt` — no separate cache file, and an interactive start reads pi's own cache
like any built-in provider. Refresh passes hand the catalog to pi through the
official store (`context.publish({ persist })`); the load-time cold start writes the
same file in the same shape, since `context.publish` does not exist outside a refresh
context. That write re-reads the file first (other providers' entries survive), keeps
only what it can parse (an unreadable store is pi's to repair, not a reason to wipe
it), and lands through a temp file + rename.

A failed, aborted, or offline fetch keeps the previous catalog. Clearing available
models is never a failure mode: `pi -p` still works after the gateway restarts,
goes away, or loses its wallet balance.

So the very first `pi --list-models` or `pi -p` after install already shows the live
list *and* leaves a cached catalog behind: the next non-interactive run restores from
the store with zero requests. Set `PI_DYNAMIC_MODELS_COLD_START=off` if you would
rather nothing be fetched at load time — with it off, a run that has never had an
interactive refresh falls back to the `models` list in `models.json`, so keep that
seeded (see the `modelOverrides` section above). The same fallback applies to a
provider whose `apiKey` is a `"!command"` form: only literal and `"$VAR"` keys are
resolvable at load time, so those providers are fetched on refresh passes, not at
cold start.

Non-interactive calls reach pi's own refresh with `allowNetwork: false`, i.e. cache
restore only.

## Commands

`/dynamic-models [providerId]` forces a refresh through pi's own refresh chain and
reports `model catalog 34 -> 34` (or the cached count on failure).

## Security notes

- No keys in this package. Requests use pi's already-resolved credential
  (`context.credential.key`), so `$VAR`, `!command`, and `/login` results keep
  working; the extension never re-reads `models.json` secrets for the refresh path.
- Your `models.json` holds the plaintext gateway key. Keep it out of repositories
  and synced folders; prefer `"$MY_GATEWAY_KEY"` or `"!command"` form over a literal.
- `models-store.json` holds model metadata only, never credential values.

## Prior art

`pi-dynamic-models` on npm does the same core discovery; this package exists for
the multi-gateway behavior (one provider per refresh, TTL, per-provider `auth` /
`endpoints` / `headers` / `defaults` knobs) and for persisting through pi's own
catalog store instead of a custom cache file.

## Tested against

pi 1.0.4, Node 24, two real gateways:

- An OpenAI-compatible gateway on loopback whose `/v1/models` returns bare ids only
  (34 models). Windows and vision came back through `modelOverrides`; streaming and
  tool calls verified through `pi -p`.
- An Anthropic-compatible gateway whose `/v1/models` reports `context_length`,
  `max_output_tokens`, `modalities`, `capabilities` and `pricing` — all read by the
  normalizer, 18 models.

Discovery itself was verified with a provider whose `models` list is empty: without
the extension `pi --list-models` shows 0 models, with it 34, and `pi -p` returns a
normal reply using a `"$ENV_VAR"` key form (resolved by pi, never by this package).

MIT
