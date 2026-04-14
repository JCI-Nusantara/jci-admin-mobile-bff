import axios from 'axios';

const baseURL = process.env.DIRECTUS_URL;
const staticToken = process.env.DIRECTUS_STATIC_TOKEN;
const email = process.env.DIRECTUS_EMAIL;
const password = process.env.DIRECTUS_PASSWORD;

if (!baseURL) {
  throw new Error('DIRECTUS_URL is required');
}

const directus = axios.create({
  baseURL,
  headers: {
    'Content-Type': 'application/json'
  }
});

let cachedAccessToken = null;
let cachedAt = 0;

async function getAccessToken() {
  if (staticToken) {
    return staticToken;
  }

  if (cachedAccessToken && Date.now() - cachedAt < 45 * 60 * 1000) {
    return cachedAccessToken;
  }

  if (!email || !password) {
    throw new Error('Set DIRECTUS_STATIC_TOKEN or DIRECTUS_EMAIL/DIRECTUS_PASSWORD');
  }

  const { data } = await directus.post('/auth/login', {
    email,
    password
  });

  cachedAccessToken = data?.data?.access_token;
  cachedAt = Date.now();
  return cachedAccessToken;
}

export async function directusRequest(config) {
  const token = await getAccessToken();

  return directus.request({
    ...config,
    headers: {
      ...(config.headers || {}),
      Authorization: `Bearer ${token}`
    }
  });
}

// Admin-level request using email/password login (has access to system collections)
let adminToken = null;
let adminTokenAt = 0;

async function getAdminToken() {
  if (adminToken && Date.now() - adminTokenAt < 14 * 60 * 1000) {
    return adminToken;
  }
  if (!email || !password) {
    throw new Error('DIRECTUS_EMAIL and DIRECTUS_PASSWORD are required for admin operations');
  }
  const { data } = await directus.post('/auth/login', { email, password });
  adminToken = data?.data?.access_token;
  adminTokenAt = Date.now();
  return adminToken;
}

export async function directusAdminRequest(config) {
  const token = await getAdminToken();
  return directus.request({
    ...config,
    headers: {
      ...(config.headers || {}),
      Authorization: `Bearer ${token}`
    }
  });
}

export async function directusRequestAs(config, userToken) {
  return directus.request({
    ...config,
    headers: {
      ...(config.headers || {}),
      Authorization: `Bearer ${userToken}`
    }
  });
}
