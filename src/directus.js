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
