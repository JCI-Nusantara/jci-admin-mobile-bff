# JCI Admin Mobile BFF

Backend-for-Frontend (Node.js/Express) serving the JCI Nusantara Admin Flutter app. Handles Auth0 session management, Directus data access, Midtrans payment processing, and admin operations.

## Tech Stack

- **Node.js + Express** — HTTP server
- **Auth0** — Authentication (JWKS verification)
- **Directus** — CMS and data layer
- **Midtrans** — Payment gateway (webhook processing)
- **Google Workspace API** — Optional membership provisioning

## Setup

```bash
npm install
cp .env.example .env
# Fill in required variables (see below)
npm run dev
```

Server runs at `http://localhost:8787`.

`npm run dev` uses Node watch mode and reloads automatically on file changes.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Port (default: `8787`) |
| `AUTH0_DOMAIN` | Yes | Auth0 tenant domain |
| `AUTH0_CLIENT_ID` | Yes | Auth0 application client ID |
| `AUTH0_AUDIENCE` | No | Auth0 API audience |
| `AUTH0_ROLES_CLAIM` | No | JWT claim key for roles |
| `DIRECTUS_URL` | Yes | Directus base URL |
| `DIRECTUS_STATIC_TOKEN` | Yes* | Static token (*or use email+password) |
| `DIRECTUS_EMAIL` | Yes* | Directus login email (*or use static token) |
| `DIRECTUS_PASSWORD` | Yes* | Directus login password |
| `DIRECTUS_MEMBERS_COLLECTION` | No | Default: `profiles` |
| `DIRECTUS_EVENTS_COLLECTION` | No | Default: `events` |
| `MIDTRANS_SERVER_KEY` | Yes | Midtrans server key |
| `MIDTRANS_IS_PRODUCTION` | No | `true` for production Midtrans |
| `MIDTRANS_NOTIFICATION_URL` | No | Override Midtrans notification URL |
| `PUBLIC_BASE_URL` | Yes | Public base URL of this BFF |
| `DIRECTUS_SYNC_WEBHOOK_SECRET` | No | Secret for Directus webhook endpoints |
| `GOOGLE_WORKSPACE_PROVISIONING_ENABLED` | No | `true` to enable Workspace provisioning |
| `GOOGLE_WORKSPACE_DOMAIN` | No | e.g. `jcinusantara.or.id` |
| `GOOGLE_WORKSPACE_ADMIN_SUBJECT` | No | Delegated admin email |
| `GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL` | No | Service account email |
| `GOOGLE_WORKSPACE_SERVICE_ACCOUNT_PRIVATE_KEY` | No | Private key (single-line `\n` escapes) |
| `GOOGLE_WORKSPACE_REQUIRED_ORDER_KEYWORD` | No | Default: `membership` |
| `GOOGLE_WORKSPACE_DEFAULT_ORG_UNIT_PATH` | No | Default: `/` |

## API Endpoints

### Public
| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/ticket-access` | Ticket QR access check |
| `POST` | `/auth/exchange` | Exchange Auth0 token for BFF session |
| `POST` | `/auth/refresh` | Refresh BFF session |
| `GET` | `/auth/session` | Get current session info |
| `GET` | `/members` | Member lookup (for referral dropdown) |
| `POST` | `/registration/couple/primary` | Couple registration — primary |
| `POST` | `/registration/couple/secondary` | Couple registration — secondary |

### Webhooks
| Method | Path | Description |
|---|---|---|
| `POST` | `/webhooks/payment/midtrans-settled` | Midtrans payment notification → projects order + attendees to Directus |
| `POST` | `/webhooks/directus/archive-past-events` | Secret-protected; archives past events in Directus |

### Admin (requires valid session + admin role)

**Members**
| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/summary` | Dashboard summary stats |
| `POST` | `/members` | Create member |
| `PATCH` | `/members/:id` | Update member |
| `GET` | `/admin/members/:id` | Member detail |
| `GET` | `/admin/members/:id/points` | Member points history |
| `GET` | `/admin/members/:id/training` | Member training records |
| `GET` | `/admin/members/:id/experiences` | Member experiences |
| `GET` | `/admin/members/:id/activity` | Member activity feed |
| `GET` | `/admin/members/:id/tags` | Member tags |
| `GET` | `/admin/members/:id/referrals` | Member referrals |
| `GET` | `/admin/members/:id/memberships` | Member membership history |

**Events**
| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/events` | List events |
| `GET` | `/admin/events/:id` | Event detail |
| `PATCH` | `/admin/events/:id` | Update event |
| `GET` | `/admin/events/:id/tickets` | List tickets |
| `POST` | `/admin/events/:id/tickets` | Create ticket |
| `PATCH` | `/admin/events/:id/tickets/:ticketId` | Update ticket |
| `DELETE` | `/admin/events/:id/tickets/:ticketId` | Delete ticket |
| `POST` | `/admin/events/:id/tickets/:ticketId/duplicate` | Duplicate ticket |
| `GET` | `/admin/events/:id/orders` | List orders |
| `GET` | `/admin/events/:id/stats` | Event stats |
| `GET` | `/admin/events/:id/attendees` | List attendees |
| `PATCH` | `/admin/events/:eventId/attendees/:attendeeId/checkin` | Check in attendee |
| `PATCH` | `/admin/events/:eventId/attendees/:attendeeId/uncheckin` | Undo check-in |
| `POST` | `/admin/events/:id/walkin` | Register walk-in attendee |
| `GET` | `/admin/events/:id/settings` | Event settings |
| `PATCH` | `/admin/events/:id/settings` | Update event settings |
| `GET` | `/admin/events/:id/features` | Event feature flags |
| `POST` | `/admin/events/:id/features/:featureId/add` | Enable feature |
| `DELETE` | `/admin/events/:id/features/:assignmentId/remove` | Disable feature |
| `GET` | `/admin/events/:id/schedule` | Event schedule |
| `POST` | `/admin/events/:id/schedule` | Add schedule item |
| `PATCH` | `/admin/events/:id/schedule/:itemId` | Update schedule item |
| `DELETE` | `/admin/events/:id/schedule/:itemId` | Delete schedule item |
| `GET` | `/admin/events/:id/lineup` | Speaker lineup |
| `PATCH` | `/admin/events/:id/lineup` | Update lineup |
| `GET` | `/admin/events/:id/video-config` | Video config |
| `PATCH` | `/admin/events/:id/video-config` | Update video config |
| `GET` | `/admin/eventcategories` | List event categories |

**Other Admin**
| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/places/autocomplete` | Google Places autocomplete |
| `GET` | `/admin/places/detail` | Google Places detail |
| `GET` | `/admin/experiences` | List pending experiences |
| `PATCH` | `/admin/experiences/:id/approve` | Approve experience |
| `PATCH` | `/admin/experiences/:id/reject` | Reject experience |
| `GET` | `/admin/businesses` | List businesses |
| `PATCH` | `/admin/businesses/:id/verify` | Verify business |
| `PATCH` | `/admin/businesses/:id/reject` | Reject business |

## Payment Flow (Midtrans)

1. Flutter app requests checkout → BFF creates Midtrans transaction
2. User completes payment in Midtrans Snap
3. Midtrans calls `POST /webhooks/payment/midtrans-settled`
4. BFF verifies signature, then projects into Directus:
   - `event_orders`
   - `event_order_items`
   - `event_attendees`
   - `event_form_answers`

## CI/CD

| Workflow | Trigger | Action |
|---|---|---|
| `bff-ci.yml` | PR / push | Build + lint |
| `bff-deploy-staging.yml` | Push to `develop` | Build GHCR image, deploy to staging VM |
| `bff-deploy-production.yml` | Push to `main` (with approval gate) | Deploy to Azure Web App |
| `bff-rollback.yml` | Manual | Rollback to specified git ref/tag |

### Required GitHub Secrets

**Both environments (`staging`, `production`):**
- `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
- `AZURE_WEBAPP_NAME_PROD`
- `BFF_PROD_HEALTH_URL`

**Staging only:**
- `STAGING_VM_HOST`, `STAGING_VM_USER`, `STAGING_VM_SSH_KEY`
- `STAGING_VM_STACK_PATH` — path to folder containing `docker-compose.yml`

Tag production releases (e.g. `bff-v1.2.0`) so `bff-rollback.yml` can target a known good ref.
