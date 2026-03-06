# JCI Admin Mobile BFF

Backend-for-frontend for the Flutter app.

## Setup

1. Install deps:
   - `npm install`
2. Create env file:
   - `cp .env.example .env`
3. Fill `.env`:
   - `AUTH0_DOMAIN`
   - `AUTH0_CLIENT_ID`
   - `DIRECTUS_URL`
   - `DIRECTUS_STATIC_TOKEN` OR `DIRECTUS_EMAIL` + `DIRECTUS_PASSWORD`
   - `DIRECTUS_MEMBERS_COLLECTION` (default: `profiles`)
   - `SALEOR_API_URL`
   - `SALEOR_API_TOKEN`
   - `SALEOR_CHANNEL_ID` (optional, used when creating draft orders)
   - `MIDTRANS_SERVER_KEY`
   - `MIDTRANS_IS_PRODUCTION` (`false` for sandbox, `true` for production)
   - `PUBLIC_BASE_URL` (example: `https://jci-mobile-admin-bff-nonprod.azurewebsites.net`)
   - `MIDTRANS_NOTIFICATION_URL` (optional override; if empty, uses `${PUBLIC_BASE_URL}/webhooks/midtrans`)
   - `DEV_AUTH_BYPASS_SNAP` (`true` only for local dev; bypasses JWT for Snap create endpoint)
4. Run:
   - `npm run dev`

Server URL: `http://localhost:8787`

## Dev Behavior

`npm run dev` uses Node watch mode (`node --watch`) and reloads automatically after file changes.

## Endpoints

- `GET /health`
- `GET /auth/session`
- `GET /members`
- `POST /members` (admin role)
- `PATCH /members/:id` (admin role)
- `POST /payments/midtrans/snap/transaction` (auth required; create Snap transaction for a Saleor order)
- `POST /webhooks/midtrans` (public webhook; verifies Midtrans signature, then updates Saleor order payment state)
- `GET /payments/midtrans/notification-url` (returns the URL to configure in Midtrans dashboard)
- `GET /dev/snap-tester` (dev-only test page, enabled when `DEV_AUTH_BYPASS_SNAP=true`)
- `POST /dev/sync/event-tickets` (admin only; run Directus `event_tickets` -> Saleor sync)
- `POST /webhooks/directus/event-tickets-sync` (secret-protected; for Directus Flow automation)

### Snap transaction request example

`POST /payments/midtrans/snap/transaction`

```json
{
  "orderCode": "S3A7Q8F4",
  "enabledPayments": ["credit_card", "bca_va", "gopay"]
}
```

Response includes `token` and `redirectUrl` to continue checkout in mobile/web.
Current default: BFF does not apply any fee imposition in request payload and always uses the order amount as gross amount.

### Local dev bypass

If member app/website is not ready yet, set:

```env
DEV_AUTH_BYPASS_SNAP=true
```

This bypass applies only to:

- `POST /payments/midtrans/snap/transaction`
- `GET /dev/snap-tester`

Use for local testing only. Set back to `false` before staging/production.

## CI/CD (Staging VM + Azure Production)

Workflows:

- `.github/workflows/bff-ci.yml`
- `.github/workflows/bff-deploy-staging.yml` (build/push GHCR image + optional staging VM deploy)
- `.github/workflows/bff-deploy-production.yml` (deploy prod)
- `.github/workflows/bff-rollback.yml` (manual rollback by git ref)

### GitHub Environment secrets

Set these in both `staging` and `production` environments (as needed):

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_WEBAPP_NAME_PROD` (your production app name)
- `BFF_PROD_HEALTH_URL` (example: `https://<prod-app>.azurewebsites.net/health`)

Staging VM deploy secrets (environment `staging`):

- `STAGING_VM_HOST`
- `STAGING_VM_USER`
- `STAGING_VM_SSH_KEY`
- `STAGING_VM_STACK_PATH` (absolute path to the folder containing `docker-compose.yml`)

### Release flow (no-slot)

1. Push to `develop` -> build and push `ghcr.io/<owner>/jci-admin-mobile-bff:staging`.
2. If staging VM secrets exist, the same workflow updates `admin-bff` in your Compose stack.
3. Push to `main` to deploy production (with GitHub Environment approval gate), or manually run `BFF Deploy Production` with a selected git ref.
4. If prod breaks, run `BFF Rollback (No Slot)` and provide previous stable tag/commit SHA.

### Rollback recommendation

Create git tags for production releases (for example `bff-v0.1.0`, `bff-v0.1.1`) so rollback is a one-click redeploy using a known good tag.

## Directus -> Saleor Event Ticket Sync

CLI:

- `npm run sync:event-tickets:saleor:dry`
- `npm run sync:event-tickets:saleor`

Webhook automation:

- Set `DIRECTUS_SYNC_WEBHOOK_SECRET`.
- Trigger endpoint: `POST /webhooks/directus/event-tickets-sync`
- Header: `x-sync-secret: <DIRECTUS_SYNC_WEBHOOK_SECRET>`
- Body example: `{ "dryRun": false }`

Run logs:

- By default, sync writes run status to Directus collection `vendure_sync_logs`.
- Configure with:
  - `DIRECTUS_SYNC_LOG_ENABLED=true|false`
  - `DIRECTUS_SYNC_LOG_COLLECTION=<collection_name>`
