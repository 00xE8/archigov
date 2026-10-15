# Deploying Archigov

One image everywhere. The container built by the repository's `Dockerfile` is the whole product: a Node process,
one SQLite file under `DATA_DIR`, the built UI served from the same port. Everything in this folder is *around*
that image; nothing in `server/` or `web/` knows which of the two paths below it is running on.

| | Self-host |
|---|---|
| Runs on | Docker / Compose / any container host |
| State | a Docker volume at `/data` |
| Backups | nightly copies under `/data/backups`, optional Litestream to S3/R2/MinIO |
| Sign-in | `AUTH_MODE=local` (default) or `entra` |
| Status | **used daily; `docker compose up --build` is the smoke-tested path** |

A managed, hosted offering runs the same image; its front-door infrastructure is maintained in a private
repository and is not needed to self-host anything.

## Self-host

```bash
docker compose up --build                       # development: seeds the demo tenant, http://localhost:8080
docker compose -f docker-compose.prod.yml up -d  # production example: empty tenant, restart policy, healthcheck
```

Optional continuous replication of the SQLite file (S3, Cloudflare R2, MinIO, anything S3-compatible): set
`LITESTREAM_URL` (command-line mode) **or** mount `litestream/litestream.yml` at `/etc/litestream.yml`
(config-file mode). On an empty volume the entrypoint restores from the replica first, then runs the app as
Litestream's child process. The Litestream binary is pinned in the Dockerfile (`v0.5.17`, SHA-256 verified; a
checksum mismatch fails the build, an offline build simply skips it).

## Environment variables the image reads

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `8080` |
| `DATA_DIR` | SQLite file, blobs, backups, evidence packs | `/data` |
| `SEED_DEMO` | load the demo tenant on first boot of an empty database | `true` (`docker-compose.yml`), `false` in production |
| `APP_BASE_URL` | public URL used for sign-in redirects and links | — |
| `ARCHIGOV_FIXTURES` | `1` makes the Azure / Azure DevOps connectors read recorded responses instead of calling the APIs (demos, CI) | unset |
| **Sign-in** | | |
| `AUTH_MODE` | `local` (named user + role picker, no SSO) or `entra` | `local` |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` | Entra ID app registration (OIDC, app roles → archigov roles) | — |
| `ENTRA_CLIENT_SECRET` | confidential client; omit for a public client with PKCE | — |
| **Azure estate** | | |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | service principal with **Reader** on the subscriptions (Resource Graph, Defender for Cloud assessments, Azure Policy states); a managed identity works without the secret | — |
| `AZURE_SUBSCRIPTIONS` | comma-separated subscription ids in scope | all visible |
| **Azure DevOps feed** | | |
| `ADO_ORG`, `ADO_PROJECT` | organisation and project for the WIQL backfill and service hooks | — |
| `ADO_PAT` | personal access token (work items read); or rely on the Entra identity | — |
| `ADO_HOOK_SECRET` | shared secret the service hook must present to `POST /api/hooks/ado` | — |
| `ADO_WIQL` | override the backfill query | epics + features, active |
| **AI pre-review** | | |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | any OpenAI-compatible endpoint (Cloudflare AI Gateway, Azure OpenAI, Ollama); unset = deterministic rules-only pre-review. Per-provider/per-feature AI is configured in Settings · AI and wins over this | unset |
| `ARCHIGOV_SECRET_KEY` | master key for secrets stored in the settings table (AI provider keys): AES-256-GCM, so DB backups and Litestream replicas carry only ciphertext. Unset = a generated `DATA_DIR/keys/secret.key` (never replicated). Set it in production so the key lives in your secret store | unset |
| `AI_OPENAI_API_KEY`, `AI_ANTHROPIC_API_KEY`, `AI_MISTRAL_API_KEY`, `AI_OLLAMA_API_KEY` (each also as `…_FILE` for Docker/K8s secrets) | provider keys from the environment; a key here beats one saved in Settings and never touches the database | unset |
| **Replication** | | |
| `LITESTREAM_URL` | `s3://bucket/path/app.db` — command-line mode | unset |
| `LITESTREAM_CONFIG` | path to a Litestream 0.5 YAML — config-file mode (`/etc/litestream.yml` is picked up automatically) | unset |
| `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY` | replica credentials | — |
| `AWS_ENDPOINT`, `AWS_REGION` | S3-compatible endpoint (`https://<account>.r2.cloudflarestorage.com` + `auto`; MinIO `http://minio:9000` + `us-east-1`) | AWS defaults |
| `LITESTREAM_BUCKET`, `LITESTREAM_PATH` | only used by the example `litestream/litestream.yml` | — |

Secrets belong in an env file, the orchestrator's secret store, or `wrangler secret put` — never in compose files
or `wrangler.jsonc`.
