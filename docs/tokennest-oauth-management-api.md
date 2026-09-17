# TokenNest OAuth management API handoff

TokenBird already uses the public native client `tnc_craft_agents_community`
with authorization-code + PKCE. Access and refresh tokens remain in the
TokenBird server-side credential store. The following TokenNest additions are
needed to make the in-app usage page authoritative instead of linking to the
website for details.

## 1. Channel groups

Add `GET /api/oauth2/groups`, protected by OAuth bearer authentication and a
new `groups:read` scope. Return only groups usable by the grant owner.

```json
{
  "data": {
    "default": { "desc": "Default", "ratio": 1, "models": ["gpt-5.6-sol"] },
    "auto": { "desc": "Automatic", "ratio": "auto", "models": ["gpt-5.6-sol", "gpt-6-astra"] }
  }
}
```

For `/v1/*` model requests, accept `X-TokenNest-Group`. Resolve it with the
same authorization and deprecation checks used when assigning a group to an
API token. An absent header keeps the user's normal default group. An invalid
or unauthorized group must return a bounded `403` OpenAI-style error and must
never silently route through a different paid group.

TokenBird already persists the selected group on the OAuth connection and
sends this header. A 404 from the groups endpoint is treated as an older server
and hides the selector.

## 2. Usage and request records

Add read-only OAuth endpoints with a `usage:read` scope:

- `GET /api/oauth2/usage/summary?start_timestamp=&end_timestamp=`
- `GET /api/oauth2/usage/records?page=&page_size=&start_timestamp=&end_timestamp=&model=&group=`

The summary should include quota/cost in explicit units, input/output/total
tokens, request count, and the requested time range. Records should use the
normal paginated envelope and expose timestamp, model, group, token counts,
charged quota/cost, request status, and a safe request identifier. Do not
return prompts, response bodies, upstream credentials, channel secrets, or
internal-only channel details.

## 3. Balance and invoices

`GET /api/oauth2/balance` already exists under `balance:read` and is consumed
by TokenBird.

Add read-only invoice access under `invoice:read`:

- `GET /api/oauth2/invoices/summary` for invoiceable amount, currency, bound
  email state, and required profile state.
- `GET /api/oauth2/invoices?page=&page_size=` for the current user's requests.

Creating an invoice, changing invoice identity fields, resending mail, or
downloading a PDF should remain an explicit website flow unless separately
designed with step-up authentication and CSRF-safe browser interaction.

## 4. OAuth and API-key separation

OAuth authorization must create an OAuth grant only. It must not create an API
token/key, reveal a generated key, or show a "create key" action as part of the
consent/account grant row. The account UI should label it as an authorized app
with scopes, last use, expiry, and revoke action. Existing API keys remain in
the separate keys area.

Update the registered client's allowed scopes to include `groups:read`,
`usage:read`, and `invoice:read`. Deploy those endpoints and allowed scopes
before updating TokenBird's requested scope string, otherwise new sign-ins can
fail with `invalid_scope`. Existing grants need re-authorization for the new
read scopes; refresh must not silently escalate them.

All endpoints must use the OAuth subject as the user identity, enforce user and
client disablement/revocation/auth-version checks, disable caching, and avoid
logging bearer tokens.
