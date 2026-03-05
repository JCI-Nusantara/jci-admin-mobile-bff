import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import crypto from 'node:crypto';

import { verifyBearerToken, requireAdmin } from './auth.js';
import { directusRequest } from './directus.js';
import { createSnapTransaction } from './midtrans.js';
import {
  addItemToDraftOrder,
  cancelOrder,
  createDraftOrder,
  getVariantBySku,
  getOrderByCode,
  markOrderAsPaid,
} from './saleor.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const membersCollection = process.env.DIRECTUS_MEMBERS_COLLECTION || 'members';
const isProfilesCollection = membersCollection === 'profiles';
const midtransServerKey = process.env.MIDTRANS_SERVER_KEY || '';
const devAuthBypassSnap = String(process.env.DEV_AUTH_BYPASS_SNAP || 'false').toLowerCase() === 'true';
const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const configuredMidtransNotificationUrl = String(process.env.MIDTRANS_NOTIFICATION_URL || '').trim();

function getMidtransNotificationUrl() {
  if (configuredMidtransNotificationUrl) return configuredMidtransNotificationUrl;
  if (publicBaseUrl) return `${publicBaseUrl}/webhooks/midtrans`;
  return '';
}

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

function computeMidtransSignature(orderId, statusCode, grossAmount) {
  const value = `${orderId}${statusCode}${grossAmount}${midtransServerKey}`;
  return crypto.createHash('sha512').update(value).digest('hex');
}

function timingSafeHexEqual(left, right) {
  if (!left || !right) return false;
  const leftBuf = Buffer.from(String(left), 'hex');
  const rightBuf = Buffer.from(String(right), 'hex');
  if (leftBuf.length !== rightBuf.length || leftBuf.length === 0) return false;
  return crypto.timingSafeEqual(leftBuf, rightBuf);
}

function isCardPayment(payload) {
  return String(payload?.payment_type || '').toLowerCase() === 'credit_card';
}

function isPaidNotification(payload) {
  const status = String(payload?.transaction_status || '').toLowerCase();

  // Midtrans semantics used by JCI:
  // - Card: capture
  // - VA/e-wallet/others: settlement
  if (isCardPayment(payload)) {
    return status === 'capture';
  }

  return status === 'settlement';
}

function isFailedNotification(payload) {
  const status = String(payload?.transaction_status || '').toLowerCase();
  return ['deny', 'cancel', 'expire', 'failure'].includes(status);
}

function toMidtransAmountFromSaleor(totalAmount, currencyCode) {
  const raw = Number(totalAmount || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const currency = String(currencyCode || '').toUpperCase();

  // Saleor money amounts are major units.
  // Midtrans expects IDR in whole rupiah.
  if (currency === 'IDR') return Math.round(raw);
  return Math.round(raw);
}

function isDevSnapBypassRequest(req) {
  if (!devAuthBypassSnap) return false;
  return (
    req.path === '/payments/midtrans/snap/transaction' ||
    req.path === '/dev/snap-tester' ||
    req.path.startsWith('/dev/orders/')
  );
}

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'jci-admin-mobile-bff' });
});

app.get('/payments/midtrans/notification-url', (_req, res) => {
  const notificationUrl = getMidtransNotificationUrl();
  if (!notificationUrl) {
    return res.status(500).json({
      error: 'Midtrans notification URL is not configured',
      hint: 'Set MIDTRANS_NOTIFICATION_URL or PUBLIC_BASE_URL in env'
    });
  }

  return res.status(200).json({
    success: true,
    notificationUrl
  });
});

app.use(async (req, _res, next) => {
  const rawUrl = String(req.originalUrl || req.url || '');
  const isWebhookRequest =
    req.path.startsWith('/webhooks') ||
    rawUrl.includes('/webhooks/midtrans') ||
    rawUrl.includes('webhooks/midtrans');

  if (req.path === '/health' || isWebhookRequest || isDevSnapBypassRequest(req)) {
    return next();
  }

  try {
    req.auth = await verifyBearerToken(req.headers.authorization);
    return next();
  } catch (error) {
    return next(error);
  }
});

app.get('/dev/snap-tester', (_req, res) => {
  if (!devAuthBypassSnap) {
    return res.status(404).json({ error: 'Not found' });
  }

  return res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>JCI Snap Tester</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; max-width: 780px; }
    label { display: block; margin: 14px 0 6px; font-weight: 600; }
    input, textarea { width: 100%; padding: 10px; font-size: 14px; }
    button { margin-top: 16px; padding: 10px 16px; cursor: pointer; }
    pre { margin-top: 16px; background: #111; color: #eee; padding: 12px; overflow: auto; }
  </style>
</head>
<body>
  <h2>JCI Midtrans Snap Tester</h2>
  <p>Dev mode only. Uses BFF endpoint without JWT.</p>
  <label>Order Code</label>
  <input id="orderCode" placeholder="e.g. S3A7Q8F4" />
  <label>Fee Amount (IDR)</label>
  <input id="feeAmount" value="3000" />
  <label>Fee Label</label>
  <input id="feeLabel" value="Payment Fee" />
  <label>Enabled Payments (comma-separated)</label>
  <input id="enabledPayments" value="credit_card,bca_va,gopay" />
  <button id="runBtn">Create Snap Transaction</button>
  <pre id="result"></pre>
  <script>
    const resultEl = document.getElementById('result');
    document.getElementById('runBtn').addEventListener('click', async () => {
      resultEl.textContent = 'Loading...';
      try {
        const orderCode = document.getElementById('orderCode').value.trim();
        const feeAmount = Number(document.getElementById('feeAmount').value || 0);
        const feeLabel = document.getElementById('feeLabel').value.trim() || 'Payment Fee';
        const enabledPayments = document.getElementById('enabledPayments').value
          .split(',')
          .map(v => v.trim())
          .filter(Boolean);

        const resp = await fetch('/payments/midtrans/snap/transaction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderCode, feeAmount, feeLabel, enabledPayments }),
        });
        const data = await resp.json();
        resultEl.textContent = JSON.stringify(data, null, 2);
        if (data && data.redirectUrl) {
          window.open(data.redirectUrl, '_blank', 'noopener,noreferrer');
        }
      } catch (err) {
        resultEl.textContent = String(err);
      }
    });
  </script>
</body>
</html>`);
});

app.post('/dev/orders/:orderCode/add-by-sku', async (req, res, next) => {
  try {
    if (!devAuthBypassSnap) {
      return res.status(404).json({ error: 'Not found' });
    }

    const orderCode = String(req.params.orderCode || '').trim();
    const sku = String(req.body?.sku || '').trim();
    const quantity = Math.max(1, Math.round(Number(req.body?.quantity || 1)));

    if (!orderCode || !sku) {
      return res.status(400).json({ error: 'orderCode and sku are required' });
    }

    const order = await getOrderByCode(orderCode);
    if (!order) {
      return res.status(404).json({ error: `Order not found for code ${orderCode}` });
    }

    const variant = await getVariantBySku(sku);
    if (!variant) {
      return res.status(404).json({ error: `Variant not found for sku ${sku}` });
    }

    const result = await addItemToDraftOrder(order.id, variant.id, quantity);
    if (Array.isArray(result?.errors) && result.errors.length > 0) {
      return res.status(409).json({
        error: result.errors[0]?.message || 'Unable to add line',
        code: result.errors[0]?.code || 'ADD_LINE_FAILED'
      });
    }

    return res.status(200).json({
      success: true,
      orderCode,
      sku,
      quantity,
      order: result?.order || null
    });
  } catch (error) {
    next(error);
  }
});

app.post('/dev/orders/create-with-sku', async (req, res, next) => {
  try {
    if (!devAuthBypassSnap) {
      return res.status(404).json({ error: 'Not found' });
    }

    const sku = String(req.body?.sku || '').trim();
    const quantity = Math.max(1, Math.round(Number(req.body?.quantity || 1)));
    if (!sku) {
      return res.status(400).json({ error: 'sku is required' });
    }

    const variant = await getVariantBySku(sku);
    if (!variant) {
      return res.status(404).json({ error: `Variant not found for sku ${sku}` });
    }

    const draft = await createDraftOrder();
    if (Array.isArray(draft?.errors) && draft.errors.length > 0) {
      return res.status(409).json({
        error: draft.errors[0]?.message || 'Unable to create draft order',
        code: draft.errors[0]?.code || 'CREATE_DRAFT_ORDER_FAILED'
      });
    }

    if (!draft?.order?.id || !draft?.order?.number) {
      return res.status(500).json({ error: 'Unable to create draft order' });
    }

    const result = await addItemToDraftOrder(draft.order.id, variant.id, quantity);
    if (Array.isArray(result?.errors) && result.errors.length > 0) {
      return res.status(409).json({
        error: result.errors[0]?.message || 'Unable to add line',
        code: result.errors[0]?.code || 'ADD_LINE_FAILED'
      });
    }

    return res.status(200).json({
      success: true,
      orderCode: draft.order.number,
      sku,
      quantity,
      order: result?.order || null
    });
  } catch (error) {
    next(error);
  }
});

app.post('/payments/midtrans/snap/transaction', async (req, res, next) => {
  try {
    const orderCode = String(req.body?.orderCode || '').trim();
    const feeAmount = 0;
    const feeLabel = 'Payment Fee';
    const enabledPayments = Array.isArray(req.body?.enabledPayments) ? req.body.enabledPayments : undefined;
    const customExpiry = req.body?.customExpiry && typeof req.body.customExpiry === 'object' ? req.body.customExpiry : undefined;
    const customer = req.body?.customer && typeof req.body.customer === 'object' ? req.body.customer : undefined;

    if (!orderCode) {
      return res.status(400).json({ error: 'orderCode is required' });
    }

    const order = await getOrderByCode(orderCode);
    if (!order) {
      return res.status(404).json({ error: `Order not found for code ${orderCode}` });
    }

    const refreshedOrder = await getOrderByCode(orderCode);
    const baseAmount = toMidtransAmountFromSaleor(
      refreshedOrder?.totalWithTax,
      refreshedOrder?.currencyCode
    );
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
      return res.status(409).json({ error: 'Order total is invalid for payment' });
    }

    const snap = await createSnapTransaction({
      orderId: orderCode,
      baseAmount,
      feeAmount,
      feeLabel,
      customer,
      enabledPayments,
      customExpiry
    });

    return res.status(200).json({
      success: true,
      orderCode,
      currencyCode: refreshedOrder?.currencyCode || null,
      baseAmount,
      feeAmount: 0,
      grossAmount: baseAmount,
      notificationUrl: getMidtransNotificationUrl() || null,
      token: snap?.token || null,
      redirectUrl: snap?.redirect_url || null
    });
  } catch (error) {
    next(error);
  }
});

app.post('/webhooks/midtrans', async (req, res, next) => {
  try {
    const payload = req.body || {};

    // Midtrans dashboard "Test notification URL" can send minimal/empty payload.
    // Respond with 200 so connectivity tests pass without mutating any order state.
    if (!payload || typeof payload !== 'object' || Object.keys(payload).length === 0) {
      return res.status(200).json({
        success: true,
        ignored: true,
        reason: 'empty_test_payload'
      });
    }

    if (!midtransServerKey) {
      return res.status(500).json({ error: 'MIDTRANS_SERVER_KEY is not configured' });
    }

    const orderCode = String(payload.order_id || '').trim();
    const statusCode = String(payload.status_code || '').trim();
    const grossAmount = String(payload.gross_amount || '').trim();
    const signatureKey = String(payload.signature_key || '').trim();

    if (!orderCode || !statusCode || !grossAmount || !signatureKey) {
      return res.status(200).json({
        success: true,
        ignored: true,
        reason: 'incomplete_payload',
        required: ['order_id', 'status_code', 'gross_amount', 'signature_key']
      });
    }

    const expectedSignature = computeMidtransSignature(orderCode, statusCode, grossAmount);
    if (!timingSafeHexEqual(signatureKey, expectedSignature)) {
      return res.status(401).json({ error: 'Invalid Midtrans signature' });
    }

    const order = await getOrderByCode(orderCode);
    if (!order) {
      return res.status(404).json({ error: `Order not found for code ${orderCode}` });
    }

    if (isPaidNotification(payload)) {
      const transactionId = String(payload.transaction_id || payload.settlement_time || payload.order_id);
      if (!order?.isPaid) {
        const paidResult = await markOrderAsPaid({
          orderId: order.id,
          transactionReference: transactionId
        });

        if (Array.isArray(paidResult?.errors) && paidResult.errors.length > 0) {
          return res.status(409).json({
            error: paidResult.errors[0]?.message || 'Unable to mark order as paid',
            code: paidResult.errors[0]?.code || 'ORDER_MARK_PAID_FAILED'
          });
        }
      }

      return res.status(200).json({
        success: true,
        order_code: orderCode,
        action: 'marked_paid'
      });
    }

    if (isFailedNotification(payload)) {
      if (!order?.isPaid && String(order?.state || '').toUpperCase() !== 'CANCELED') {
        const cancelResult = await cancelOrder(order.id);
        if (Array.isArray(cancelResult?.errors) && cancelResult.errors.length > 0) {
          return res.status(409).json({
            error: cancelResult.errors[0]?.message || 'Unable to cancel order',
            code: cancelResult.errors[0]?.code || 'ORDER_CANCEL_FAILED'
          });
        }
      }

      return res.status(200).json({
        success: true,
        order_code: orderCode,
        action: 'payment_failed_or_expired'
      });
    }

    return res.status(202).json({
      success: true,
      ignored: true,
      reason: 'status_not_actionable',
      order_code: orderCode
    });
  } catch (error) {
    next(error);
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
