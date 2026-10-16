# Deploying Archigov

One image everywhere. The container built by the repository's `Dockerfile` is the whole product: a Node process,
one SQLite file under `DATA_DIR`, the built UI served from the same port. Everything in this folder is *around*
that image; nothing in `server/` or `web/` knows which of the two paths below it is running on.

| | Self-host |
|---|---|
| Runs on | Docker / Compose / any container host |
| State | a Docker volume at `/data` |
| Backups | nightly copies under `/data/backups`; optional continuous replication with Litestream (below) |
| Sign-in | `AUTH_MODE=local` (default) or `entra` |
| Status | **used daily; `docker compose up --build` is the smoke-tested path** |

A managed, hosted offering runs the same image; its front-door infrastructure is maintained in a private
repository and is not needed to self-host anything.

## Self-host

```bash
docker compose up --build                       # development: seeds the demo tenant, http://localhost:8080
docker compose -f docker-compose.prod.yml up -d  # production example: empty tenant, restart policy, healthcheck
```

## Replication with Litestream

**What it is.** [Litestream](https://litestream.io) streams every change to the SQLite file to a replica: object
storage or another disk. Changes are pushed about once a second, with a full snapshot daily; history is kept for a day
in one-URL mode (Litestream's default) and a week with the example config file.
The image ships it, pinned to `v0.5.17` and SHA-256 verified in the `Dockerfile`; a checksum mismatch fails the build,
and an offline build simply skips it. When it is configured, `docker/entrypoint.sh` does two things on every start:

1. if `/data/app.db` does not exist, it restores the latest state from the replica (a no-op if the replica is empty);
2. it runs the app as Litestream's child process, so replication starts and stops with it.

**Why.** All of Archigov's state is one SQLite file. The nightly backups (`/data/backups`, last 14) sit on the same
volume as the database, so they do not survive losing the volume or the host, and they can lose up to a day. A replica
elsewhere does both: at most a second or so of writes at risk, and restore to any moment in the retention period.

**When to use it.**

| Situation | Nightly backups alone | Add Litestream |
|---|---|---|
| Evaluation, demo, a laptop | Enough | — |
| Production on a host whose volume you already snapshot off-host | Often enough | If you want seconds, not a day, of recovery point |
| Production where losing the volume or host must not lose data | Not enough | **Yes** |
| A container platform whose disks are ephemeral (no persistent volume) | Not enough | **Required**: it is what brings the data back on each start (the managed service runs this way) |
| Moving to a new host | — | Start the new host with the same replica settings and an empty volume: it restores itself |

**How.** Pick one of two modes.

*One URL* (`LITESTREAM_URL`):

```ini
# Object storage: AWS S3, Cloudflare R2, or any S3-compatible store
LITESTREAM_URL=s3://archigov-backups/prod/app.db
LITESTREAM_ACCESS_KEY_ID=<key id>
LITESTREAM_SECRET_ACCESS_KEY=<secret>
AWS_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # omit for AWS S3
AWS_REGION=auto                                            # AWS: the bucket's region

# Or a directory on another disk or a NAS share, mounted into the container at /replica
LITESTREAM_URL=file:///replica/app.db
```

For a non-AWS endpoint the entrypoint adds `?endpoint=…&forcePathStyle=true` to the URL itself: Litestream reads only
the AWS SDK's `AWS_ENDPOINT_URL` and would otherwise address the bucket as a subdomain, which self-hosted stores reject.
Archigov 0.2.0 and earlier did not do this: in one-URL mode with a non-AWS endpoint, replication failed against AWS and
the container did not start. On those versions, put the endpoint in the URL yourself:
`s3://archigov-backups/prod/app.db?endpoint=https://…&forcePathStyle=true`.

*Config file*: mount [`litestream/litestream.yml`](litestream/litestream.yml) at `/etc/litestream.yml` (picked up
automatically) or point `LITESTREAM_CONFIG` at it, and set `LITESTREAM_BUCKET`, `LITESTREAM_PATH`, `AWS_ENDPOINT` and
`AWS_REGION`. Use this mode to change the sync interval, snapshot cadence or retention (the example keeps a week).

Self-hosted object storage: MinIO stopped publishing its community container images in October 2025, so the
compose example no longer offers it. Any S3-compatible store works (for example Garage or SeaweedFS), or use a
`file://` replica on a second disk or NAS share.

**What it does not cover.**

- **`/data/keys` is not replicated**, by design. It holds the evidence-signing key pair and the session secret, plus
  the generated secret key if `ARCHIGOV_SECRET_KEY` is unset. Keep it in your secret store. A restore on a new host
  without it still works, but packs are then signed by a new identity, everyone signs in again, and stored AI keys
  must be re-entered unless `ARCHIGOV_SECRET_KEY` is set.
- **One writer per replica path.** Never run two instances replicating to the same path; give each instance its own.
  That includes a restore test: restore into a scratch volume and start the copy *without* the Litestream settings.
- **It is not an archive.** History is kept for the retention period (a day by default, a week in the example). Copy nightly backups
  off the host if you need longer.

**Check it and test it.** Run the image's own Litestream with the same env file. A direct command does not go through
the entrypoint, so for a non-AWS endpoint write the endpoint into the URL as the entrypoint does:

```bash
R="s3://archigov-backups/prod/app.db?endpoint=https://<account>.r2.cloudflarestorage.com&forcePathStyle=true"
docker run --rm --env-file .env --entrypoint litestream archigov:local ltx "$R"        # replicated files, newest last
docker run --rm --env-file .env --entrypoint litestream archigov:local \
  restore -dry-run -o /tmp/check.db "$R"                                                # what a restore would fetch
docker run --rm --env-file .env -v "$PWD:/out" --entrypoint litestream archigov:local \
  restore -timestamp 2026-10-16T08:00:00Z -o /out/at-0800.db "$R"                       # a point-in-time copy
```

Test a full restore at least once, without a second writer: restore into a scratch volume, start a copy with no
Litestream settings on a loopback port, and check the audit chain.

```bash
docker volume create archigov-restore-test
docker run --rm --env-file .env -v archigov-restore-test:/data --entrypoint litestream archigov:local \
  restore -o /data/app.db "$R"
docker run -d --name archigov-restore-test -p 127.0.0.1:8099:8080 -v archigov-restore-test:/data \
  -e SEED_DEMO=false archigov:local
curl -s --retry 30 --retry-all-errors http://127.0.0.1:8099/api/audit/verify          # "ok": true, rows = yours
docker rm -f archigov-restore-test && docker volume rm archigov-restore-test
```

The documentation site has the long form: [Continuous replication](https://archigov.com/docs/guides/replication).

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
| `LITESTREAM_URL` | `s3://bucket/path/app.db` or `file:///replica/app.db` — one-URL mode (see Replication) | unset |
| `LITESTREAM_CONFIG` | path to a Litestream 0.5 YAML — config-file mode (`/etc/litestream.yml` is picked up automatically) | unset |
| `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY` | replica credentials | — |
| `AWS_ENDPOINT`, `AWS_REGION` | S3-compatible endpoint and region (`https://<account>.r2.cloudflarestorage.com` + `auto`; a self-hosted store's URL + its region). Omit the endpoint for AWS S3 | AWS defaults |
| `LITESTREAM_BUCKET`, `LITESTREAM_PATH` | only used by the example `litestream/litestream.yml` | — |

Secrets belong in an env file, the orchestrator's secret store, or `wrangler secret put` — never in compose files
or `wrangler.jsonc`.
