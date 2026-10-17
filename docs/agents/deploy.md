# Prompt: Deploy or Upgrade a Self-Hosted Instance

For operators who use an AI agent to deploy archigov on their own infrastructure. The agent prepares, runs and checks. You own the credentials, the cloud resources and every decision that cannot be undone. The background is in [infra/README.md](../../infra/README.md) and the documentation site's [Self-host in production](https://archigov.com/docs/guides/self-host) and [Continuous replication](https://archigov.com/docs/guides/replication) guides.

## Rules the Agent Keeps

These go into every deployment session, whatever the prompt:

- **Secrets never land in files you track, compose files, logs or the conversation.**
  - Configuration goes in an `.env` file outside version control (`chmod 600`) or the orchestrator's secret store.
  - The agent asks you to paste a value into the file itself, rather than reading it back.
- **No cloud resources without your go-ahead.** That covers buckets, app registrations, DNS records and service principals. The agent names what it needs, and you create it or say "go".
- **Production data is never destroyed.**
  - Never `docker compose down -v`, never delete or overwrite the `/data` volume, a backup or a replica.
  - Never run an older image against a database a newer one has migrated.
  - Never run two instances against the same volume or the same replica path.
- **`AUTH_MODE=local` only on a network you fully trust.** Production uses `AUTH_MODE=entra` behind TLS.
- **The keys directory is yours to keep.** `/data/keys` (the evidence-signing key, the session secret, and the generated secret key if `ARCHIGOV_SECRET_KEY` is unset) is never replicated. The agent tells you to store it in your secret store; it does not upload it anywhere.

## First Deployment

```text
Read AGENTS.md, infra/README.md and docker-compose.prod.yml in this repository, then deploy
archigov <version tag, e.g. v0.2.1> on <host or platform> for <organisation>, at <https URL>.
Keep the rules in docs/agents/deploy.md throughout.

1. Preflight: check the container runtime (Docker with Compose v2, or say what you use instead),
   free disk for /data, the port, and outbound HTTPS to Azure (management.azure.com,
   login.microsoftonline.com), Azure DevOps and the AI provider, if used. Report gaps and stop if
   any is blocking.
2. Ask me for what only I can provide:
   - the public URL;
   - the Entra ID app registration (tenant, client, secret);
   - the Azure reader identity and subscriptions;
   - whether and where to replicate;
   - where /data/keys will be kept.
   Do not create any of them yourself unless I say so.
3. Check out the tag. Write .env next to docker-compose.prod.yml (chmod 600, not committed):
   APP_BASE_URL, SEED_DEMO=false, ARCHIGOV_SECRET_KEY (ask me to paste one from my secret store),
   AUTH_MODE=entra and the ENTRA_* values, the AZURE_* values. Uncomment env_file: .env.
4. Replication: decide with me using the "When to use it" table in infra/README.md.
   - If we replicate, configure LITESTREAM_URL (s3://… or file://…) with its credentials, plus
     AWS_ENDPOINT and AWS_REGION for a non-AWS store.
   - On v0.2.0 or earlier, put the endpoint in the URL instead: ?endpoint=…&forcePathStyle=true.
5. Build and start: docker compose -f docker-compose.prod.yml up -d --build. Wait for
   /api/health with curl --retry 30 --retry-all-errors, and check the container logs for
   "entrypoint:" lines and errors.
6. Put it behind TLS at my reverse proxy, mapping the public URL to port 8080, and confirm the
   sign-in redirect returns to that URL.
7. If replicating, prove it, following "Check it and test it" in infra/README.md:
   - list the replica with the image's litestream ltx;
   - restore into a scratch volume and start a copy WITHOUT the Litestream settings on a loopback
     port (never a second writer on the replica path), then check GET /api/audit/verify is ok;
   - remove only that copy and its scratch volume.
8. Tell me to:
   - copy /data/keys to my secret store;
   - record the evidence-signing public key shown under Settings → General;
   - check the audit chain under Audit Log → Verify Audit Chain.
9. Hand over a short report:
   - the version and host;
   - every setting except secrets;
   - replication status and how it was tested;
   - the rollback plan;
   - what I still do in the product: install the core pack, connect sources, seat the board.
```

## Upgrade

```text
Read CHANGELOG.md from the running version to <target tag>, and the upgrade notes at
https://archigov.com/docs/guides/backups-and-upgrades, then upgrade the archigov instance on
<host>. Keep the rules in docs/agents/deploy.md.

1. Report what changes between the two versions, especially migrations and configuration.
2. Take an on-demand backup (Settings → General → Data & Backups, or POST /api/backup as the
   platform admin) and ask me to confirm it is copied off the host. If Litestream is configured,
   confirm the replica is current with litestream ltx.
3. Check out the target tag, then: docker compose -f docker-compose.prod.yml up -d --build.
   Migrations run on start, each after a pre-migration snapshot.
4. Wait for /api/health, then check the version under Settings and the container logs.
5. If anything fails, stop and report. Do not run the previous image against the migrated database.
   The rollback is the pre-migration snapshot together with the previous image, and it is my
   decision.
```

## Definition of Done

- [ ] `AUTH_MODE=entra`, `APP_BASE_URL` on HTTPS, `ARCHIGOV_SECRET_KEY` from the secret store
- [ ] Secrets only in `.env` (`chmod 600`, untracked) or the orchestrator's secret store
- [ ] `/data` on a persistent volume. Replication configured and a restore proven, or a recorded decision that nightly backups copied off-host are enough
- [ ] `/data/keys` copied to the secret store; the evidence-signing public key recorded
- [ ] Health check wired to monitoring; the audit chain verified once
- [ ] A handover report with no secrets in it
