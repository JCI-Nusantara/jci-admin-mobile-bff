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

## CI/CD (Azure OIDC, No Slots)

Workflows:

- `.github/workflows/bff-ci.yml`
- `.github/workflows/bff-deploy-staging.yml` (deploy nonprod)
- `.github/workflows/bff-deploy-production.yml` (deploy prod)
- `.github/workflows/bff-rollback.yml` (manual rollback by git ref)

### GitHub Environment secrets

Set these in both `staging` and `production` environments (as needed):

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_WEBAPP_NAME_NONPROD` (example: `jci-mobile-admin-bff-nonprod`)
- `AZURE_WEBAPP_NAME_PROD` (your production app name)
- `BFF_NONPROD_HEALTH_URL` (example: `https://jci-mobile-admin-bff-nonprod.azurewebsites.net/health`)
- `BFF_PROD_HEALTH_URL` (example: `https://<prod-app>.azurewebsites.net/health`)

### Release flow (no-slot)

1. Push to `develop` -> deploy to nonprod app + smoke test.
2. Manually run `BFF Deploy Production` with selected git ref.
3. If prod breaks, run `BFF Rollback (No Slot)` and provide previous stable tag/commit SHA.

### Rollback recommendation

Create git tags for production releases (for example `bff-v0.1.0`, `bff-v0.1.1`) so rollback is a one-click redeploy using a known good tag.
