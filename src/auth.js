import axios from 'axios';
import { createRemoteJWKSet, jwtVerify } from 'jose';

// ─── Auth0 JWT verification (for /auth/exchange only) ────────────────────────

const auth0Domain = process.env.AUTH0_DOMAIN;
const auth0ClientId = process.env.AUTH0_CLIENT_ID;
const auth0Audience = process.env.AUTH0_AUDIENCE;

let jwks = null;
let issuer = null;
let audiences = [];

if (auth0Domain && auth0ClientId) {
  issuer = `https://${auth0Domain}/`;
  jwks = createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));
  audiences = [auth0Audience, auth0ClientId].filter(Boolean);
}

export async function verifyAuth0Token(token) {
  if (!jwks) throw Object.assign(new Error('Auth0 not configured'), { status: 503 });

  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: audiences });
    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
    };
  } catch (_error) {
    throw Object.assign(new Error('Invalid Auth0 token'), { status: 401 });
  }
}

// ─── Directus token verification (for all other endpoints) ───────────────────

const directusUrl = process.env.DIRECTUS_URL;

// Cache validated users briefly
const userCache = new Map();
const CACHE_TTL = 60_000;

export async function verifyDirectusToken(authHeader = '') {
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    throw Object.assign(new Error('Missing bearer token'), { status: 401 });
  }

  const cached = userCache.get(token);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.auth;
  }

  let userData;
  try {
    const { data } = await axios.get(`${directusUrl}/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { fields: 'id,first_name,last_name,email,role.name' },
    });
    userData = data?.data;
  } catch (_error) {
    throw Object.assign(new Error('Invalid or expired Directus token'), { status: 401 });
  }

  if (!userData) {
    throw Object.assign(new Error('Unable to resolve user'), { status: 401 });
  }

  const roleName = (userData.role?.name || '').trim();

  const auth = {
    sub: userData.id,
    email: userData.email,
    name: [userData.first_name, userData.last_name].filter(Boolean).join(' '),
    roles: [roleName.toLowerCase()].filter(Boolean),
    directusToken: token,
    directusRoleName: roleName,
  };

  userCache.set(token, { auth, ts: Date.now() });

  if (userCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of userCache) {
      if (now - v.ts > CACHE_TTL) userCache.delete(k);
    }
  }

  return auth;
}

// ─── Admin role check ────────────────────────────────────────────────────────

const ADMIN_ROLES = new Set([
  'administrator',
  'officer',
  'admin',
  'super_admin',
]);

export function requireAdmin(req, _res, next) {
  const roleName = (req.auth?.directusRoleName || '').toLowerCase();
  if (!ADMIN_ROLES.has(roleName)) {
    const err = new Error(`Admin role required (current: ${req.auth?.directusRoleName || 'none'})`);
    err.status = 403;
    return next(err);
  }
  return next();
}
