import 'dotenv/config';
import cors from 'cors';
import express from 'express';

import { verifyBearerToken, requireAdmin } from './auth.js';
import { directusRequest } from './directus.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const membersCollection = process.env.DIRECTUS_MEMBERS_COLLECTION || 'members';
const isProfilesCollection = membersCollection === 'profiles';

function normalizeMember(item) {
  if (!item || typeof item !== 'object') return item;
  const name = item.name || item.fullname || item.full_name || item.first_name || item.email || null;
  return {
    ...item,
    name
  };
}

function mapMemberPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (!isProfilesCollection) return payload;

  const mapped = { ...payload };
  if (typeof mapped.name === 'string' && mapped.name.trim()) {
    mapped.fullname = mapped.name.trim();
  }
  delete mapped.name;
  return mapped;
}

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'jci-admin-mobile-bff' });
});

app.use(async (req, _res, next) => {
  if (req.path === '/health') return next();

  try {
    req.auth = await verifyBearerToken(req.headers.authorization);
    return next();
  } catch (error) {
    return next(error);
  }
});

app.get('/auth/session', (req, res) => {
  res.json({
    user: {
      sub: req.auth.sub,
      email: req.auth.email,
      name: req.auth.name,
      roles: req.auth.roles
    }
  });
});

app.get('/members', async (req, res, next) => {
  try {
    const limit = Number(req.query.limit || 50);
    const search = (req.query.search || '').toString().trim();

    const params = {
      limit
    };

    if (search) {
      params.search = search;
    }

    const { data } = await directusRequest({
      method: 'GET',
      url: `/items/${membersCollection}`,
      params
    });

    const members = Array.isArray(data?.data) ? data.data.map(normalizeMember) : [];
    res.json({ data: members });
  } catch (error) {
    next(error);
  }
});

app.post('/members', requireAdmin, async (req, res, next) => {
  try {
    const { data } = await directusRequest({
      method: 'POST',
      url: `/items/${membersCollection}`,
      data: mapMemberPayload(req.body)
    });

    res.status(201).json({ data: normalizeMember(data?.data) });
  } catch (error) {
    next(error);
  }
});

app.patch('/members/:id', requireAdmin, async (req, res, next) => {
  try {
    const { data } = await directusRequest({
      method: 'PATCH',
      url: `/items/${membersCollection}/${req.params.id}`,
      data: mapMemberPayload(req.body)
    });

    res.json({ data: normalizeMember(data?.data) });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = error.status || error.response?.status || 500;
  const message =
    error.response?.data?.errors?.[0]?.message ||
    error.response?.data?.message ||
    error.message ||
    'Unexpected server error';

  res.status(status).json({
    error: message
  });
});

app.listen(port, () => {
  console.log(`BFF listening on http://localhost:${port}`);
});
