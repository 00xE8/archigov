# Prompts for AI coding agents

Ready-made prompts for the contributions that help Archigov most. Each is scoped so the agent stays in the right folder, checks its own work and stops before the acts that are yours: the DCO sign-off and, for core changes, the CLA agreement. The rules behind them are in [AGENTS.md](../../AGENTS.md).

| Prompt | Lands in | You need |
|---|---|---|
| [A policy pack](new-policy-pack.md) | `server/src/packs/` | A DCO sign-off |
| [An assessment template](new-assessment-template.md) | `server/src/templates/` | A DCO sign-off |
| [A connector or an importer](new-connector.md) | a new or existing Apache-2.0 folder | A DCO sign-off (open an issue first for a new folder) |
| [A fix or a feature in the core](core-change.md) | anywhere else | A DCO sign-off and the CLA, once |

Not contributing but running Archigov? [Deploy or upgrade a self-hosted instance](deploy.md) holds the prompts and the safety rules for an agent working on your infrastructure, around production data, secrets and cloud resources.

How to use one:

1. Copy the prompt block into your agent.
2. Fill in the `<…>` parts.
3. Let it work.
4. Review the diff yourself.
5. Sign off (`git rebase --signoff origin/main`) and open the pull request.

If it is a core change and the **Archigov CLA** check asks, agree to the CLA yourself, by comment.
