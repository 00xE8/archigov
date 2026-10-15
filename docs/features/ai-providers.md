# AI providers and per-feature enablement

## What it is

The platform admin configures AI providers — OpenAI, Claude (Anthropic), Mistral, Ollama — and switches each AI feature on separately, with its own provider and model: pre-review can run on a local Ollama while decision drafting uses a hosted model, or everything stays off. Every feature keeps a deterministic fallback, so the product is whole with no model configured.

Nine features, each an instance of the heuristics/AI boundary (AI proposes, a named human promotes):

| Feature | Pattern | What it does |
|---|---|---|
| Pre-review | floor + recall | Cited advisory findings on top of the deterministic checks; never approves |
| Decision Drafting | generate → verify | MADR draft from a work item; the author edits and submits |
| Rule Drafting | generate → verify | JSON-DSL rule from a statement; `validateRule` + a live dry run come back with the draft; a board still adopts |
| Control References | suggest → pin | Framework references for a draft artefact; the author prunes and saves |
| Assessment Drafting | derive → narrate | Prefills the type's template headings from the review; gaps say "To be confirmed". Also drafts the yearly legacy assessment from the legacy register's facts (`POST /applications/:id/legacy-assessments/draft`) and an exit plan from what the model knows about a reliance (`POST /applications/:id/exit-plans/draft`), capability `verify` |
| Session Notes Drafting | derive → narrate | Secretary's narrative from the session records; the minutes stay derived |
| Evidence Mapping | suggest → pin | Control ids for unmapped `defender:`/`policy:` keys into the control-map editor; the admin saves to pin |
| Classification Suggestion | suggest → confirm | Tier and dependent services for an application the tags leave open, from its resources, tags, decisions and planned changes; normalised to the classification invariants (a regulated service means critical), shown in the Classify form with Apply Suggestion; the author saves it with their own reason. `POST /applications/:id/classification/suggest`, capability `verify`. See [criticality classification](criticality-classification.md) |
| Decision Review | verify the human | Critical assessment of a decision draft's argument (unsupported claims, strawman options, unstated risks, contradictions with adopted artefacts by code) + a tightened version to apply; suggests the assessments that would evidence unevidenced critical claims — one click saves the draft decision and triggers them, tracked (`decision_id`) onto the eventual review as "On the Decision". `POST /decisions/review-draft`, `create_decision`; the form's AI Review panel (right column, Review Argument button at its top) is always visible; the button greys out with an explanatory tooltip when the admin has not enabled the feature |

## Why

AI in this product proposes and narrates; it never decides (see the heuristics/AI boundary in the research notes). Per-feature enablement keeps that boundary administrable: a tenant can adopt AI one feature at a time, pin different models to different jobs, and switch any of it off without losing the deterministic behaviour. BYO keys and a local-Ollama option keep the open-source and enterprise economics honest.

## Who can do what

- **Platform admin** (`manage_platform`): configures providers, enables features, runs the connection test. Everyone else gets 403 on `POST /settings` and `POST /ai/test` (the default rule for unlisted mutations).
- Everyone sees the *effect* (AI pre-reviews on reviews, drafts on work items) — always `origin='ai'`, `verification='unverified'`, citations filtered to ones that resolve, never an approval.

## Key handling (secrets management)

Keys saved through Settings are **encrypted at rest** (AES-256-GCM, `secrets.ts`): the settings table holds `enc:v1:…` ciphertext, so DB backups and Litestream replicas never carry a usable key. The master key is `ARCHIGOV_SECRET_KEY` on the container (the production path — the key lives in the operator's secret store), else a generated `DATA_DIR/keys/secret.key` (0600, beside the evidence-signing key; the keys directory is never in backups or replicas). A key from before encryption re-encrypts on first read; rotating the master key invalidates stored ciphertexts and the admin re-enters them.

The operator's secret store beats the database: `AI_<PROVIDER>_API_KEY` (or `AI_<PROVIDER>_API_KEY_FILE`, the Docker/Kubernetes secrets convention) wins over a saved key, and the UI shows "Key From Environment" with the field disabled. Either way, keys are never returned by `GET /settings` (only `key_set` and `key_source`), never written to the audit log (the audit row says `set`/`cleared`/`kept`), never included in exports or the evidence pack, and never echoed in errors. An empty string clears a stored key; omitting the field keeps it.

## API

- `GET /settings` → `ai.providers` (label, effective base URL, `key_set`, `key_source`, `configured`, placeholder model) and `ai.features` (enabled, provider, model, source `settings`|`env`). The legacy `llm` summary stays for older clients.
- `GET /ai/features` → `{<feature id>: boolean}` — readable by every role, so pages show or hide their Draft buttons.
- `POST /settings` with `ai_providers: {<id>: {api_key?, base_url?}}` and/or `ai_features: {<id>: {enabled, provider, model}}`; unknown ids and non-http(s) base URLs are 400.
- `POST /ai/test` with `{provider, model?}` → one-line round-trip (`Reply with exactly: ok`); 502 with a key-free error on failure.
- Draft endpoints — each 409 when its feature is off, nothing stored, every response marked `origin: "ai"` with provider and model:
  `POST /artefacts/draft-rule` and `POST /artefacts/suggest-references` (capability `manage_artefacts` — the author's), `POST /reviews/:id/assessments/draft` (`comment`/`submit_review`), `POST /sessions/:id/draft-notes` (the chair's or secretary's, like the notes themselves), `POST /evidence/suggest-mapping` (`manage_platform`; suggestions filtered to keys the instance has actually seen), `POST /decisions/review-draft` (`create_decision`), `POST /applications/:id/classification/suggest` (`verify`).

## Adapters

OpenAI, Mistral and Ollama speak OpenAI chat-completions (`{base}/chat/completions`, `Authorization: Bearer`; native JSON mode for OpenAI/Mistral, an instruction for Ollama; Ollama needs no key). Claude speaks the Anthropic Messages API (`{base}/v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`, system as a top-level field, JSON mode as an instruction). The legacy `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` environment gateway still drives any enabled feature with no explicit configuration, so existing deployments keep working; an admin's explicit `enabled: false` wins over it.

## Data & audit

Settings keys `ai.providers` and `ai.features` in the settings table (migrations untouched). Audit actions: `update` on settings with key material redacted, `ai:test` with provider and model. Pre-review events record `engine`, `provider` and `model` in their data.

## UI

Settings · **AI** (platform admin only, like all of Settings): a card per provider (API key as a password field — "Saved — leave blank to keep", base URL with its default, a Test button with a model box), and a Features table (toggle · provider · model) with the deterministic-fallback statement. The Environment Gateway snippet documents the env fallback.

## Verification

`server/test/ai-providers.test.ts` (9 tests): defaults off; admin-only; key masking in responses and the audit log; provider/feature validation; the Mistral path (endpoint, Bearer, native JSON mode, unresolvable citations discarded); the Anthropic Messages shape; Ollama keyless with no response_format; the deterministic path making no network call when a feature is off; clear-vs-keep key semantics. `server/test/ai-features.test.ts` (12 tests): every draft endpoint 409 when off; ciphertext at rest and legacy-plaintext re-encryption; env and `_FILE` keys beating the database; draft-rule generate→verify (valid rule validated with blast radius, unknown op refused in place); reference trimming; per-endpoint capabilities (auditor and platform admin refused where authorship is required, decision maker refused on notes); the decision review and the classification suggestion (normalised to the classification invariants, nothing stored). Live-verified against the Mistral API: `/ai/test`, a real pre-review (origin `ai`, provider `mistral`, resolving citations), a decision draft, a drafted rule that correctly asserted on imported evidence (`op: evidence`, control `web-https-only`, dry run included) and six plausible control references.
