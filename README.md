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
   - `SALEOR_CHANNEL_ID`
   - `SALEOR_PAYMENT_GATEWAY_ID` (default: `app.saleor.payment.gateway`)
   - `PUBLIC_BASE_URL` (example: `https://jci-mobile-admin-bff-nonprod.azurewebsites.net`)
   - `CHECKOUT_CLIENT_SECRET` (required for Nuxt server -> BFF checkout/payment calls)
   - `DIRECTUS_SUBSCRIPTION_COLLECTION` (default: `subscription`)
   - `GOOGLE_WORKSPACE_PROVISIONING_ENABLED` (`true` to enable post-payment provisioning)
   - `GOOGLE_WORKSPACE_DOMAIN` (example: `jcinusantara.or.id`)
   - `GOOGLE_WORKSPACE_ADMIN_SUBJECT` (delegated admin email, example: `it-admin@jcinusantara.or.id`)
   - `GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL`
   - `GOOGLE_WORKSPACE_SERVICE_ACCOUNT_PRIVATE_KEY` (single-line with `\n` escapes)
   - `GOOGLE_WORKSPACE_REQUIRED_ORDER_KEYWORD` (default: `membership`)
   - `GOOGLE_WORKSPACE_DEFAULT_ORG_UNIT_PATH` (default: `/`)
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
- `POST /event-checkout/create` (server-to-server; create Saleor checkout + initialize Saleor payment app transaction)
- `POST /event-checkout/process-payment` (server-to-server; process Saleor transaction and complete checkout)
- `POST /dev/sync/event-tickets` (admin only; run Directus `event_tickets` -> Saleor sync)
- `POST /webhooks/directus/event-tickets-sync` (secret-protected; for Directus Flow automation)

### Event checkout flow

The current event flow is:

1. Browser -> Nuxt
2. Nuxt server -> BFF with `x-checkout-secret`
3. BFF -> Saleor checkout + transaction initialization
4. Saleor payment app -> Midtrans
5. Saleor paid order -> BFF/worker -> Directus projection

`POST /event-checkout/create` stores the registration payload in Directus `event_checkout_sessions`, creates the Saleor checkout, and initializes the Saleor payment transaction.

`POST /event-checkout/process-payment` processes the Saleor transaction, completes the checkout, and projects:

- `event_orders`
- `event_order_items`
- `event_attendees`
- `event_form_answers`

### Google Workspace auto-provisioning

When `GOOGLE_WORKSPACE_PROVISIONING_ENABLED=true`, paid membership processing can create/find Google Workspace users and append provisioning status into `subscription.payment_remarks`.

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
