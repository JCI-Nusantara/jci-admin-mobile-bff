import { createRemoteJWKSet, jwtVerify } from 'jose';

const domain = process.env.AUTH0_DOMAIN;
const clientId = process.env.AUTH0_CLIENT_ID;
const audience = process.env.AUTH0_AUDIENCE;
const rolesClaimKey = process.env.AUTH0_ROLES_CLAIM || 'https://jci.app/roles';

if (!domain || !clientId) {
  throw new Error('AUTH0_DOMAIN and AUTH0_CLIENT_ID are required');
}

const issuer = `https://${domain}/`;
const jwks = createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));
const audiences = [audience, clientId].filter(Boolean);

export async function verifyBearerToken(authHeader = '') {
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    const err = new Error('Missing bearer token');
    err.status = 401;
    throw err;
  }

  let payload;
  try {
    const verified = await jwtVerify(token, jwks, {
      issuer,
      audience: audiences
    });
    payload = verified.payload;
  } catch (_error) {
    const err = new Error('Invalid bearer token');
    err.status = 401;
    throw err;
  }

  const rolesRaw = payload[rolesClaimKey];
  const roles = Array.isArray(rolesRaw) ? rolesRaw.map((v) => String(v).toLowerCase()) : [];

  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
    roles,
    payload
  };
}

export function requireAdmin(req, _res, next) {
  if (!req.auth?.roles?.includes('admin')) {
    const err = new Error('Admin role required');
    err.status = 403;
    return next(err);
  }

  return next();
}
