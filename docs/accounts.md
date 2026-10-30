# Subscription accounts

Open **Add a Claude subscription account** on the home page. Give it a label, then sign in on its card.
The home keeps the existing Claude login and supports up to eight additional accounts.

Each added account uses its own native Claude config directory. Vendor credentials stay there.
The runner stores labels, priorities and Auto enablement separately; it never imports or duplicates tokens.

## Routing

| Choice | Behavior |
| --- | --- |
| Auto, new task | Select an enabled, signed-in account without an observed active quota limit. |
| Explicit account | Use the selected account, including accounts excluded from Auto. |
| Existing chat | Keep its native session and account. |
| No eligible subscription | Keep existing paid API consent rules; no automatic billing opt-in. |

Quota selection uses code and does not call a decision model.
Limits come from native ACP reports. Missing quota readings remain unknown; sign-in checks do not generate a model turn.
Account priority orders new automatic work, with lower numbers first.

**This does not migrate an active turn to another account.**
A native CLI can keep waiting after a quota limit. Its workspace stays occupied until that work settles or is stopped.
Checkpoint-based continuation across accounts is separate work.

## Owner API

All endpoints require the home's existing owner authentication.

| Request | Body / result |
| --- | --- |
| `GET /accounts` | Default and added Claude accounts: ID, CLI alias, label, enabled state and priority. |
| `POST /accounts` | `{ "harness":"claude", "label":"Work" }`; returns the new account and CLI alias. |
| `PATCH /accounts/:id` | Update `label`, `enabled` or `priority`. |

For example, exclude an account from new Auto tasks:

```json
{ "enabled": false }
```

This preserves its login and existing chats. There is no credential-deletion API.
Sign-in uses the existing `/connect/<cli-alias>` endpoints and the vendor's own flow.
Reauthentication is rejected while the account has active native work.

Account directories also receive the shared skill and MCP setup for Claude.
Inherited API credentials, custom Anthropic endpoints and model overrides are removed from added subscription accounts.
Trusted network proxy and certificate settings remain available.

Codex remains on its existing single-account path. This feature does not copy `auth.json` or add another Codex app-server.
