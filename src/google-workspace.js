import crypto from 'node:crypto';

const googleTokenUrl = 'https://oauth2.googleapis.com/token';
const googleDirectoryBaseUrl = 'https://admin.googleapis.com/admin/directory/v1';

const provisioningEnabled =
  String(process.env.GOOGLE_WORKSPACE_PROVISIONING_ENABLED || 'false').toLowerCase() === 'true';
const workspaceDomain = String(process.env.GOOGLE_WORKSPACE_DOMAIN || '').trim().toLowerCase();
const adminSubject = String(process.env.GOOGLE_WORKSPACE_ADMIN_SUBJECT || '').trim();
const serviceAccountEmail = String(process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL || '').trim();
const serviceAccountPrivateKeyRaw = String(process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_PRIVATE_KEY || '').trim();
const requiredOrderKeyword = String(process.env.GOOGLE_WORKSPACE_REQUIRED_ORDER_KEYWORD || 'membership')
  .trim()
  .toLowerCase();
const defaultOrgUnitPath = String(process.env.GOOGLE_WORKSPACE_DEFAULT_ORG_UNIT_PATH || '/').trim() || '/';

function toBase64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function normalizePrivateKey(privateKeyRaw) {
  return privateKeyRaw.replace(/\\n/g, '\n');
}

function slugify(input) {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '');
}

function randomTempPassword(length = 20) {
  return crypto
    .randomBytes(length)
    .toString('base64')
    .replace(/[+/=]/g, '')
    .slice(0, length);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const bodyText = await response.text();
  const body = bodyText ? JSON.parse(bodyText) : {};
  if (!response.ok) {
    const message =
      body?.error_description ||
      body?.error?.message ||
      body?.error ||
      `${response.status} ${response.statusText}`;
    const error = new Error(`Google API error: ${message}`);
    error.status = response.status;
    error.payload = body;
    throw error;
  }
  return body;
}

async function getGoogleAccessToken() {
  if (!serviceAccountEmail || !serviceAccountPrivateKeyRaw || !adminSubject) {
    throw new Error(
      'Missing Google Workspace credentials. Set GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL, GOOGLE_WORKSPACE_SERVICE_ACCOUNT_PRIVATE_KEY, and GOOGLE_WORKSPACE_ADMIN_SUBJECT.'
    );
  }

  const privateKey = normalizePrivateKey(serviceAccountPrivateKeyRaw);
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccountEmail,
    scope: 'https://www.googleapis.com/auth/admin.directory.user',
    aud: googleTokenUrl,
    exp,
    iat,
    sub: adminSubject,
  };

  const unsignedJwt = `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsignedJwt).sign(privateKey, 'base64');
  const assertion = `${unsignedJwt}.${signature.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const tokenResponse = await fetchJson(googleTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!tokenResponse?.access_token) {
    throw new Error('Google token endpoint did not return access_token');
  }

  return tokenResponse.access_token;
}

async function getUserByEmail(accessToken, email) {
  try {
    return await fetchJson(`${googleDirectoryBaseUrl}/users/${encodeURIComponent(email)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

function buildCandidateEmails({ preferredEmail, firstName, lastName }) {
  const candidates = [];
  const preferred = String(preferredEmail || '').trim().toLowerCase();
  const hasWorkspaceDomain = preferred && preferred.endsWith(`@${workspaceDomain}`);
  if (hasWorkspaceDomain) {
    candidates.push(preferred);
  }

  const fromName = slugify([firstName, lastName].filter(Boolean).join('.'));
  const localPart = fromName || slugify(preferred.split('@')[0] || '') || `member.${Date.now()}`;
  candidates.push(`${localPart}@${workspaceDomain}`);
  for (let i = 2; i <= 50; i += 1) {
    candidates.push(`${localPart}${i}@${workspaceDomain}`);
  }
  return [...new Set(candidates)];
}

function canProvisionFromOrderDetails(orderDetails) {
  if (!requiredOrderKeyword) return true;
  const keyword = requiredOrderKeyword.toLowerCase();
  const lines = Array.isArray(orderDetails?.lines) ? orderDetails.lines : [];
  return lines.some((line) => {
    const values = [line?.productName, line?.variantName, line?.sku, line?.productSlug];
    return values.some((value) => String(value || '').toLowerCase().includes(keyword));
  });
}

export function isGoogleWorkspaceProvisioningEnabled() {
  return provisioningEnabled;
}

export function canProvisionPaidOrder(orderDetails) {
  if (!provisioningEnabled) return false;
  if (!workspaceDomain) return false;
  return canProvisionFromOrderDetails(orderDetails);
}

export async function ensureWorkspaceUser({ preferredEmail, firstName, lastName, externalId }) {
  if (!provisioningEnabled) {
    return { status: 'disabled' };
  }
  if (!workspaceDomain) {
    throw new Error('GOOGLE_WORKSPACE_DOMAIN is required when provisioning is enabled');
  }

  const accessToken = await getGoogleAccessToken();
  const candidates = buildCandidateEmails({ preferredEmail, firstName, lastName });

  for (const email of candidates) {
    const existing = await getUserByEmail(accessToken, email);
    if (existing) {
      return {
        status: 'exists',
        primaryEmail: existing.primaryEmail,
        id: existing.id,
      };
    }

    const createPayload = {
      primaryEmail: email,
      name: {
        givenName: String(firstName || 'Member').trim() || 'Member',
        familyName: String(lastName || 'JCI').trim() || 'JCI',
      },
      password: randomTempPassword(24),
      changePasswordAtNextLogin: true,
      orgUnitPath: defaultOrgUnitPath,
    };

    if (externalId) {
      createPayload.externalIds = [
        {
          type: 'organization',
          customType: 'membership',
          value: String(externalId),
        },
      ];
    }

    try {
      const created = await fetchJson(`${googleDirectoryBaseUrl}/users`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(createPayload),
      });
      return {
        status: 'created',
        primaryEmail: created.primaryEmail,
        id: created.id,
      };
    } catch (error) {
      // Try next candidate if email already exists due race/alias conflict.
      if (error?.status === 409) continue;
      throw error;
    }
  }

  throw new Error('Unable to allocate unique Google Workspace email for member');
}
