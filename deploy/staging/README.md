# Staging Stack (VM + Docker Compose)

This folder runs the staging backend stack:

- Directus
- Saleor API
- Saleor worker
- Saleor dashboard
- Admin BFF
- Redis (local container for Saleor)

## 1) Prepare env

```bash
cp .env.example .env
# edit .env
```

Set Supabase connection strings for:

- `DIRECTUS_DB_CONNECTION_STRING`
- `SALEOR_DB_CONNECTION_STRING`

Set `BFF_IMAGE` to GHCR staging tag:

```env
BFF_IMAGE=ghcr.io/<org-or-user>/jci-admin-mobile-bff:staging
```

## 2) Start stack

```bash
docker compose up -d
```

## 3) Update only BFF after CI build

```bash
docker compose pull admin-bff
docker compose up -d admin-bff
```

## 4) Health checks

- BFF: `http://<vm-host>:8787/health`
- Directus: `http://<vm-host>:8055/server/health`
- Saleor GraphQL: `http://<vm-host>:8000/graphql/`

## GitHub staging secrets for auto-deploy

In repository environment `staging`:

- `STAGING_VM_HOST`
- `STAGING_VM_USER`
- `STAGING_VM_SSH_KEY`
- `STAGING_VM_STACK_PATH` (absolute path containing this Compose file)
