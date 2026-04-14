import 'dotenv/config';
import axios from 'axios';
import cors from 'cors';
import express from 'express';
import crypto from 'node:crypto';

import { verifyDirectusToken, verifyAuth0Token, requireAdmin } from './auth.js';
import { directusRequest, directusRequestAs, directusAdminRequest } from './directus.js';
import { canProvisionPaidOrder, ensureWorkspaceUser, isGoogleWorkspaceProvisioningEnabled } from './google-workspace.js';
import {
  addFixedDiscountToOrder,
  addItemToDraftOrder,
  completeCheckout,
  createCheckout,
  createDraftOrder,
  getOrderCommerceContext,
  initializeTransaction,
  processTransaction,
  updateCheckoutBillingAddress,
  getVariantAvailability,
  getVariantBySku,
  getOrderByCode,
  getOrderProvisioningContext,
} from './saleor.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const directusUrl = String(process.env.DIRECTUS_URL || '').trim();
const directusStaticToken = String(process.env.DIRECTUS_STATIC_TOKEN || '').trim();
const membersCollection = process.env.DIRECTUS_MEMBERS_COLLECTION || 'members';
const isProfilesCollection = membersCollection === 'profiles';
const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const directusSyncWebhookSecret = String(process.env.DIRECTUS_SYNC_WEBHOOK_SECRET || '').trim();
const subscriptionCollection = process.env.DIRECTUS_SUBSCRIPTION_COLLECTION || 'subscription';
const pricingCollection = process.env.DIRECTUS_PRICING_COLLECTION || 'pricing';
const directusEventsCollection = process.env.DIRECTUS_EVENTS_COLLECTION || 'events';
const directusEventTicketsCollection = process.env.DIRECTUS_EVENT_TICKETS_COLLECTION || 'event_tickets';
const directusEventOrdersCollection = process.env.DIRECTUS_EVENT_ORDERS_COLLECTION || 'event_orders';
const directusEventOrderItemsCollection = process.env.DIRECTUS_EVENT_ORDER_ITEMS_COLLECTION || 'event_order_items';
const directusEventAttendeesCollection = process.env.DIRECTUS_EVENT_ATTENDEES_COLLECTION || 'event_attendees';
const directusEventFormFieldsCollection = process.env.DIRECTUS_EVENT_FORM_FIELDS_COLLECTION || 'event_form_fields';
const directusEventFormAnswersCollection = process.env.DIRECTUS_EVENT_FORM_ANSWERS_COLLECTION || 'event_form_answers';
const directusEventCheckoutSessionsCollection = process.env.DIRECTUS_EVENT_CHECKOUT_SESSIONS_COLLECTION || 'event_checkout_sessions';
const coupleFlowSecret = String(process.env.COUPLE_FLOW_SECRET || '').trim();
const membershipNormalSku = String(process.env.MEMBERSHIP_SKU_NORMAL || '').trim();
const membershipExtendedSku = String(process.env.MEMBERSHIP_SKU_EXTENDED || '').trim();
const coupleSecondaryDiscount = Number(process.env.COUPLE_SECONDARY_DISCOUNT || 500000);
const checkoutClientSecret = String(process.env.CHECKOUT_CLIENT_SECRET || '').trim();
const directusFlowPatchEventOrderBuyerProfileId = String(
  process.env.DIRECTUS_FLOW_PATCH_EVENT_ORDER_BUYER_PROFILE_ID || ''
).trim();
const directusFlowGenerateAttendeeAssetsId = String(
  process.env.DIRECTUS_FLOW_GENERATE_ATTENDEE_ASSETS || ''
).trim();
const walletLinkSigningSecret = String(process.env.WALLET_LINK_SIGNING_SECRET || process.env.SECRET || '').trim();
const walletBackendUrl = String(process.env.WALLET_BACKEND_URL || 'https://jci-nusantara-wallet.vercel.app')
  .trim()
  .replace(/\/+$/, '');
const saleorPaymentGatewayId = String(process.env.SALEOR_PAYMENT_GATEWAY_ID || 'app.saleor.payment.gateway').trim();
const ticketAccessSecret = String(process.env.TICKET_ACCESS_SECRET || checkoutClientSecret || coupleFlowSecret || '').trim();
const ticketAccessTtlDays = Math.max(1, Math.round(Number(process.env.TICKET_ACCESS_TTL_DAYS || 30)));
const defaultEventCheckoutSessionTtlMinutes = Math.max(
  5,
  Math.round(Number(process.env.EVENT_CHECKOUT_SESSION_TTL_MINUTES || 180))
);

function getCurrentJakartaDateParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(new Date())
    .reduce((acc, part) => {
      if (part.type !== 'literal') {
        acc[part.type] = part.value;
      }
      return acc;
    }, {});

  return {
    year: Number(parts.year || 0),
    month: Number(parts.month || 0),
    day: Number(parts.day || 0),
  };
}

function resolveMembershipWindow() {
  const { month } = getCurrentJakartaDateParts();
  if (!Number.isFinite(month) || month < 1 || month > 12) return { key: 'closed', sku: '' };

  // Dec-Jun -> normal year membership.
  if (month === 12 || month <= 6) {
    return { key: 'normal', sku: membershipNormalSku };
  }

  // Jul-Oct -> 1.5 year membership.
  if (month >= 7 && month <= 10) {
    return { key: 'extended', sku: membershipExtendedSku };
  }

  // Nov remains closed unless business asks otherwise.
  return { key: 'closed', sku: '' };
}

async function getPricingPlanBySaleorSku(sku) {
  const value = String(sku || '').trim();
  if (!value) return null;

  try {
    const { data } = await directusRequest({
      method: 'GET',
      url: `/items/${pricingCollection}`,
      params: {
        'filter[saleor_sku][_eq]': value,
        fields: 'id,name,price,year,period_end_date,saleor_product_id,saleor_variant_id,saleor_sku',
        limit: 1,
      },
    });
    const items = Array.isArray(data?.data) ? data.data : [];
    return items[0] || null;
  } catch {
    return null;
  }
}

async function resolveMembershipVariant(window) {
  const fallbackSku = String(window?.sku || '').trim();
  const pricingPlan = await getPricingPlanBySaleorSku(fallbackSku);

  if (pricingPlan?.saleor_variant_id) {
    return {
      variant: {
        id: String(pricingPlan.saleor_variant_id),
        sku: String(pricingPlan.saleor_sku || fallbackSku),
        name: String(pricingPlan.name || ''),
      },
      pricingPlan,
      source: 'directus_pricing',
    };
  }

  const lookupSku = String(pricingPlan?.saleor_sku || fallbackSku).trim();
  if (!lookupSku) {
    return { variant: null, pricingPlan, source: 'unresolved' };
  }

  return {
    variant: await getVariantBySku(lookupSku),
    pricingPlan,
    source: pricingPlan ? 'directus_pricing_sku' : 'env_sku',
  };
}

function encodeBase64Url(input) {
  return Buffer.from(input).toString('base64url');
}

function decodeBase64Url(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function createCoupleInviteToken(payload) {
  if (!coupleFlowSecret) {
    throw new Error('COUPLE_FLOW_SECRET is required');
  }
  const raw = encodeBase64Url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', coupleFlowSecret).update(raw).digest('base64url');
  return `${raw}.${sig}`;
}

function parseAndVerifyCoupleInviteToken(token) {
  if (!coupleFlowSecret) {
    throw new Error('COUPLE_FLOW_SECRET is required');
  }

  const value = String(token || '').trim();
  const [raw, sig] = value.split('.');
  if (!raw || !sig) {
    throw new Error('Invalid invite token');
  }

  const expected = crypto.createHmac('sha256', coupleFlowSecret).update(raw).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid invite token signature');
  }

  const payload = JSON.parse(decodeBase64Url(raw));
  const expMs = Number(payload?.expMs || 0);
  if (!Number.isFinite(expMs) || expMs <= Date.now()) {
    throw new Error('Invite token is expired');
  }
  return payload;
}

function createTicketAccessToken(payload) {
  if (!ticketAccessSecret) {
    throw new Error('TICKET_ACCESS_SECRET is required');
  }

  const body = encodeBase64Url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', ticketAccessSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function parseAndVerifyTicketAccessToken(token) {
  if (!ticketAccessSecret) {
    throw new Error('TICKET_ACCESS_SECRET is required');
  }

  const value = String(token || '').trim();
  const [raw, sig] = value.split('.');
  if (!raw || !sig) {
    throw new Error('Invalid ticket access token');
  }

  const expected = crypto.createHmac('sha256', ticketAccessSecret).update(raw).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid ticket access token');
  }

  const payload = JSON.parse(decodeBase64Url(raw));
  const expMs = Number(payload?.expMs || 0);
  if (!Number.isFinite(expMs) || expMs <= Date.now()) {
    throw new Error('Ticket access link has expired');
  }

  return payload;
}

function isPublicRegistrationRoute(req) {
  const path = String(req.path || '').trim();
  return (
    path === '/registration/couple/primary' ||
    path === '/registration/couple/secondary'
  );
}

function isCheckoutIntegrationRoute(req) {
  const path = String(req.path || '').trim();
  return path.startsWith('/event-checkout/');
}

function isPublicTicketAccessRoute(req) {
  const path = String(req.path || '').trim();
  return req.method === 'GET' && path === '/ticket-access';
}

function hasValidCheckoutSecret(req) {
  const headerSecret = String(req.headers['x-checkout-secret'] || '').trim();
  return Boolean(checkoutClientSecret) && headerSecret === checkoutClientSecret;
}

function appendProvisioningRemark(existing, nextPart) {
  const now = new Date().toISOString();
  const prefix = `[workspace-provisioning ${now}]`;
  const current = String(existing || '').trim();
  const line = `${prefix} ${nextPart}`.trim();
  return current ? `${current}\n${line}` : line;
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

function hasEventPassed(endDate) {
  if (!endDate) return false;
  const timestamp = new Date(endDate).getTime();
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

async function archivePastEventsAndTickets() {
  const [eventsResponse, ticketsResponse] = await Promise.all([
    directusRequest({
      method: 'GET',
      url: `/items/${directusEventsCollection}`,
      params: {
        limit: -1,
        fields: 'id,status,end_date',
      },
    }),
    directusRequest({
      method: 'GET',
      url: `/items/${directusEventTicketsCollection}`,
      params: {
        limit: -1,
        fields: 'id,event_id,status',
      },
    }),
  ]);

  const events = Array.isArray(eventsResponse?.data?.data) ? eventsResponse.data.data : [];
  const tickets = Array.isArray(ticketsResponse?.data?.data) ? ticketsResponse.data.data : [];
  const eventsToClose = events.filter((event) => {
    const status = String(event?.status || '').trim().toLowerCase();
    return hasEventPassed(event?.end_date) && status !== 'closed' && status !== 'cancelled';
  });

  const eventIdsToClose = new Set(eventsToClose.map((event) => String(event.id)));
  const ticketsToArchive = tickets.filter((ticket) => {
    const eventId = String(ticket?.event_id?.id || ticket?.event_id || '').trim();
    const status = String(ticket?.status || '').trim().toLowerCase();
    return eventIdsToClose.has(eventId) && status !== 'archived';
  });

  for (const event of eventsToClose) {
    await directusRequest({
      method: 'PATCH',
      url: `/items/${directusEventsCollection}/${event.id}`,
      data: { status: 'closed' },
    });
  }

  for (const ticket of ticketsToArchive) {
    await directusRequest({
      method: 'PATCH',
      url: `/items/${directusEventTicketsCollection}/${ticket.id}`,
      data: { status: 'archived' },
    });
  }

  return {
    eventsClosed: eventsToClose.length,
    ticketsArchived: ticketsToArchive.length,
  };
}

async function readDirectusItems(collection, params = {}) {
  const { data } = await directusRequest({
    method: 'GET',
    url: `/items/${collection}`,
    params,
  });
  return Array.isArray(data?.data) ? data.data : [];
}

async function createDirectusItems(collection, payload) {
  const { data } = await directusRequest({
    method: 'POST',
    url: `/items/${collection}`,
    data: payload,
  });
  return data?.data ?? null;
}

async function updateDirectusItem(collection, itemId, payload) {
  const { data } = await directusRequest({
    method: 'PATCH',
    url: `/items/${collection}/${itemId}`,
    data: payload,
  });
  return data?.data ?? null;
}

async function getTicketAccessSummary({ token }) {
  const payload = parseAndVerifyTicketAccessToken(token);
  const orderCode = String(payload?.orderCode || '').trim();
  if (!orderCode) {
    const error = new Error('Ticket access token is invalid');
    error.status = 400;
    throw error;
  }

  const eventOrder = await findEventOrderByOrderNumber(orderCode);
  if (!eventOrder?.id) {
    const error = new Error('Ticket order not found');
    error.status = 404;
    throw error;
  }

  const normalizedStatus = String(eventOrder.status || '').trim().toLowerCase();
  if (normalizedStatus !== 'paid') {
    const error = new Error('Tickets are not ready yet');
    error.status = 409;
    throw error;
  }

  const eventId = Number(eventOrder.event_id || 0);
  const [eventItems, attendees, checkoutSessions, ticketItems] = await Promise.all([
    readDirectusItems(directusEventsCollection, {
      filter: { id: { _eq: eventId } },
      fields: 'id,title,slug,start_date,end_date,timezone,location,location_address',
      limit: 1,
    }),
    readDirectusItems(directusEventAttendeesCollection, {
      filter: { order_id: { _eq: eventOrder.id } },
      fields: 'id,ticket_id,ticket_number,holder_first_name,holder_last_name,holder_email,holder_phone,google_wallet_url,ticket_pdf,qr_code,apple_wallet_pass,jci_chapter',
      limit: -1,
    }),
    readDirectusItems(directusEventCheckoutSessionsCollection, {
      filter: {
        _or: [
          { saleor_order_number: { _eq: eventOrder.saleor_order_number || eventOrder.order_number } },
          { saleor_order_id: { _eq: eventOrder.saleor_order_id || '' } },
        ],
      },
      fields: 'id,customer_email',
      limit: 1,
    }),
    readDirectusItems(directusEventTicketsCollection, {
      filter: {
        id: {
          _in: [...new Set(attendees.map((item) => String(item?.ticket_id || '').trim()).filter(Boolean))],
        },
      },
      fields: 'id,name',
      limit: -1,
    }),
  ]);

  const eventItem = eventItems[0] || null;
  const checkoutSession = checkoutSessions[0] || null;
  const ticketNameById = new Map(
    ticketItems.map((item) => [String(item?.id || '').trim(), String(item?.name || '').trim()])
  );

  return {
    order: {
      id: eventOrder.id,
      orderCode: String(eventOrder.order_number || eventOrder.saleor_order_number || orderCode),
      paidAt: eventOrder.paid_at || null,
      currency: eventOrder.currency || 'IDR',
      subtotal: Number(eventOrder.subtotal || 0),
      grandTotal: Number(eventOrder.grand_total || 0),
      paymentMethod: String(eventOrder.payment_method || '').trim() || null,
      deliveryEmail:
        String(checkoutSession?.customer_email || '').trim() ||
        String(payload?.email || '').trim() ||
        null,
    },
    event: eventItem
      ? {
          id: eventItem.id,
          slug: String(eventItem.slug || '').trim() || null,
          title: String(eventItem.title || '').trim() || 'Event',
          startDate: eventItem.start_date || null,
          endDate: eventItem.end_date || null,
          timezone: String(eventItem.timezone || '').trim() || 'Asia/Jakarta',
          location: String(eventItem.location || '').trim() || null,
          locationAddress: String(eventItem.location_address || '').trim() || null,
        }
      : null,
    attendees: attendees.map((attendee) => ({
      id: attendee.id,
      ticketName: ticketNameById.get(String(attendee?.ticket_id || '').trim()) || 'Ticket',
      ticketNumber: String(attendee?.ticket_number || '').trim() || null,
      holderFirstName: String(attendee?.holder_first_name || '').trim() || null,
      holderLastName: String(attendee?.holder_last_name || '').trim() || null,
      holderEmail: String(attendee?.holder_email || '').trim() || null,
      holderPhone: String(attendee?.holder_phone || '').trim() || null,
      googleWalletUrl: String(attendee?.google_wallet_url || '').trim() || null,
      ticketPdf: String(attendee?.ticket_pdf || '').trim() || null,
      qrCode: String(attendee?.qr_code || '').trim() || null,
      appleWalletPass: String(attendee?.apple_wallet_pass || '').trim() || null,
      jciChapter: String(attendee?.jci_chapter || '').trim() || null,
    })),
  };
}

async function findEventOrderBySaleorRefs({ saleorOrderId, saleorOrderNumber }) {
  const filters = [];
  if (saleorOrderId) {
    filters.push({ saleor_order_id: { _eq: String(saleorOrderId) } });
  }
  if (saleorOrderNumber) {
    filters.push({ saleor_order_number: { _eq: String(saleorOrderNumber) } });
    filters.push({ order_number: { _eq: String(saleorOrderNumber) } });
  }
  if (!filters.length) return null;

  const items = await readDirectusItems(directusEventOrdersCollection, {
    filter: { _or: filters },
    fields: 'id,event_id,saleor_order_id,saleor_order_number,status',
    limit: 1,
  });
  return items[0] || null;
}

async function findEventOrderByOrderNumber(orderNumber) {
  const value = String(orderNumber || '').trim();
  if (!value) return null;

  const items = await readDirectusItems(directusEventOrdersCollection, {
    filter: {
      _or: [
        { order_number: { _eq: value } },
        { saleor_order_number: { _eq: value } },
      ],
    },
    fields: 'id,event_id,order_number,saleor_order_number,status,currency,subtotal,service_fee_total,grand_total,paid_at,payment_method,payment_reference,buyer_first_name,buyer_last_name,buyer_profile_id,buyer_guest_contact_id',
    limit: 1,
  });
  return items[0] || null;
}

// In-memory cache for event ticket mappings — refreshed every 5 minutes.
// Tickets rarely change, so this avoids a Directus round trip on every
// checkout creation and order projection.
const _ticketMappingsCache = { data: null, expiresAt: 0 };
const TICKET_MAPPINGS_TTL_MS = 5 * 60 * 1000;

async function fetchEventTicketMappings({ bustCache = false } = {}) {
  if (!bustCache && _ticketMappingsCache.data && Date.now() < _ticketMappingsCache.expiresAt) {
    return _ticketMappingsCache.data;
  }
  const data = await readDirectusItems(directusEventTicketsCollection, {
    limit: -1,
    fields: 'id,name,event_id,saleor_variant_id,saleor_sku',
  });
  _ticketMappingsCache.data = data;
  _ticketMappingsCache.expiresAt = Date.now() + TICKET_MAPPINGS_TTL_MS;
  return data;
}

async function fetchEventTicketsByIds(ticketIds) {
  const ids = [...new Set((Array.isArray(ticketIds) ? ticketIds : []).map((item) => String(item || '').trim()).filter(Boolean))];
  if (!ids.length) return [];

  return readDirectusItems(directusEventTicketsCollection, {
    filter: { id: { _in: ids } },
    fields: 'id,name,event_id,status,saleor_variant_id,saleor_sku,buyer_eligibility',
    limit: -1,
  });
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePhone(value) {
  return String(value || '').trim();
}

async function triggerDirectusFlow(flowId, payload) {
  const id = String(flowId || '').trim();
  if (!id) return null;

  const baseUrl = String(directusUrl || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('DIRECTUS_URL is not configured');
  }

  const headers = {
    'Content-Type': 'application/json',
  };
  if (directusStaticToken) {
    headers.Authorization = `Bearer ${directusStaticToken}`;
  }
  if (directusSyncWebhookSecret) {
    headers['x-sync-secret'] = directusSyncWebhookSecret;
  }

  const response = await fetch(`${baseUrl}/flows/trigger/${id}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload || {}),
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const error = new Error(`Directus flow ${id} failed with status ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

function isProfileMembershipActive(profile) {
  if (!profile || profile.subscribed !== true || profile.deactived === true) {
    return false;
  }

  const subscribedUntil = String(profile.subscribed_until || '').trim();
  if (!subscribedUntil) {
    return true;
  }

  const expiry = new Date(`${subscribedUntil}T23:59:59.999Z`);
  return Number.isFinite(expiry.getTime()) && expiry.getTime() >= Date.now();
}

async function findSubscribedProfileByEmail(email) {
  const profile = await findProfileByEmail(email, { subscribedOnly: true });
  return isProfileMembershipActive(profile) ? profile : null;
}

async function findProfileByEmail(email, { subscribedOnly = false } = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const filters = [{ email: { _eq: normalizedEmail } }];
  const rawEmail = String(email || '').trim();
  if (normalizedEmail !== rawEmail) {
    filters.push({ email: { _eq: rawEmail } });
  }

  const andFilters = [{ _or: filters }];
  if (subscribedOnly) {
    andFilters.push({ subscribed: { _eq: true } });
    andFilters.push({
      _or: [
        { deactived: { _null: true } },
        { deactived: { _eq: false } },
      ],
    });
  }

  const items = await readDirectusItems('profiles', {
    filter: { _and: andFilters },
    fields: 'id,email,subscribed,subscribed_until,deactived,first_name,last_name,phone',
    limit: 1,
  });

  return items[0] || null;
}

async function upsertGuestContact({
  email,
  firstName,
  lastName,
  phone,
  whatsapp,
}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const guestPayload = {
    first_name: String(firstName || '').trim() || null,
    last_name: String(lastName || '').trim() || null,
    email: normalizedEmail,
    phone: normalizePhone(phone) || null,
    whatsapp: normalizePhone(whatsapp || phone) || null,
    is_member: false,
    source: 'event_registration',
    last_seen_at: new Date().toISOString(),
  };

  const exact = await readDirectusItems('guest_contacts', {
    filter: { email: { _eq: normalizedEmail } },
    fields: 'id,email',
    limit: 1,
  });
  const existing = exact[0] || null;
  if (existing?.id) {
    await updateDirectusItem('guest_contacts', existing.id, guestPayload);
    return { id: existing.id, ...guestPayload };
  }

  const created = await createDirectusItems('guest_contacts', guestPayload);
  const createdItem = Array.isArray(created) ? created[0] : created;
  return createdItem || null;
}

function isDirectusForbidden(error) {
  return Number(error?.response?.status || 0) === 403;
}

function getAttendeeRowsByTicketId(eventFormAnswers) {
  const source = normalizeEventFormAnswerRequest(eventFormAnswers);
  const attendeesByTicketId =
    source?.attendeesByTicketId && typeof source.attendeesByTicketId === 'object'
      ? source.attendeesByTicketId
      : {};

  const rowsByTicketId = new Map();
  for (const [ticketId, rows] of Object.entries(attendeesByTicketId)) {
    rowsByTicketId.set(String(ticketId || '').trim(), normalizeArrayOfObjects(rows));
  }

  return rowsByTicketId;
}

async function fetchEventCheckoutSettings(eventId) {
  try {
    const items = await readDirectusItems('event_checkout_settings', {
      filter: { event_id: { _eq: Number(eventId) } },
      fields: 'id,checkout_time_limit_minutes',
      limit: 1,
    });
    return items[0] || null;
  } catch (error) {
    const message = String(error?.response?.data?.errors?.[0]?.message || error?.message || '');
    if (
      error?.response?.status === 403 ||
      /event_checkout_settings/i.test(message) ||
      /permission to access collection/i.test(message)
    ) {
      return null;
    }
    throw error;
  }
}

async function findCheckoutSessionBySaleorRefs({ saleorOrderId, saleorOrderNumber, paymentReference }) {
  const filters = [];
  if (saleorOrderId) {
    filters.push({ saleor_order_id: { _eq: String(saleorOrderId) } });
  }
  if (saleorOrderNumber) {
    filters.push({ saleor_order_number: { _eq: String(saleorOrderNumber) } });
  }
  if (paymentReference) {
    filters.push({ payment_reference: { _eq: String(paymentReference) } });
  }
  if (!filters.length) return null;

  const items = await readDirectusItems(directusEventCheckoutSessionsCollection, {
    filter: { _or: filters },
    fields: 'id,event_id,status,saleor_order_id,saleor_order_number,customer_email,payload_json,expires_at,projected_at,payment_reference',
    limit: 1,
  });
  return items[0] || null;
}

async function fetchEventFormFields(eventId) {
  return readDirectusItems(directusEventFormFieldsCollection, {
    filter: {
      _and: [
        { event_id: { _eq: Number(eventId) } },
        { active: { _eq: true } },
      ],
    },
    fields: 'id,event_id,field_key,scope,ticket_id,field_type',
    limit: -1,
  });
}

function normalizeDirectusEventId(value) {
  const raw = value?.id ?? value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function deriveEventLineMappings(orderCommerce, directusTickets) {
  const tickets = Array.isArray(directusTickets) ? directusTickets : [];
  const lines = Array.isArray(orderCommerce?.lines) ? orderCommerce.lines : [];

  return lines
    .map((line) => {
      const variantId = String(line?.variantId || '').trim();
      const sku = String(line?.sku || '').trim();
      const matchedTicket = tickets.find((ticket) => {
        const ticketVariantId = String(ticket?.saleor_variant_id || '').trim();
        const ticketSku = String(ticket?.saleor_sku || '').trim();
        return (variantId && ticketVariantId === variantId) || (sku && ticketSku === sku);
      });

      if (!matchedTicket) return null;

      return {
        line,
        ticket: matchedTicket,
        eventId: normalizeDirectusEventId(matchedTicket?.event_id),
      };
    })
    .filter((item) => item && item.eventId);
}

function toIdrInteger(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number);
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseStoredEventAnswerPayload(storedPayload = null) {
  const payload = normalizeEventFormAnswerRequest(storedPayload) || {};

  const orderAnswers =
    payload.order && typeof payload.order === 'object' && !Array.isArray(payload.order)
      ? payload.order
      : {};
  const attendees =
    payload.attendees && typeof payload.attendees === 'object' && !Array.isArray(payload.attendees)
      ? payload.attendees
      : {};

  return {
    orderAnswers,
    attendeeAnswersByLineId: attendees,
  };
}

function normalizeEventFormAnswerRequest(rawValue) {
  if (!rawValue) return null;
  if (typeof rawValue === 'string') {
    return parseJsonObject(rawValue);
  }
  if (typeof rawValue === 'object' && !Array.isArray(rawValue)) {
    return rawValue;
  }
  return null;
}

function normalizeArrayOfObjects(value) {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function buildCanonicalEventFormAnswers(orderCommerce, rawAnswers) {
  const source = normalizeEventFormAnswerRequest(rawAnswers);
  if (!source) return null;

  const lines = Array.isArray(orderCommerce?.lines) ? orderCommerce.lines : [];
  const lineById = new Map(lines.map((line) => [String(line?.id || '').trim(), line]).filter(([key]) => key));
  const lineBySku = new Map(lines.map((line) => [String(line?.sku || '').trim(), line]).filter(([key]) => key));
  const lineByVariantId = new Map(lines.map((line) => [String(line?.variantId || '').trim(), line]).filter(([key]) => key));

  const canonical = {
    order:
      source.order && typeof source.order === 'object' && !Array.isArray(source.order)
        ? source.order
        : {},
    attendees: {},
  };

  const appendAttendees = (lineId, rows) => {
    const normalizedLineId = String(lineId || '').trim();
    if (!normalizedLineId || !rows.length) return;
    if (!canonical.attendees[normalizedLineId]) {
      canonical.attendees[normalizedLineId] = [];
    }
    canonical.attendees[normalizedLineId].push(...rows);
  };

  for (const [lineId, rows] of Object.entries(source.attendees || {})) {
    if (!lineById.has(String(lineId).trim())) continue;
    appendAttendees(lineId, normalizeArrayOfObjects(rows));
  }

  for (const [sku, rows] of Object.entries(source.attendeesBySku || {})) {
    const line = lineBySku.get(String(sku || '').trim());
    if (!line?.id) continue;
    appendAttendees(line.id, normalizeArrayOfObjects(rows));
  }

  for (const [variantId, rows] of Object.entries(source.attendeesByVariantId || {})) {
    const line = lineByVariantId.get(String(variantId || '').trim());
    if (!line?.id) continue;
    appendAttendees(line.id, normalizeArrayOfObjects(rows));
  }

  if (!Object.keys(canonical.order).length && !Object.keys(canonical.attendees).length) {
    return null;
  }

  return canonical;
}

async function upsertEventCheckoutSession({
  orderCommerce,
  eventId,
  customerEmail,
  payloadJson,
  status = 'pending_payment',
}) {
  const saleorOrderId = String(orderCommerce?.id || '').trim();
  const saleorOrderNumber = String(orderCommerce?.code || orderCommerce?.token || '').trim();
  if (!eventId || !saleorOrderNumber) return null;

  const checkoutSettings = await fetchEventCheckoutSettings(eventId);
  const ttlMinutes = Math.max(
    5,
    Math.round(Number(checkoutSettings?.checkout_time_limit_minutes || defaultEventCheckoutSessionTtlMinutes))
  );
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

  const payload = {
    event_id: Number(eventId),
    saleor_order_id: saleorOrderId || null,
    saleor_order_number: saleorOrderNumber,
    customer_email: String(customerEmail || '').trim() || null,
    payload_json: payloadJson || null,
    status,
    expires_at: expiresAt,
  };

  const existing = await findCheckoutSessionBySaleorRefs({
    saleorOrderId,
    saleorOrderNumber,
  });
  if (existing?.id) {
    await updateDirectusItem(directusEventCheckoutSessionsCollection, existing.id, payload);
    return { ...existing, ...payload, id: existing.id };
  }

  const created = await createDirectusItems(directusEventCheckoutSessionsCollection, payload);
  const createdItem = Array.isArray(created) ? created[0] : created;
  return createdItem || null;
}

async function updateEventCheckoutSessionById(sessionId, payload) {
  const id = String(sessionId || '').trim();
  if (!id || !payload || typeof payload !== 'object') return null;
  await updateDirectusItem(directusEventCheckoutSessionsCollection, id, payload);
  return { id, ...payload };
}

function extractCheckoutCustomerEmail({ customer, eventFormAnswers }) {
  const source = normalizeEventFormAnswerRequest(eventFormAnswers);
  const orderEmail = String(source?.order?.email || source?.order?.customer_email || '').trim();
  if (orderEmail) return orderEmail;

  const attendeeGroups = [
    ...Object.values(source?.attendees || {}),
    ...Object.values(source?.attendeesBySku || {}),
    ...Object.values(source?.attendeesByVariantId || {}),
  ];
  for (const group of attendeeGroups) {
    for (const row of normalizeArrayOfObjects(group)) {
      const email = String(row?.email || '').trim();
      if (email) return email;
    }
  }

  const customerEmail = String(customer?.email || '').trim();
  return customerEmail || null;
}

function splitCheckoutName(fullName) {
  const normalized = String(fullName || '').trim();
  if (!normalized) {
    return { firstName: 'Guest', lastName: 'Attendee' };
  }

  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: 'Attendee' };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' ') || 'Attendee',
  };
}

function buildFallbackBillingAddress({ customerEmail, storedPayload }) {
  const parsedPayload = parseStoredEventAnswerPayload(storedPayload);
  const attendeeRows = Object.values(parsedPayload.attendeeAnswersByLineId || {})
    .flatMap((rows) => normalizeArrayOfObjects(rows));
  const firstAttendee = attendeeRows[0] || {};
  const orderAnswers =
    parsedPayload.orderAnswers && typeof parsedPayload.orderAnswers === 'object'
      ? parsedPayload.orderAnswers
      : {};

  const firstName =
    String(orderAnswers.first_name || firstAttendee.first_name || '').trim() ||
    splitCheckoutName(orderAnswers.name || '').firstName;
  const lastName =
    String(orderAnswers.last_name || firstAttendee.last_name || '').trim() ||
    splitCheckoutName(orderAnswers.name || '').lastName;
  const phone = String(
    orderAnswers.whatsapp_number ||
    orderAnswers.phone ||
    firstAttendee.whatsapp_number ||
    firstAttendee.phone ||
    ''
  ).trim();

  return {
    firstName: firstName || 'Guest',
    lastName: lastName || 'Attendee',
    streetAddress1: 'Address not provided',
    city: 'Jakarta',
    countryArea: 'DKI Jakarta',
    postalCode: '10210',
    country: 'ID',
    phone: phone || undefined,
    companyName: customerEmail ? `Checkout ${customerEmail}` : undefined,
  };
}

async function updateEventCheckoutSessionStatus({
  saleorOrderId,
  saleorOrderNumber,
  status,
  paymentReference = null,
  projectedAt = null,
}) {
  const session = await findCheckoutSessionBySaleorRefs({ saleorOrderId, saleorOrderNumber });
  if (!session?.id) return null;

  const payload = {
    status,
    payment_reference: paymentReference || session.payment_reference || null,
    saleor_order_id: String(saleorOrderId || session.saleor_order_id || '').trim() || null,
    saleor_order_number: String(saleorOrderNumber || session.saleor_order_number || '').trim() || null,
  };
  if (projectedAt) {
    payload.projected_at = projectedAt;
  }

  await updateDirectusItem(directusEventCheckoutSessionsCollection, session.id, payload);
  return { ...session, ...payload };
}

function getRequestIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0]?.trim();
  if (forwarded) return forwarded;
  const realIp = String(req.headers['x-real-ip'] || '').trim();
  if (realIp) return realIp;
  return String(req.ip || '').trim() || null;
}

function isSuccessfulTransactionEvent(type) {
  const value = String(type || '').trim().toUpperCase();
  return value === 'CHARGE_SUCCESS' || value === 'AUTHORIZATION_SUCCESS';
}

function resolveTransactionFailureStatus(processPayload) {
  const transactionType = String(processPayload?.transactionEvent?.type || '').trim().toUpperCase();
  const midtransStatus = String(processPayload?.data?.midtransStatus || '').trim().toLowerCase();
  if (transactionType !== 'CHARGE_FAILURE') return null;
  if (midtransStatus === 'expire') return 'expired';
  if (midtransStatus === 'cancel') return 'cancelled';
  if (midtransStatus === 'deny' || midtransStatus === 'failure') return 'cancelled';
  return 'cancelled';
}

function normalizeTicketId(value) {
  return String(value?.id || value || '').trim();
}

function findMatchingFormField(formFields, { scope, ticketId, fieldKey }) {
  const normalizedKey = String(fieldKey || '').trim();
  const normalizedScope = String(scope || '').trim();
  const normalizedTicketId = String(ticketId || '').trim();
  if (!normalizedKey || !normalizedScope) return null;

  const exact = formFields.find((field) => {
    const fieldTicketId = normalizeTicketId(field?.ticket_id);
    return (
      String(field?.scope || '') === normalizedScope &&
      String(field?.field_key || '') === normalizedKey &&
      fieldTicketId === normalizedTicketId
    );
  });
  if (exact) return exact;

  return formFields.find((field) => (
    String(field?.scope || '') === normalizedScope &&
    String(field?.field_key || '') === normalizedKey &&
    !normalizeTicketId(field?.ticket_id)
  )) || null;
}

function buildFormAnswerValuePayload(value) {
  if (value === undefined) return null;
  if (value === null) {
    return { value_text: null, value_json: null };
  }
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    return {
      value_text: null,
      value_json: value,
    };
  }
  return {
    value_text: String(value),
    value_json: null,
  };
}

function buildAttendeeProfilePatch(answerRow, attendee) {
  const row = answerRow && typeof answerRow === 'object' && !Array.isArray(answerRow) ? answerRow : {};
  const patch = {};

  const firstName = String(row.first_name || '').trim();
  const lastName = String(row.last_name || '').trim();
  const email = String(row.email || '').trim();
  const phone = String(row.whatsapp_number || row.phone || '').trim();
  const chapter = String(row.jci_chapter || '').trim();

  if (firstName && firstName !== String(attendee?.holder_first_name || '').trim()) {
    patch.holder_first_name = firstName;
  }
  if (lastName && lastName !== String(attendee?.holder_last_name || '').trim()) {
    patch.holder_last_name = lastName;
  }
  if (email && email !== String(attendee?.holder_email || '').trim()) {
    patch.holder_email = email;
  }
  if (phone && phone !== String(attendee?.holder_phone || '').trim()) {
    patch.holder_phone = phone;
  }
  if (chapter && chapter !== String(attendee?.jci_chapter || '').trim()) {
    patch.jci_chapter = chapter;
  }

  return Object.keys(patch).length ? patch : null;
}

async function resolveBuyerIdentity({ buyer, orderAnswers }) {
  const buyerEmail = normalizeEmail(orderAnswers?.email || buyer?.email);
  if (!buyerEmail) {
    return { buyerProfileId: null, buyerGuestContactId: null };
  }

  const profile = await findProfileByEmail(buyerEmail);
  if (profile?.id) {
    return {
      buyerProfileId: String(profile.id).trim(),
      buyerGuestContactId: null,
    };
  }

  const guest = await upsertGuestContact({
    email: buyerEmail,
    firstName: orderAnswers?.first_name || buyer?.firstName,
    lastName: orderAnswers?.last_name || buyer?.lastName,
    phone: orderAnswers?.phone || orderAnswers?.whatsapp_number || buyer?.phone,
    whatsapp: orderAnswers?.whatsapp_number || orderAnswers?.phone || buyer?.phone,
  });

  return {
    buyerProfileId: null,
    buyerGuestContactId: String(guest?.id || '').trim() || null,
  };
}

async function resolveAttendeeIdentity({ ticket, answerRow, attendee }) {
  const source = answerRow && typeof answerRow === 'object' && !Array.isArray(answerRow) ? answerRow : {};
  const attendeeEmail = normalizeEmail(source.email || attendee?.holder_email);
  const firstName = String(source.first_name || attendee?.holder_first_name || '').trim();
  const lastName = String(source.last_name || attendee?.holder_last_name || '').trim();
  const phone = normalizePhone(source.whatsapp_number || source.phone || attendee?.holder_phone);

  if (!attendeeEmail) {
    return {
      profileId: String(attendee?.profile_id || '').trim() || null,
      guestContactId: String(attendee?.guest_contact_id || '').trim() || null,
    };
  }

  const membershipRequired = String(ticket?.buyer_eligibility || '').trim() === 'jci_nusantara_member';
  const profile = membershipRequired
    ? await findSubscribedProfileByEmail(attendeeEmail)
    : await findProfileByEmail(attendeeEmail);

  if (profile?.id) {
    return {
      profileId: String(profile.id).trim(),
      guestContactId: null,
    };
  }

  const guest = await upsertGuestContact({
    email: attendeeEmail,
    firstName,
    lastName,
    phone,
    whatsapp: phone,
  });

  return {
    profileId: null,
    guestContactId: String(guest?.id || '').trim() || null,
  };
}

async function upsertEventFormAnswer({
  existingAnswersByKey,
  eventId,
  orderId,
  attendeeId = null,
  fieldId,
  value,
}) {
  const valuePayload = buildFormAnswerValuePayload(value);
  if (!fieldId || !valuePayload) return null;

  const answerKey = `${attendeeId || 'order'}:${fieldId}`;
  const payload = {
    event_id: eventId,
    order_id: orderId || null,
    attendee_id: attendeeId || null,
    field_id: fieldId,
    ...valuePayload,
  };

  const existing = existingAnswersByKey.get(answerKey);
  if (existing?.id) {
    await updateDirectusItem(directusEventFormAnswersCollection, existing.id, payload);
    return { created: false, id: existing.id };
  }

  const created = await createDirectusItems(directusEventFormAnswersCollection, payload);
  const createdItem = Array.isArray(created) ? created[0] : created;
  if (createdItem?.id) {
    existingAnswersByKey.set(answerKey, createdItem);
    return { created: true, id: createdItem.id };
  }

  return null;
}

async function syncEventFormAnswersToDirectus({
  eventId,
  eventOrderId,
  mappedLines,
  attendeeRecordsByLineId,
  storedPayload = null,
}) {
  const canonicalPayload = buildCanonicalEventFormAnswers(
    {
      lines: mappedLines.map((mapping) => mapping.line).filter(Boolean),
    },
    storedPayload
  );
  const answerPayload = parseStoredEventAnswerPayload(canonicalPayload || storedPayload);
  const hasOrderAnswers = Object.keys(answerPayload.orderAnswers).length > 0;
  const hasAttendeeAnswers = Object.keys(answerPayload.attendeeAnswersByLineId).length > 0;
  if (!hasOrderAnswers && !hasAttendeeAnswers) {
    return { created: 0, updated: 0, skipped: 'no_saleor_form_answers' };
  }

  const formFields = await fetchEventFormFields(eventId);
  if (!formFields.length) {
    return { created: 0, updated: 0, skipped: 'no_directus_form_fields' };
  }

  const existingAnswers = await readDirectusItems(directusEventFormAnswersCollection, {
    filter: { order_id: { _eq: eventOrderId } },
    fields: 'id,attendee_id,field_id',
    limit: -1,
  });
  const existingAnswersByKey = new Map(
    existingAnswers.map((item) => [`${item?.attendee_id || 'order'}:${item?.field_id || ''}`, item])
  );

  let created = 0;
  let updated = 0;

  for (const [fieldKey, value] of Object.entries(answerPayload.orderAnswers)) {
    const field = findMatchingFormField(formFields, {
      scope: 'order',
      ticketId: '',
      fieldKey,
    });
    if (!field?.id) continue;
    const result = await upsertEventFormAnswer({
      existingAnswersByKey,
      eventId,
      orderId: eventOrderId,
      fieldId: field.id,
      value,
    });
    if (result?.created) created += 1;
    else if (result?.id) updated += 1;
  }

  for (const mapping of mappedLines) {
    const lineId = String(mapping.line?.id || '').trim();
    const ticketId = String(mapping.ticket?.id || '').trim();
    const attendeeRecords = attendeeRecordsByLineId.get(lineId) || [];
    const attendeeAnswerRows = answerPayload.attendeeAnswersByLineId[lineId];
    if (!Array.isArray(attendeeAnswerRows) || !attendeeRecords.length) continue;

    for (let index = 0; index < Math.min(attendeeAnswerRows.length, attendeeRecords.length); index += 1) {
      const attendee = attendeeRecords[index];
      const answerRow = attendeeAnswerRows[index];
      if (!attendee?.id || !answerRow || typeof answerRow !== 'object' || Array.isArray(answerRow)) continue;

      const attendeePatch = buildAttendeeProfilePatch(answerRow, attendee);
      if (attendeePatch) {
        await updateDirectusItem(directusEventAttendeesCollection, attendee.id, attendeePatch);
      }

      for (const [fieldKey, value] of Object.entries(answerRow)) {
        const field = findMatchingFormField(formFields, {
          scope: 'attendee',
          ticketId,
          fieldKey,
        });
        if (!field?.id) continue;
        const result = await upsertEventFormAnswer({
          existingAnswersByKey,
          eventId,
          orderId: eventOrderId,
          attendeeId: attendee.id,
          fieldId: field.id,
          value,
        });
        if (result?.created) created += 1;
        else if (result?.id) updated += 1;
      }
    }
  }

  return {
    created,
    updated,
  };
}

function buildEventOrderPayload({
  orderCommerce,
  eventId,
  transactionId,
  buyerProfileId = null,
  buyerGuestContactId = null,
}) {
  const buyer = orderCommerce?.buyer || {};
  const paymentReference = String(transactionId || orderCommerce?.paymentTransactionId || '').trim();
  return {
    event_id: eventId,
    order_number: String(orderCommerce?.code || ''),
    status: 'paid',
    currency: String(orderCommerce?.currencyCode || 'IDR').toUpperCase(),
    subtotal: toIdrInteger(orderCommerce?.subtotalAmount),
    service_fee_total: 0,
    grand_total: toIdrInteger(orderCommerce?.totalAmount),
    payment_method: 'midtrans',
    payment_reference: paymentReference || null,
    paid_at: new Date().toISOString(),
    buyer_first_name: String(buyer?.firstName || '').trim() || null,
    buyer_last_name: String(buyer?.lastName || '').trim() || null,
    buyer_profile_id: buyerProfileId || null,
    buyer_guest_contact_id: buyerGuestContactId || null,
    saleor_order_id: String(orderCommerce?.id || '').trim() || null,
    saleor_order_number: String(orderCommerce?.code || '').trim() || null,
    saleor_transaction_reference: paymentReference || null,
  };
}

async function projectSaleorEventOrderToDirectus({ orderCode, transactionId, repairOnly = false }) {
  // Fetch Saleor order context and Directus ticket mappings in parallel
  const [orderCommerce, directusTickets] = await Promise.all([
    getOrderCommerceContext(orderCode),
    fetchEventTicketMappings(),
  ]);

  if (!orderCommerce) {
    return { projected: false, reason: 'saleor_order_context_not_found', orderCode };
  }

  const mappedLines = deriveEventLineMappings(orderCommerce, directusTickets);
  if (!mappedLines.length) {
    return { projected: false, reason: 'no_event_lines', orderCode };
  }

  const eventIds = [...new Set(mappedLines.map((item) => item.eventId))];
  if (eventIds.length !== 1) {
    return {
      projected: false,
      reason: 'multiple_events_in_single_saleor_order',
      orderCode,
      eventIds,
    };
  }

  const eventId = eventIds[0];
  const checkoutSession = await findCheckoutSessionBySaleorRefs({
    saleorOrderId: orderCommerce.id,
    saleorOrderNumber: orderCommerce.code,
  });
  const canonicalPayload = buildCanonicalEventFormAnswers(
    {
      lines: mappedLines.map((mapping) => mapping.line).filter(Boolean),
    },
    checkoutSession?.payload_json || null
  );
  const answerPayload = parseStoredEventAnswerPayload(canonicalPayload || checkoutSession?.payload_json || null);
  const buyerIdentity = await resolveBuyerIdentity({
    buyer: orderCommerce.buyer || {},
    orderAnswers: answerPayload.orderAnswers || {},
  });
  const existingOrder = await findEventOrderBySaleorRefs({
    saleorOrderId: orderCommerce.id,
    saleorOrderNumber: orderCommerce.code,
  });
  const orderPayload = buildEventOrderPayload({
    orderCommerce,
    eventId,
    transactionId,
    buyerProfileId: buyerIdentity.buyerProfileId,
    buyerGuestContactId: buyerIdentity.buyerGuestContactId,
  });

  let eventOrderId = existingOrder?.id || null;
  const orderPayloadWithoutIdentity = {
    ...orderPayload,
    buyer_profile_id: null,
    buyer_guest_contact_id: null,
  };
  if (eventOrderId && !repairOnly) {
    try {
      await updateDirectusItem(directusEventOrdersCollection, eventOrderId, orderPayload);
    } catch (error) {
      if (!isDirectusForbidden(error)) throw error;
      try {
        await updateDirectusItem(directusEventOrdersCollection, eventOrderId, orderPayloadWithoutIdentity);
      } catch (innerError) {
        if (!isDirectusForbidden(innerError)) throw innerError;
        console.warn('[event-order-update-skipped]', {
          eventOrderId,
          orderCode,
          reason: 'directus_forbidden',
        });
      }
    }
  } else if (!eventOrderId) {
    let createdOrder = null;
    try {
      const created = await createDirectusItems(directusEventOrdersCollection, orderPayload);
      createdOrder = Array.isArray(created) ? created[0] : created;
    } catch (error) {
      if (!isDirectusForbidden(error)) throw error;
      const created = await createDirectusItems(directusEventOrdersCollection, orderPayloadWithoutIdentity);
      createdOrder = Array.isArray(created) ? created[0] : created;
    }
    eventOrderId = createdOrder?.id || null;
  }

  if (!eventOrderId) {
    throw new Error(`Failed to create Directus event order for Saleor order ${orderCode}`);
  }

  const existingOrderItems = await readDirectusItems(directusEventOrderItemsCollection, {
    filter: { order_id: { _eq: eventOrderId } },
    fields: 'id,qty,saleor_line_id,saleor_variant_id,saleor_sku,ticket_id',
    limit: -1,
  });
  const orderItemsByLineId = new Map(
    existingOrderItems
      .map((item) => [String(item?.saleor_line_id || '').trim(), item])
      .filter(([key]) => key)
  );

  const createdOrderItems = [];
  const updatedOrderItems = [];
  for (const mapping of mappedLines) {
    const lineId = String(mapping.line?.id || '').trim();
    const payload = {
      order_id: eventOrderId,
      ticket_id: mapping.ticket.id,
      qty: Number(mapping.line?.quantity || 0),
      unit_price_snapshot: toIdrInteger(mapping.line?.unitAmount),
      line_total: toIdrInteger(mapping.line?.lineAmount),
      service_fee_snapshot: 0,
      saleor_line_id: lineId || null,
      saleor_variant_id: String(mapping.line?.variantId || '').trim() || null,
      saleor_sku: String(mapping.line?.sku || '').trim() || null,
    };

    const existingItem = lineId ? orderItemsByLineId.get(lineId) : null;
    if (existingItem?.id) {
      await updateDirectusItem(directusEventOrderItemsCollection, existingItem.id, payload);
      updatedOrderItems.push(existingItem.id);
      continue;
    }

    const created = await createDirectusItems(directusEventOrderItemsCollection, payload);
    const createdItem = Array.isArray(created) ? created[0] : created;
    if (createdItem?.id && lineId) {
      orderItemsByLineId.set(lineId, createdItem);
      createdOrderItems.push(createdItem.id);
    }
  }

  const currentOrderItems = await readDirectusItems(directusEventOrderItemsCollection, {
    filter: { order_id: { _eq: eventOrderId } },
    fields: 'id,qty,saleor_line_id,saleor_variant_id,saleor_sku,ticket_id',
    limit: -1,
  });
  const refreshedOrderItemsByLineId = new Map(
    currentOrderItems
      .map((item) => [String(item?.saleor_line_id || '').trim(), item])
      .filter(([key]) => key)
  );

  const existingAttendees = await readDirectusItems(directusEventAttendeesCollection, {
    filter: { order_id: { _eq: eventOrderId } },
    fields: 'id,order_item_id,saleor_line_id,holder_first_name,holder_last_name,holder_email,holder_phone,jci_chapter,profile_id,guest_contact_id,ticket_number',
    limit: -1,
  });
  const attendeeCountByLineId = new Map();
  for (const attendee of existingAttendees) {
    const lineId = String(attendee?.saleor_line_id || '').trim();
    if (!lineId) continue;
    attendeeCountByLineId.set(lineId, (attendeeCountByLineId.get(lineId) || 0) + 1);
  }

  const buyer = orderCommerce.buyer || {};
  const createdAttendees = [];
  const updatedAttendees = [];
  for (const mapping of mappedLines) {
    const lineId = String(mapping.line?.id || '').trim();
    const targetQty = Number(mapping.line?.quantity || 0);
    const existingCount = attendeeCountByLineId.get(lineId) || 0;
    const missingCount = Math.max(0, targetQty - existingCount);
    if (!lineId || missingCount === 0) continue;

    const orderItem = refreshedOrderItemsByLineId.get(lineId);
    const attendeeAnswerRows = answerPayload.attendeeAnswersByLineId[lineId];
    for (let index = 0; index < missingCount; index += 1) {
      const answerRow = Array.isArray(attendeeAnswerRows) ? attendeeAnswerRows[existingCount + index] || null : null;
      const attendeeIdentity = await resolveAttendeeIdentity({
        ticket: mapping.ticket,
        answerRow,
      });
      const payload = {
        event_id: eventId,
        order_id: eventOrderId,
        order_item_id: orderItem?.id || null,
        ticket_id: mapping.ticket.id,
        holder_first_name: String(answerRow?.first_name || buyer?.firstName || '').trim() || null,
        holder_last_name: String(answerRow?.last_name || buyer?.lastName || '').trim() || null,
        holder_email: String(answerRow?.email || buyer?.email || '').trim(),
        holder_phone: normalizePhone(answerRow?.whatsapp_number || answerRow?.phone || buyer?.phone) || null,
        profile_id: attendeeIdentity.profileId,
        guest_contact_id: attendeeIdentity.guestContactId,
        jci_chapter: String(answerRow?.jci_chapter || '').trim() || null,
        checkin_status: 'not_checked_in',
        saleor_order_id: String(orderCommerce?.id || '').trim() || null,
        saleor_line_id: lineId,
        saleor_variant_id: String(mapping.line?.variantId || '').trim() || null,
        saleor_sku: String(mapping.line?.sku || '').trim() || null,
      };
      const created = await createDirectusItems(directusEventAttendeesCollection, payload);
      const createdAttendee = Array.isArray(created) ? created[0] : created;
      if (createdAttendee?.id) {
        createdAttendees.push(createdAttendee.id);
      }
    }
  }

  const currentAttendees = await readDirectusItems(directusEventAttendeesCollection, {
    filter: { order_id: { _eq: eventOrderId } },
    fields: 'id,order_item_id,ticket_id,saleor_line_id,holder_first_name,holder_last_name,holder_email,holder_phone,jci_chapter,profile_id,guest_contact_id,ticket_number,ticket_pdf,qr_code,google_wallet_url',
    limit: -1,
  });
  const attendeeRecordsByLineId = new Map();
  for (const attendee of currentAttendees) {
    const lineId = String(attendee?.saleor_line_id || '').trim();
    if (!lineId) continue;
    if (!attendeeRecordsByLineId.has(lineId)) {
      attendeeRecordsByLineId.set(lineId, []);
    }
    attendeeRecordsByLineId.get(lineId).push(attendee);
  }

  for (const mapping of mappedLines) {
    const lineId = String(mapping.line?.id || '').trim();
    const attendeeRecords = attendeeRecordsByLineId.get(lineId) || [];
    const attendeeAnswerRows = answerPayload.attendeeAnswersByLineId[lineId];
    for (let index = 0; index < attendeeRecords.length; index += 1) {
      const attendee = attendeeRecords[index];
      const answerRow = Array.isArray(attendeeAnswerRows) ? attendeeAnswerRows[index] || null : null;
      const patch = buildAttendeeProfilePatch(answerRow, attendee) || {};
      const identity = await resolveAttendeeIdentity({
        ticket: mapping.ticket,
        answerRow,
        attendee,
      });

      if (identity.profileId !== undefined) {
        patch.profile_id = identity.profileId;
        if (identity.profileId) patch.guest_contact_id = null;
      }
      if (identity.guestContactId !== undefined && !identity.profileId) {
        patch.guest_contact_id = identity.guestContactId;
      }
      if (!String(attendee?.jci_chapter || '').trim() && answerRow?.jci_chapter) {
        patch.jci_chapter = String(answerRow.jci_chapter).trim();
      }

      const currentEmail = String(attendee?.holder_email || '').trim();
      const desiredEmail = String(answerRow?.email || currentEmail).trim();
      if (desiredEmail && desiredEmail !== currentEmail) {
        patch.holder_email = desiredEmail;
      }

      if (Object.keys(patch).length) {
        await updateDirectusItem(directusEventAttendeesCollection, attendee.id, patch);
        updatedAttendees.push(attendee.id);
        Object.assign(attendee, patch);
      }
    }
  }

  const formAnswers = await syncEventFormAnswersToDirectus({
    eventId,
    eventOrderId,
    mappedLines,
    attendeeRecordsByLineId,
    storedPayload: checkoutSession?.payload_json || null,
  });

  // Update session and return BEFORE triggering the slow Directus flows
  // (PDF generation, QR codes, Google Wallet, buyer profile linking).
  // The success page only needs event_orders + event_attendees to exist —
  // the asset URLs are loaded lazily when the user visits the ticket portal.
  if (checkoutSession?.id) {
    await updateDirectusItem(directusEventCheckoutSessionsCollection, checkoutSession.id, {
      status: 'projected',
      saleor_order_id: String(orderCommerce?.id || '').trim() || null,
      saleor_order_number: String(orderCommerce?.code || '').trim() || null,
      payment_reference: String(transactionId || orderCommerce?.paymentTransactionId || '').trim() || null,
      projected_at: new Date().toISOString(),
    });
  }

  // Fire-and-forget: slow Directus flow triggers run after we return
  setImmediate(async () => {
    if (buyerIdentity.buyerProfileId && directusFlowPatchEventOrderBuyerProfileId) {
      try {
        await triggerDirectusFlow(directusFlowPatchEventOrderBuyerProfileId, {
          event_order_id: eventOrderId,
          buyer_profile_id: buyerIdentity.buyerProfileId,
        });
      } catch (error) {
        console.error('[event-order-buyer-profile-flow] failed', {
          eventOrderId,
          buyerProfileId: buyerIdentity.buyerProfileId,
          error: error?.message || String(error),
          status: error?.status || null,
          body: error?.body || null,
        });
      }
    }

    if (directusFlowGenerateAttendeeAssetsId) {
      for (const attendee of currentAttendees) {
        const attendeeId = String(attendee?.id || '').trim();
        if (!attendeeId) continue;
        const needsAssets =
          !String(attendee?.ticket_number || '').trim() ||
          !String(attendee?.google_wallet_url || '').trim() ||
          !String(attendee?.qr_code || '').trim() ||
          !String(attendee?.ticket_pdf || '').trim();
        if (!needsAssets) continue;

        try {
          await triggerDirectusFlow(directusFlowGenerateAttendeeAssetsId, {
            attendee_id: attendeeId,
            wallet_signing_secret: walletLinkSigningSecret || null,
            wallet_backend_url: walletBackendUrl || null,
          });
        } catch (error) {
          console.error('[attendee-assets-flow] failed', {
            attendeeId,
            error: error?.message || String(error),
            status: error?.status || null,
            body: error?.body || null,
          });
        }
      }
    }
  });

  return {
    projected: true,
    orderCode,
    eventId,
    eventOrderId,
    createdOrderItems: createdOrderItems.length,
    updatedOrderItems: updatedOrderItems.length,
    createdAttendees: createdAttendees.length,
    updatedAttendees: updatedAttendees.length,
    formAnswers,
  };
}

async function getSubscriptionByInvoiceNumber(invoiceNumber) {
  const value = String(invoiceNumber || '').trim();
  if (!value) return null;

  try {
    const { data } = await directusRequest({
      method: 'GET',
      url: `/items/${subscriptionCollection}`,
      params: {
        'filter[invoice_number][_eq]': value,
        fields: 'id,email,profile_id,profile_name,paid,payment_remarks',
        limit: 1,
      },
    });
    const items = Array.isArray(data?.data) ? data.data : [];
    return items[0] || null;
  } catch {
    return null;
  }
}

async function patchSubscription(subscriptionId, payload) {
  if (!subscriptionId || !payload || typeof payload !== 'object') return;
  await directusRequest({
    method: 'PATCH',
    url: `/items/${subscriptionCollection}/${subscriptionId}`,
    data: payload,
  });
}

async function maybeProvisionWorkspaceAccount({ orderCode, transactionId }) {
  if (!isGoogleWorkspaceProvisioningEnabled()) {
    return { attempted: false, reason: 'provisioning_disabled' };
  }

  const provisioningOrder = await getOrderProvisioningContext(orderCode);
  if (!provisioningOrder) {
    return { attempted: false, reason: 'order_context_not_found' };
  }

  const subscription = await getSubscriptionByInvoiceNumber(orderCode);
  const qualifiesByKeyword = canProvisionPaidOrder(provisioningOrder);
  if (!subscription && !qualifiesByKeyword) {
    return { attempted: false, reason: 'not_membership_order' };
  }

  const preferredEmail = String(subscription?.email || provisioningOrder.userEmail || '').trim();
  if (!preferredEmail) {
    if (subscription?.id) {
      await patchSubscription(subscription.id, {
        payment_remarks: appendProvisioningRemark(
          subscription.payment_remarks,
          'workspace provisioning skipped: missing email'
        ),
      });
    }
    return { attempted: false, reason: 'missing_email' };
  }

  const [firstName, ...rest] = String(subscription?.profile_name || '').trim().split(/\s+/).filter(Boolean);
  const fullLastName = rest.join(' ');
  const firstNameResolved = firstName || provisioningOrder.firstName || 'Member';
  const lastNameResolved = fullLastName || provisioningOrder.lastName || 'JCI';

  const provisioningResult = await ensureWorkspaceUser({
    preferredEmail,
    firstName: firstNameResolved,
    lastName: lastNameResolved,
    externalId: subscription?.id ? `subscription:${subscription.id}` : `order:${orderCode}`,
  });

  if (subscription?.id) {
    await patchSubscription(subscription.id, {
      paid: true,
      confirmed: true,
      payment_method: 'midtrans',
      payment_remarks: appendProvisioningRemark(
        subscription.payment_remarks,
        `workspace account ${provisioningResult.status}: ${provisioningResult.primaryEmail || 'n/a'} (tx:${transactionId})`
      ),
    });
  }

  return {
    attempted: true,
    status: provisioningResult.status,
    primaryEmail: provisioningResult.primaryEmail || null,
    accountId: provisioningResult.id || null,
  };
}

function normalizeMember(item) {
  if (!item || typeof item !== 'object') return item;
  const fullnameCombined = [item.first_name, item.last_name].filter(Boolean).join(' ').trim();
  const name = item.fullname || item.full_name || fullnameCombined || item.name || item.email || null;
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

function isValidSyncWebhookSecret(req) {
  const headerSecret = String(req.headers['x-sync-secret'] || '').trim();
  if (headerSecret && directusSyncWebhookSecret && headerSecret === directusSyncWebhookSecret) {
    return true;
  }

  const authHeader = String(req.headers.authorization || '');
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token && directusSyncWebhookSecret && token === directusSyncWebhookSecret) {
      return true;
    }
  }

  return false;
}

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'jci-admin-mobile-bff' });
});

async function handleEventTicketAvailability(req, res, next) {
  try {
    const idsParam = Array.isArray(req.query?.ids) ? req.query.ids.join(',') : String(req.query?.ids || '');
    const ids = idsParam
      .split(',')
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    const channelSlug = String(req.query?.channel || 'default-channel').trim() || 'default-channel';

    if (!ids.length) {
      return res.status(400).json({ error: 'ids query parameter is required' });
    }

    const variants = await getVariantAvailability({ ids, channelSlug });
    return res.status(200).json({
      success: true,
      channel: channelSlug,
      variants,
    });
  } catch (error) {
    return next(error);
  }
}

async function handleEventCheckoutCreate(req, res, next) {
  const requestStartedAt = Date.now();
  const timings = [];
  const logTiming = (stage, extra = {}) => {
    timings.push({
      stage,
      durationMs: Date.now() - requestStartedAt,
      ...extra,
    });
  };

  try {
    const requestedEventId = Number(req.body?.eventId || 0);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const customer = req.body?.customer && typeof req.body.customer === 'object' ? req.body.customer : undefined;
    const eventFormAnswers = req.body?.eventFormAnswers;
    logTiming('request_parsed', {
      requestedEventId: requestedEventId || null,
      itemCount: items.length,
    });

    if (!items.length) {
      return res.status(400).json({ error: 'items are required' });
    }

    const normalizedItems = items.map((item) => ({
      ticketId: String(item?.ticketId || '').trim(),
      saleorVariantId: String(item?.saleorVariantId || '').trim(),
      quantity: Math.max(1, Math.round(Number(item?.quantity || 1))),
    })).filter((item) => item.ticketId);

    if (!normalizedItems.length) {
      return res.status(400).json({ error: 'items must contain at least one valid ticketId' });
    }

    const tickets = await fetchEventTicketsByIds(normalizedItems.map((item) => item.ticketId));
    logTiming('directus_tickets_loaded', {
      ticketCount: tickets.length,
    });
    if (tickets.length !== normalizedItems.length) {
      return res.status(404).json({ error: 'One or more tickets were not found' });
    }

    const eventIds = [...new Set(tickets.map((ticket) => normalizeDirectusEventId(ticket?.event_id)).filter(Boolean))];
    if (eventIds.length !== 1) {
      return res.status(409).json({ error: 'Selected tickets must belong to the same event' });
    }
    const eventId = eventIds[0];

    if (requestedEventId && requestedEventId !== eventId) {
      return res.status(409).json({ error: 'eventId does not match selected tickets' });
    }

    const unavailable = tickets.find((ticket) => String(ticket?.status || '').trim().toLowerCase() !== 'available');
    if (unavailable) {
      return res.status(409).json({ error: `Ticket ${unavailable.name || unavailable.id} is not available` });
    }

    const missingSaleorMapping = tickets.find((ticket) => !String(ticket?.saleor_variant_id || '').trim());
    if (missingSaleorMapping) {
      return res.status(409).json({ error: `Ticket ${missingSaleorMapping.name || missingSaleorMapping.id} is not mapped to Saleor` });
    }

    const mismatchedMapping = normalizedItems.find((item) => {
      if (!item.saleorVariantId) return false;
      const ticket = tickets.find((entry) => String(entry?.id || '').trim() === item.ticketId);
      return String(ticket?.saleor_variant_id || '').trim() !== item.saleorVariantId;
    });
    if (mismatchedMapping) {
      return res.status(409).json({
        error: `Saleor mapping mismatch for ticket ${mismatchedMapping.ticketId}`,
        code: 'SALEOR_VARIANT_MISMATCH',
      });
    }

    const normalizedAnswerRequest = normalizeEventFormAnswerRequest(eventFormAnswers) || {};

    const restrictedTickets = tickets.filter(
      (ticket) => String(ticket?.buyer_eligibility || 'public').trim() === 'jci_nusantara_member'
    );
    if (restrictedTickets.length > 0) {
      const attendeeRowsByTicketId = getAttendeeRowsByTicketId(normalizedAnswerRequest);
      const profileLookupCache = new Map();

      for (const restrictedTicket of restrictedTickets) {
        const ticketId = String(restrictedTicket?.id || '').trim();
        const requestedItem = normalizedItems.find((item) => item.ticketId === ticketId);
        const requiredCount = Math.max(1, Number(requestedItem?.quantity || 1));
        const attendeeRows = attendeeRowsByTicketId.get(ticketId) || [];

        if (attendeeRows.length < requiredCount) {
          return res.status(400).json({
            error: `Guest details are required for each ${restrictedTicket?.name || 'member-only'} ticket.`,
            code: 'ATTENDEE_DETAILS_REQUIRED',
          });
        }

        for (let index = 0; index < requiredCount; index += 1) {
          const attendeeRow = attendeeRows[index] || {};
          const attendeeEmail = normalizeEmail(attendeeRow?.email);
          if (!attendeeEmail) {
            return res.status(400).json({
              error: `Email is required for each ${restrictedTicket?.name || 'member-only'} ticket holder.`,
              code: 'ATTENDEE_EMAIL_REQUIRED',
            });
          }

          if (!profileLookupCache.has(attendeeEmail)) {
            profileLookupCache.set(attendeeEmail, await findSubscribedProfileByEmail(attendeeEmail));
          }

          const eligibleProfile = profileLookupCache.get(attendeeEmail);
          if (!eligibleProfile) {
            return res.status(403).json({
              error: `The ${restrictedTicket?.name || 'selected'} ticket is only available for active JCI Nusantara members.`,
              code: 'MEMBERSHIP_REQUIRED',
              data: {
                ticketId,
                attendeeEmail,
              },
            });
          }
        }
      }

      logTiming('membership_validation_completed', {
        restrictedTicketCount: restrictedTickets.length,
        validatedAttendeeCount: [...profileLookupCache.keys()].length,
      });
    }

    const ticketById = new Map(tickets.map((ticket) => [String(ticket.id), ticket]));
    const itemByTicketId = new Map(normalizedItems.map((item) => [item.ticketId, item]));

    const checkout = await createCheckout({
      channelSlug: 'default-channel',
      email: extractCheckoutCustomerEmail({ customer, eventFormAnswers }),
      lines: tickets.map((ticket) => {
        const matchedItem = itemByTicketId.get(String(ticket.id));
        return {
          variantId: matchedItem?.saleorVariantId || String(ticket.saleor_variant_id),
          quantity: matchedItem?.quantity || 1,
        };
      }),
    });
    logTiming('saleor_checkout_created', {
      checkoutId: checkout?.checkout?.id || null,
      errorCount: Array.isArray(checkout?.errors) ? checkout.errors.length : 0,
    });
    if (Array.isArray(checkout?.errors) && checkout.errors.length > 0) {
      return res.status(409).json({
        error: checkout.errors[0]?.message || 'Unable to create checkout',
        code: checkout.errors[0]?.code || 'CHECKOUT_CREATE_FAILED',
      });
    }
    if (!checkout?.checkout?.id || !checkout?.checkout?.token) {
      return res.status(500).json({ error: 'Unable to create checkout' });
    }

    if (normalizedAnswerRequest.attendeesByTicketId && typeof normalizedAnswerRequest.attendeesByTicketId === 'object') {
      normalizedAnswerRequest.attendeesByVariantId = {
        ...(normalizedAnswerRequest.attendeesByVariantId || {}),
      };
      for (const [ticketId, rows] of Object.entries(normalizedAnswerRequest.attendeesByTicketId)) {
        const ticket = ticketById.get(String(ticketId || '').trim());
        const variantId = String(ticket?.saleor_variant_id || '').trim();
        if (!variantId) continue;
        normalizedAnswerRequest.attendeesByVariantId[variantId] = rows;
      }
    }

    const checkoutSession = await upsertEventCheckoutSession({
      orderCommerce: {
        id: checkout.checkout.id,
        token: checkout.checkout.token,
      },
      eventId,
      customerEmail: extractCheckoutCustomerEmail({ customer, eventFormAnswers }),
      payloadJson: normalizedAnswerRequest,
      status: 'draft',
    });
    logTiming('directus_checkout_session_upserted', {
      checkoutSessionId: checkoutSession?.id || null,
    });

    const initializedTransaction = await initializeTransaction({
      id: checkout.checkout.id,
      paymentGatewayId: saleorPaymentGatewayId,
      data: {
        orderId: checkout.checkout.token,
        eventId,
        checkoutSessionId: checkoutSession?.id || null,
      },
    });
    logTiming('saleor_transaction_initialized', {
      transactionId: initializedTransaction?.transaction?.id || null,
      transactionEventType: initializedTransaction?.transactionEvent?.type || null,
      hasRedirectUrl: Boolean(
        initializedTransaction?.data?.redirectUrl ||
        initializedTransaction?.data?.externalUrl
      ),
      errorCount: Array.isArray(initializedTransaction?.errors) ? initializedTransaction.errors.length : 0,
    });
    if (Array.isArray(initializedTransaction?.errors) && initializedTransaction.errors.length > 0) {
      return res.status(409).json({
        error: initializedTransaction.errors[0]?.message || 'Unable to initialize payment transaction',
        code: initializedTransaction.errors[0]?.code || 'TRANSACTION_INITIALIZE_FAILED',
      });
    }

    if (checkoutSession?.id) {
      await updateEventCheckoutSessionById(checkoutSession.id, {
        status: 'pending_payment',
        payment_reference:
          String(initializedTransaction?.transaction?.id || initializedTransaction?.transaction?.pspReference || '').trim() || null,
      });
      logTiming('directus_checkout_session_updated', {
        checkoutSessionId: checkoutSession.id,
      });
    }

    console.info(JSON.stringify({
      scope: 'event-checkout-create',
      status: 'success',
      totalDurationMs: Date.now() - requestStartedAt,
      timings,
    }));

    return res.status(200).json({
      success: true,
      eventId,
      checkoutId: checkout.checkout.id,
      checkoutToken: checkout.checkout.token,
      checkoutSessionId: checkoutSession?.id || null,
      transactionId: initializedTransaction?.transaction?.id || null,
      transactionEventType: initializedTransaction?.transactionEvent?.type || null,
      redirectUrl:
        initializedTransaction?.data?.redirectUrl ||
        initializedTransaction?.data?.externalUrl ||
        null,
      paymentData: initializedTransaction?.data || null,
      items: normalizedItems.map((item) => ({
        ticketId: item.ticketId,
        quantity: item.quantity,
        saleorVariantId: String(ticketById.get(item.ticketId)?.saleor_variant_id || ''),
      })),
    });
  } catch (error) {
    console.error(JSON.stringify({
      scope: 'event-checkout-create',
      status: 'error',
      totalDurationMs: Date.now() - requestStartedAt,
      timings,
      error: error?.message || 'unknown_error',
    }));
    return next(error);
  }
}

function queueEventOrderProjection({ orderCode, transactionId, repairOnly = false, source = 'unknown' }) {
  const normalizedOrderCode = String(orderCode || '').trim();
  if (!normalizedOrderCode) return;

  setImmediate(async () => {
    try {
      await projectSaleorEventOrderToDirectus({
        orderCode: normalizedOrderCode,
        transactionId: String(transactionId || '').trim() || null,
        repairOnly,
      });
    } catch (error) {
      console.error('[event-order-projection] failed', {
        source,
        orderCode: normalizedOrderCode,
        repairOnly,
        message: error?.message || String(error),
        status: error?.status || error?.response?.status || null,
        body: error?.body || error?.response?.data || null,
      });
    }
  });
}

// In-memory lock: prevents two concurrent process-payment calls for the same
// checkout from both running the full Saleor flow simultaneously.
// Key = checkout token or ID, value = Promise of the in-flight result.
const _processPaymentLocks = new Map();

async function handleEventCheckoutProcessPayment(req, res, next) {
  // Declare lock variables outside try/catch so the catch block can access them.
  let lockKey = '';
  let resolveLock, rejectLock;

  try {
    const checkoutId = String(req.body?.checkoutId || '').trim();
    const checkoutToken = String(req.body?.checkoutToken || '').trim();
    const explicitTransactionId = String(req.body?.transactionId || '').trim();

    if (!checkoutId && !checkoutToken) {
      return res.status(400).json({ error: 'checkoutId or checkoutToken is required' });
    }

    lockKey = checkoutToken || checkoutId;

    // If another call is already processing this checkout, wait for it and
    // return the same result rather than running the full flow twice.
    if (_processPaymentLocks.has(lockKey)) {
      console.log('[process-payment] waiting for in-flight call', { lockKey });
      try {
        const cachedResult = await _processPaymentLocks.get(lockKey);
        return res.status(200).json(cachedResult);
      } catch {
        // If the in-flight call failed, fall through and try again
      }
    }

    const checkoutSession = await findCheckoutSessionBySaleorRefs({
      saleorOrderId: checkoutId || null,
      saleorOrderNumber: checkoutToken || null,
      paymentReference: explicitTransactionId || checkoutToken || null,
    });
    if (!checkoutSession?.id) {
      return res.status(404).json({ error: 'Checkout session not found' });
    }

    const normalizedSessionStatus = String(checkoutSession.status || '').trim().toLowerCase();
    if (
      (normalizedSessionStatus === 'paid' || normalizedSessionStatus === 'projected') &&
      (checkoutSession.saleor_order_id || checkoutSession.saleor_order_number)
    ) {
      const existingOrderCode = checkoutSession.saleor_order_number || null;
      const ticketAccessToken =
        existingOrderCode
          ? createTicketAccessToken({
              orderCode: existingOrderCode,
              eventId: checkoutSession.event_id || null,
              email: checkoutSession.customer_email || null,
              expMs: Date.now() + (ticketAccessTtlDays * 24 * 60 * 60 * 1000),
            })
          : null;
      const existingTransactionId = String(checkoutSession.payment_reference || explicitTransactionId || '').trim() || null;
      queueEventOrderProjection({
        orderCode: existingOrderCode,
        transactionId: existingTransactionId,
        repairOnly: true,
        source: 'process-payment:already-finalized',
      });
      return res.status(200).json({
        success: true,
        finalized: true,
        alreadyFinalized: true,
        checkoutSessionId: checkoutSession.id,
        orderCode: existingOrderCode,
        orderId: checkoutSession.saleor_order_id || null,
        transactionId: existingTransactionId,
        ticketAccessToken,
        eventProjection: null,
      });
    }

    // Always use the Saleor transaction item ID stored at checkout creation time.
    // The request body's transactionId may be a Midtrans UUID (not a valid Saleor ID).
    const transactionId = String(checkoutSession.payment_reference || '').trim();
    if (!transactionId) {
      return res.status(409).json({ error: 'Transaction ID is missing for checkout session' });
    }

    // Register the lock so concurrent calls for the same checkout wait for us
    const lockPromise = new Promise((res, rej) => { resolveLock = res; rejectLock = rej; });
    _processPaymentLocks.set(lockKey, lockPromise);

    const saleorCheckoutId = checkoutId || checkoutSession.saleor_order_id;

    // Run processTransaction and updateCheckoutBillingAddress in parallel —
    // they operate on independent Saleor objects (transaction vs checkout address).
    const [processedTransaction, billingAddressUpdate] = await Promise.all([
      processTransaction({ id: transactionId }),
      updateCheckoutBillingAddress({
        id: saleorCheckoutId,
        billingAddress: buildFallbackBillingAddress({
          customerEmail: checkoutSession.customer_email,
          storedPayload: checkoutSession.payload_json,
        }),
      }),
    ]);

    if (Array.isArray(processedTransaction?.errors) && processedTransaction.errors.length > 0) {
      return res.status(409).json({
        error: processedTransaction.errors[0]?.message || 'Unable to process payment transaction',
        code: processedTransaction.errors[0]?.code || 'TRANSACTION_PROCESS_FAILED',
      });
    }

    const transactionEventType = String(processedTransaction?.transactionEvent?.type || '').trim();
    if (!isSuccessfulTransactionEvent(transactionEventType)) {
      const failedStatus = resolveTransactionFailureStatus(processedTransaction);
      if (failedStatus) {
        await updateEventCheckoutSessionById(checkoutSession.id, {
          status: failedStatus,
        });
      }

      return res.status(200).json({
        success: true,
        finalized: false,
        checkoutSessionId: checkoutSession.id,
        checkoutId: checkoutId || checkoutSession.saleor_order_id || null,
        checkoutToken: checkoutToken || checkoutSession.saleor_order_number || null,
        transactionId,
        transactionEventType: transactionEventType || null,
        paymentData: processedTransaction?.data || null,
      });
    }

    const billingErrors = Array.isArray(billingAddressUpdate?.errors) ? billingAddressUpdate.errors : [];
    const billingNodeGone = billingErrors.some(
      (e) => String(e?.message || '').includes("Couldn't resolve to a node")
    );

    if (billingErrors.length > 0 && !billingNodeGone) {
      return res.status(409).json({
        error: billingErrors[0]?.message || 'Unable to set billing address for checkout',
        code: billingErrors[0]?.code || 'CHECKOUT_BILLING_ADDRESS_FAILED',
      });
    }

    let completedCheckout = null;
    if (!billingNodeGone) {
      completedCheckout = await completeCheckout({ id: saleorCheckoutId });
    }

    const completeErrors = Array.isArray(completedCheckout?.errors) ? completedCheckout.errors : [];
    const checkoutNodeGone = billingNodeGone || completeErrors.some(
      (e) => String(e?.message || '').includes("Couldn't resolve to a node")
    );

    if (checkoutNodeGone) {
      const refreshed = await findCheckoutSessionBySaleorRefs({
        saleorOrderId: checkoutId || null,
        saleorOrderNumber: checkoutToken || null,
        paymentReference: transactionId || checkoutToken || null,
      });
      const refreshedStatus = String(refreshed?.status || '').trim().toLowerCase();
      if (
        (refreshedStatus === 'paid' || refreshedStatus === 'projected') &&
        (refreshed?.saleor_order_id || refreshed?.saleor_order_number)
      ) {
        const existingOrderCode = refreshed.saleor_order_number || null;
        const ticketAccessToken = existingOrderCode
          ? createTicketAccessToken({
              orderCode: existingOrderCode,
              eventId: refreshed.event_id || null,
              email: refreshed.customer_email || null,
              expMs: Date.now() + (ticketAccessTtlDays * 24 * 60 * 60 * 1000),
            })
          : null;
        return res.status(200).json({
          success: true,
          finalized: true,
          alreadyFinalized: true,
          checkoutSessionId: refreshed.id,
          orderCode: existingOrderCode,
          orderId: refreshed.saleor_order_id || null,
          transactionId: String(refreshed.payment_reference || transactionId || '').trim() || null,
          ticketAccessToken,
        });
      }

      return res.status(409).json({
        error: 'Checkout was already completed by another process. Please refresh or check your email for confirmation.',
        code: 'CHECKOUT_ALREADY_COMPLETED',
      });
    }

    if (completeErrors.length > 0) {
      return res.status(409).json({
        error: completeErrors[0]?.message || 'Unable to complete checkout',
        code: completeErrors[0]?.code || 'CHECKOUT_COMPLETE_FAILED',
      });
    }
    if (!completedCheckout?.order?.id || !completedCheckout?.order?.code) {
      return res.status(409).json({
        error: 'Checkout payment processed but order was not created yet',
        code: 'CHECKOUT_NOT_COMPLETED',
        confirmationNeeded: completedCheckout?.confirmationNeeded || false,
      });
    }

    await updateEventCheckoutSessionById(checkoutSession.id, {
      status: 'paid',
      saleor_order_id: completedCheckout.order.id,
      saleor_order_number: completedCheckout.order.code,
      payment_reference:
        String(processedTransaction?.transaction?.pspReference || transactionId).trim() || transactionId,
    });

    const settledTransactionId =
      String(processedTransaction?.transaction?.pspReference || transactionId).trim() || transactionId;

    // Await projection synchronously so that event_orders exists in Directus
    // before we return the ticketAccessToken to the client. This prevents the
    // success page from fetching ticket data before it's ready.
    let eventProjection = null;
    try {
      eventProjection = await projectSaleorEventOrderToDirectus({
        orderCode: completedCheckout.order.code,
        transactionId: settledTransactionId,
      });
    } catch (projectionError) {
      // Log but don't fail the response — payment is confirmed regardless
      console.error('[process-payment] projection failed (non-fatal)', {
        orderCode: completedCheckout.order.code,
        error: projectionError?.message || String(projectionError),
      });
    }

    const ticketAccessToken = createTicketAccessToken({
      orderCode: completedCheckout.order.code,
      eventId: checkoutSession.event_id || null,
      email: checkoutSession.customer_email || null,
      expMs: Date.now() + (ticketAccessTtlDays * 24 * 60 * 60 * 1000),
    });

    const responseBody = {
      success: true,
      finalized: true,
      checkoutSessionId: checkoutSession.id,
      orderCode: completedCheckout.order.code,
      orderId: completedCheckout.order.id,
      transactionId,
      transactionEventType,
      ticketAccessToken,
      eventProjection: eventProjection || null,
    };

    // Release the lock so any waiting concurrent calls get this result
    if (typeof resolveLock === 'function') resolveLock(responseBody);
    setTimeout(() => _processPaymentLocks.delete(lockKey), 10000);

    return res.status(200).json(responseBody);
  } catch (error) {
    if (typeof rejectLock === 'function') rejectLock(error);
    setTimeout(() => _processPaymentLocks.delete(lockKey), 10000);
    return next(error);
  }
}

async function handleTicketAccess(req, res, next) {
  try {
    const token = String(req.query?.token || '').trim();
    if (!token) {
      return res.status(400).json({ error: 'token is required' });
    }

    const summary = await getTicketAccessSummary({ token });
    return res.status(200).json({
      success: true,
      summary,
    });
  } catch (error) {
    console.error('[ticket-access] failed', {
      message: error?.message || String(error),
      status: error?.status || error?.response?.status || null,
      response: error?.response?.data || null,
    });
    return next(error);
  }
}

/**
 * Lightweight status poll — reads only from Directus, never touches Saleor.
 * The frontend calls this after snap.pay() onSuccess to wait for the webhook
 * to complete the checkout, avoiding the race with process-payment.
 *
 * Query params: checkoutId | checkoutToken | transactionId (at least one required)
 */
async function handleEventCheckoutStatus(req, res, next) {
  try {
    const checkoutId = String(req.query?.checkoutId || '').trim();
    const checkoutToken = String(req.query?.checkoutToken || '').trim();
    const transactionId = String(req.query?.transactionId || '').trim();

    if (!checkoutId && !checkoutToken && !transactionId) {
      return res.status(400).json({ error: 'checkoutId, checkoutToken, or transactionId is required' });
    }

    const checkoutSession = await findCheckoutSessionBySaleorRefs({
      saleorOrderId: checkoutId || null,
      saleorOrderNumber: checkoutToken || null,
      paymentReference: transactionId || checkoutToken || null,
    });

    if (!checkoutSession?.id) {
      return res.status(404).json({ error: 'Checkout session not found' });
    }

    const sessionStatus = String(checkoutSession.status || '').trim().toLowerCase();
    const isFinalized = sessionStatus === 'paid' || sessionStatus === 'projected';
    const orderCode = checkoutSession.saleor_order_number || null;

    if (!isFinalized || !orderCode) {
      return res.status(200).json({
        success: true,
        finalized: false,
        status: sessionStatus,
        checkoutSessionId: checkoutSession.id,
      });
    }

    const ticketAccessToken = createTicketAccessToken({
      orderCode,
      eventId: checkoutSession.event_id || null,
      email: checkoutSession.customer_email || null,
      expMs: Date.now() + (ticketAccessTtlDays * 24 * 60 * 60 * 1000),
    });

    return res.status(200).json({
      success: true,
      finalized: true,
      status: sessionStatus,
      checkoutSessionId: checkoutSession.id,
      orderCode,
      orderId: checkoutSession.saleor_order_id || null,
      transactionId: String(checkoutSession.payment_reference || transactionId || '').trim() || null,
      ticketAccessToken,
    });
  } catch (error) {
    return next(error);
  }
}

app.use((req, res, next) => {
  const path = String(req.path || '').trim();
  if (req.method === 'POST' && path === '/event-checkout/create') {
    if (!checkoutClientSecret) {
      return next(Object.assign(new Error('CHECKOUT_CLIENT_SECRET is not configured'), { status: 503 }));
    }
    if (!hasValidCheckoutSecret(req)) {
      return next(Object.assign(new Error('Invalid checkout secret'), { status: 401 }));
    }
    return handleEventCheckoutCreate(req, res, next);
  }
  if (req.method === 'POST' && path === '/event-checkout/process-payment') {
    if (!checkoutClientSecret) {
      return next(Object.assign(new Error('CHECKOUT_CLIENT_SECRET is not configured'), { status: 503 }));
    }
    if (!hasValidCheckoutSecret(req)) {
      return next(Object.assign(new Error('Invalid checkout secret'), { status: 401 }));
    }
    return handleEventCheckoutProcessPayment(req, res, next);
  }
  if (req.method === 'GET' && path === '/event-checkout/status') {
    if (!checkoutClientSecret) {
      return next(Object.assign(new Error('CHECKOUT_CLIENT_SECRET is not configured'), { status: 503 }));
    }
    if (!hasValidCheckoutSecret(req)) {
      return next(Object.assign(new Error('Invalid checkout secret'), { status: 401 }));
    }
    return handleEventCheckoutStatus(req, res, next);
  }
  if (req.method === 'GET' && path === '/event-tickets/availability') {
    if (!checkoutClientSecret) {
      return next(Object.assign(new Error('CHECKOUT_CLIENT_SECRET is not configured'), { status: 503 }));
    }
    if (!hasValidCheckoutSecret(req)) {
      return next(Object.assign(new Error('Invalid checkout secret'), { status: 401 }));
    }
    return handleEventTicketAvailability(req, res, next);
  }
  return next();
});

app.get('/ticket-access', handleTicketAccess);

// ─── Auth: Token Exchange (Auth0 → Directus) ────────────────────────────────
// Flutter sends Auth0 ID token → BFF verifies it → finds/creates Directus user
// → ensures the user has a static token → returns it for per-user Directus access.

app.post('/auth/exchange', async (req, res, next) => {
  try {
    const { auth0_token } = req.body || {};
    if (!auth0_token) {
      return res.status(400).json({ error: 'auth0_token is required' });
    }

    // 1. Verify Auth0 token
    const auth0User = await verifyAuth0Token(auth0_token);
    const email = (auth0User.email || '').toLowerCase().trim();
    if (!email) {
      return res.status(400).json({ error: 'Auth0 token has no email claim' });
    }

    // 2. Find Directus user by email (using service token with directus_users read access)
    const { data: usersData } = await directusRequest({
      method: 'GET',
      url: '/users',
      params: {
        'filter[email][_eq]': email,
        fields: 'id,first_name,last_name,email,token,role.name',
        limit: 1,
      },
    });

    const users = Array.isArray(usersData?.data) ? usersData.data : [];
    if (users.length === 0) {
      return res.status(404).json({ error: `No Directus user found for ${email}` });
    }

    const directusUser = users[0];

    // 3. Always generate a fresh static token (Directus masks existing tokens as ********** in API responses)
    const directusToken = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');

    await directusRequest({
      method: 'PATCH',
      url: `/users/${directusUser.id}`,
      data: { token: directusToken },
    });

    // 3b. Verify the token works before returning it
    try {
      const verify = await directusRequestAs({ method: 'GET', url: '/users/me', params: { fields: 'id,email' } }, directusToken);
      console.log('[exchange] Token verified for:', verify.data?.data?.email);
    } catch (verifyErr) {
      console.error('[exchange] Token verification failed:', verifyErr.response?.data || verifyErr.message);
    }

    // 4. Return the Directus token + user info
    const roleName = directusUser.role?.name || '';
    const name = [directusUser.first_name, directusUser.last_name].filter(Boolean).join(' ');

    res.json({
      directus_token: directusToken,
      user: {
        id: directusUser.id,
        email: directusUser.email,
        name: name || email,
        directus_role: roleName,
        roles: [roleName.toLowerCase()].filter(Boolean),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── Auth: Token Refresh (unauthenticated) ─────────────────────────────────

app.post('/auth/refresh', async (req, res, next) => {
  try {
    const { refresh_token } = req.body || {};
    if (!refresh_token) {
      return res.status(400).json({ error: 'refresh_token is required' });
    }
    const { data } = await directusRequest({
      method: 'POST',
      url: '/auth/refresh',
      data: { refresh_token, mode: 'json' },
    });
    res.json({
      access_token: data?.data?.access_token,
      refresh_token: data?.data?.refresh_token,
      expires: data?.data?.expires,
    });
  } catch (error) {
    next(error);
  }
});

app.use(async (req, _res, next) => {
  const isWebhookRequest = req.path.startsWith('/webhooks');
  if (req.path === '/health' || req.path === '/auth/refresh' || req.path === '/auth/exchange' || isWebhookRequest || isPublicRegistrationRoute(req)) {
    return next();
  }

  if (isPublicTicketAccessRoute(req)) {
    return next();
  }

  if (isCheckoutIntegrationRoute(req)) {
    if (!checkoutClientSecret) {
      return next(Object.assign(new Error('CHECKOUT_CLIENT_SECRET is not configured'), { status: 503 }));
    }
    if (!hasValidCheckoutSecret(req)) {
      return next(Object.assign(new Error('Invalid checkout secret'), { status: 401 }));
    }
    return next();
  }

  try {
    req.auth = await verifyDirectusToken(req.headers.authorization);
    return next();
  } catch (error) {
    return next(error);
  }
});

app.post('/registration/couple/primary', async (req, res, next) => {
  try {
    const primaryEmail = String(req.body?.primaryEmail || '').trim().toLowerCase();
    const secondaryEmail = String(req.body?.secondaryEmail || '').trim().toLowerCase();
    const primaryName = String(req.body?.primaryName || '').trim();
    const secondaryName = String(req.body?.secondaryName || '').trim();

    if (!primaryEmail || !secondaryEmail) {
      return res.status(400).json({ error: 'primaryEmail and secondaryEmail are required' });
    }
    if (primaryEmail === secondaryEmail) {
      return res.status(400).json({ error: 'secondaryEmail must be different from primaryEmail' });
    }

    const window = resolveMembershipWindow();
    if (window.key === 'closed') {
      return res.status(409).json({ error: 'Membership registration window is closed' });
    }
    if (!window.sku) {
      return res.status(500).json({
        error: `Membership SKU is not configured for window ${window.key}`,
        requiredEnv: window.key === 'normal' ? 'MEMBERSHIP_SKU_NORMAL' : 'MEMBERSHIP_SKU_EXTENDED',
      });
    }

    const membershipVariant = await resolveMembershipVariant(window);
    const variant = membershipVariant.variant;
    if (!variant?.id) {
      return res.status(404).json({ error: `Membership variant not found for SKU ${window.sku}` });
    }

    const draft = await createDraftOrder();
    if (Array.isArray(draft?.errors) && draft.errors.length > 0) {
      return res.status(409).json({
        error: draft.errors[0]?.message || 'Unable to create draft order',
        code: draft.errors[0]?.code || 'CREATE_DRAFT_ORDER_FAILED',
      });
    }
    if (!draft?.order?.id || !draft?.order?.number) {
      return res.status(500).json({ error: 'Unable to create draft order' });
    }

    const added = await addItemToDraftOrder(draft.order.id, variant.id, 1);
    if (Array.isArray(added?.errors) && added.errors.length > 0) {
      return res.status(409).json({
        error: added.errors[0]?.message || 'Unable to add membership line',
        code: added.errors[0]?.code || 'ADD_LINE_FAILED',
      });
    }

    const invitePayload = {
      flow: 'couple-secondary',
      version: 1,
      pairId: crypto.randomUUID(),
      primaryOrderCode: draft.order.number,
      secondaryEmail,
      membershipWindow: window.key,
      membershipSku: window.sku,
      expMs: Date.now() + 1000 * 60 * 60 * 24 * 30,
    };

    const inviteToken = createCoupleInviteToken(invitePayload);
    const linkBase = publicBaseUrl || '';
    const secondaryLink = linkBase
      ? `${linkBase}/registration?flow=couple-secondary&invite=${encodeURIComponent(inviteToken)}`
      : null;

    return res.status(200).json({
      success: true,
      primary: {
        orderCode: draft.order.number,
        email: primaryEmail,
        name: primaryName || null,
      },
      secondary: {
        email: secondaryEmail,
        name: secondaryName || null,
        inviteToken,
        link: secondaryLink,
      },
      membership: {
        window: window.key,
        sku: variant.sku || window.sku,
        pricingPlanId: membershipVariant.pricingPlan?.id || null,
        source: membershipVariant.source,
      },
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/registration/couple/secondary', async (req, res, next) => {
  try {
    const inviteToken = String(req.body?.inviteToken || '').trim();
    const secondaryEmail = String(req.body?.secondaryEmail || '').trim().toLowerCase();

    if (!inviteToken || !secondaryEmail) {
      return res.status(400).json({ error: 'inviteToken and secondaryEmail are required' });
    }

    const invite = parseAndVerifyCoupleInviteToken(inviteToken);
    const expectedSecondaryEmail = String(invite?.secondaryEmail || '').trim().toLowerCase();
    if (!expectedSecondaryEmail || expectedSecondaryEmail !== secondaryEmail) {
      return res.status(403).json({ error: 'secondaryEmail does not match invite' });
    }

    const membershipSku = String(invite?.membershipSku || '').trim();
    if (!membershipSku) {
      return res.status(409).json({ error: 'Invite token does not contain membership SKU' });
    }

    const membershipVariant = await resolveMembershipVariant({ sku: membershipSku });
    const variant = membershipVariant.variant;
    if (!variant?.id) {
      return res.status(404).json({ error: `Membership variant not found for SKU ${membershipSku}` });
    }

    const draft = await createDraftOrder();
    if (Array.isArray(draft?.errors) && draft.errors.length > 0) {
      return res.status(409).json({
        error: draft.errors[0]?.message || 'Unable to create draft order',
        code: draft.errors[0]?.code || 'CREATE_DRAFT_ORDER_FAILED',
      });
    }
    if (!draft?.order?.id || !draft?.order?.number) {
      return res.status(500).json({ error: 'Unable to create draft order' });
    }

    const added = await addItemToDraftOrder(draft.order.id, variant.id, 1);
    if (Array.isArray(added?.errors) && added.errors.length > 0) {
      return res.status(409).json({
        error: added.errors[0]?.message || 'Unable to add membership line',
        code: added.errors[0]?.code || 'ADD_LINE_FAILED',
      });
    }

    const discount = await addFixedDiscountToOrder(
      draft.order.id,
      coupleSecondaryDiscount,
      `Couple secondary discount (${invite?.pairId || 'pair'})`
    );
    if (Array.isArray(discount?.errors) && discount.errors.length > 0) {
      return res.status(409).json({
        error: discount.errors[0]?.message || 'Unable to apply couple discount',
        code: discount.errors[0]?.code || 'ADD_DISCOUNT_FAILED',
      });
    }

    return res.status(200).json({
      success: true,
      orderCode: draft.order.number,
      membership: {
        sku: variant.sku || membershipSku,
        window: String(invite?.membershipWindow || ''),
        pricingPlanId: membershipVariant.pricingPlan?.id || null,
        source: membershipVariant.source,
      },
      discount: {
        type: 'fixed',
        amount: coupleSecondaryDiscount,
      },
      pairId: invite?.pairId || null,
      primaryOrderCode: invite?.primaryOrderCode || null,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /webhooks/payment/midtrans-settled
 * Called by the payment gateway app notification handler immediately after Midtrans
 * confirms payment. Updates the Directus checkout session status to 'paid' so the
 * frontend polling endpoint can reflect the result right away, before completeCheckout
 * and ORDER_CREATED projection have finished.
 */
app.post('/webhooks/payment/midtrans-settled', async (req, res, next) => {
  try {
    if (!checkoutClientSecret) {
      return res.status(503).json({ error: 'CHECKOUT_CLIENT_SECRET is not configured' });
    }
    if (!hasValidCheckoutSecret(req)) {
      return res.status(401).json({ error: 'Invalid checkout secret' });
    }

    const checkoutId = String(req.body?.checkoutId || '').trim();
    const checkoutToken = String(req.body?.checkoutToken || '').trim();
    const transactionId = String(req.body?.transactionId || '').trim();
    const orderNumber = String(req.body?.orderNumber || '').trim();
    const eventType = String(req.body?.eventType || '').trim();

    if (!checkoutId && !checkoutToken && !transactionId) {
      return res.status(400).json({ error: 'checkoutId, checkoutToken, or transactionId required' });
    }

    const checkoutSession = await findCheckoutSessionBySaleorRefs({
      saleorOrderId: checkoutId || null,
      saleorOrderNumber: checkoutToken || null,
      paymentReference: transactionId || checkoutToken || null,
    });

    if (!checkoutSession?.id) {
      console.warn('[midtrans-settled] Checkout session not found', { checkoutId, checkoutToken, transactionId });
      return res.status(404).json({ error: 'Checkout session not found' });
    }

    const isSuccess = eventType === 'CHARGE_SUCCESS';
    const isFailure = eventType === 'CHARGE_FAILURE';
    const currentStatus = String(checkoutSession.status || '').trim().toLowerCase();

    if (currentStatus === 'paid' || currentStatus === 'projected') {
      return res.status(200).json({ ok: true, skipped: true, reason: 'already_finalized', status: currentStatus });
    }

    const patch = {};
    if (isSuccess) {
      patch.status = 'paid';
      if (transactionId) patch.payment_reference = transactionId;
      if (orderNumber) {
        patch.saleor_order_number = orderNumber;
      }
    } else if (isFailure) {
      patch.status = 'payment_failed';
    }

    if (Object.keys(patch).length) {
      await updateEventCheckoutSessionById(checkoutSession.id, patch);
    }

    console.log('[midtrans-settled] Session updated', { sessionId: checkoutSession.id, patch, eventType });
    return res.status(200).json({ ok: true, sessionId: checkoutSession.id, updated: patch });
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /webhooks/saleor/order-created
 * Called by the payment gateway app's ORDER_CREATED Saleor webhook handler.
 * Projects the Saleor order into Directus (creates event_orders, attendees, etc.)
 * and marks the checkout session as 'projected'.
 */
app.post('/webhooks/saleor/order-created', async (req, res, next) => {
  try {
    if (!checkoutClientSecret) {
      return res.status(503).json({ error: 'CHECKOUT_CLIENT_SECRET is not configured' });
    }
    if (!hasValidCheckoutSecret(req)) {
      return res.status(401).json({ error: 'Invalid checkout secret' });
    }

    const orderId = String(req.body?.orderId || '').trim();
    const orderNumber = String(req.body?.orderNumber || '').trim();

    if (!orderNumber) {
      return res.status(400).json({ error: 'orderNumber is required' });
    }

    console.log('[saleor-order-created] Projecting order to Directus', { orderId, orderNumber });

    const result = await projectSaleorEventOrderToDirectus({
      orderCode: orderNumber,
      transactionId: null,
    });

    console.log('[saleor-order-created] Projection result', { orderNumber, result });
    return res.status(200).json({ ok: true, result });
  } catch (error) {
    console.error('[saleor-order-created] Projection error', { error: error?.message });
    return next(error);
  }
});


app.post('/webhooks/directus/archive-past-events', async (req, res, next) => {
  try {
    if (!directusSyncWebhookSecret) {
      return res.status(503).json({ error: 'DIRECTUS_SYNC_WEBHOOK_SECRET is not configured' });
    }

    if (!isValidSyncWebhookSecret(req)) {
      return res.status(401).json({ error: 'Invalid sync webhook secret' });
    }

    const summary = await archivePastEventsAndTickets();
    return res.status(200).json({ success: true, summary });
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
      roles: req.auth.roles,
      directus_role: req.auth.directusRoleName
    }
  });
});

app.get('/members', async (req, res, next) => {
  try {
    const limit = Number(req.query.limit || 50);
    const search = (req.query.search || '').toString().trim();

    const params = {
      limit,
      sort: 'first_name,last_name',
      fields: 'id,first_name,last_name,email,phone,subscribed,subscribed_until,deactived,member_id,join_date,address_kota,is_admin,job_title,point',
    };

    if (search) {
      params.search = search;
    }

    const { data } = await directusRequestAs({
      method: 'GET',
      url: `/items/${membersCollection}`,
      params
    }, req.auth.directusToken);

    const members = Array.isArray(data?.data) ? data.data.map(normalizeMember) : [];

    // Enrich with current officership from experiences
    const memberIds = members.map(m => m.id).filter(Boolean);
    if (memberIds.length > 0) {
      try {
        const { data: expData } = await directusRequestAs({
          method: 'GET',
          url: '/items/experiences',
          params: {
            'filter[profile_id][_in]': memberIds.join(','),
            'filter[deleted][_neq]': true,
            'filter[status][_eq]': 'approved',
            fields: 'profile_id,name,role_type',
            sort: '-startdate',
            limit: -1,
          },
        }, req.auth.directusToken);

        // Group by profile_id, take the most recent (first due to sort)
        const officershipMap = new Map();
        const experiences = Array.isArray(expData?.data) ? expData.data : [];
        for (const exp of experiences) {
          const pid = String(exp.profile_id || '');
          if (pid && !officershipMap.has(pid)) {
            officershipMap.set(pid, exp.name || exp.role_type || '');
          }
        }

        for (const member of members) {
          member.current_officership = officershipMap.get(member.id) || null;
        }
      } catch (_) {
        // Experiences not accessible — leave officership empty
      }
    }

    res.json({ data: members });
  } catch (error) {
    next(error);
  }
});

app.post('/members', requireAdmin, async (req, res, next) => {
  try {
    const { data } = await directusRequestAs({
      method: 'POST',
      url: `/items/${membersCollection}`,
      data: mapMemberPayload(req.body)
    }, req.auth.directusToken);

    res.status(201).json({ data: normalizeMember(data?.data) });
  } catch (error) {
    next(error);
  }
});

app.patch('/members/:id', requireAdmin, async (req, res, next) => {
  try {
    const { data } = await directusRequestAs({
      method: 'PATCH',
      url: `/items/${membersCollection}/${req.params.id}`,
      data: mapMemberPayload(req.body)
    }, req.auth.directusToken);

    res.json({ data: normalizeMember(data?.data) });
  } catch (error) {
    next(error);
  }
});

// ─── Admin Mobile: Dashboard Summary ─────────────────────────────────────────

app.get('/admin/summary', requireAdmin, async (req, res, next) => {
  try {
    const [pendingExperiences, pendingBusinesses, activeEvents] = await Promise.all([
      directusRequestAs({
        method: 'GET',
        url: '/items/experiences',
        params: { 'filter[status][_eq]': 'pending', 'aggregate[count]': 'id', limit: 1 },
      }, req.auth.directusToken).then(r => Number(r.data?.data?.[0]?.count?.id || 0)).catch(() => 0),
      directusRequestAs({
        method: 'GET',
        url: '/items/businesses',
        params: { 'filter[verified][_null]': true, 'aggregate[count]': 'id', limit: 1 },
      }, req.auth.directusToken).then(r => Number(r.data?.data?.[0]?.count?.id || 0)).catch(() => 0),
      directusRequestAs({
        method: 'GET',
        url: `/items/${directusEventsCollection}`,
        params: { 'filter[status][_eq]': 'published', 'aggregate[count]': 'id', limit: 1 },
      }, req.auth.directusToken).then(r => Number(r.data?.data?.[0]?.count?.id || 0)).catch(() => 0),
    ]);

    res.json({ pendingExperiences, pendingBusinesses, activeEvents });
  } catch (error) {
    next(error);
  }
});

// ─── Admin Mobile: Google Places Proxy ───────────────────────────────────────

const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY || '';

app.get('/admin/places/autocomplete', requireAdmin, async (req, res, next) => {
  try {
    const input = String(req.query.input || '').trim();
    if (!input || !googleMapsApiKey) {
      return res.json({ predictions: [] });
    }

    const { data } = await axios.get('https://maps.googleapis.com/maps/api/place/autocomplete/json', {
      params: {
        input,
        key: googleMapsApiKey,
        components: 'country:id',
        language: 'id',
      },
    });

    const predictions = (data?.predictions || []).map(p => ({
      place_id: p.place_id,
      description: p.description,
      main_text: p.structured_formatting?.main_text || '',
      secondary_text: p.structured_formatting?.secondary_text || '',
    }));

    res.json({ predictions });
  } catch (error) {
    next(error);
  }
});

app.get('/admin/places/detail', requireAdmin, async (req, res, next) => {
  try {
    const placeId = String(req.query.place_id || '').trim();
    if (!placeId || !googleMapsApiKey) {
      return res.status(400).json({ error: 'place_id is required' });
    }

    const { data } = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
      params: {
        place_id: placeId,
        key: googleMapsApiKey,
        fields: 'name,formatted_address,geometry',
        language: 'id',
      },
    });

    const result = data?.result || {};
    res.json({
      name: result.name || '',
      address: result.formatted_address || '',
      lat: result.geometry?.location?.lat || null,
      lng: result.geometry?.location?.lng || null,
    });
  } catch (error) {
    next(error);
  }
});

// ─── Admin Mobile: Event Categories ─────────────────────────────────────────

app.get('/admin/eventcategories', requireAdmin, async (req, res, next) => {
  try {
    const { data } = await directusRequestAs({
      method: 'GET',
      url: '/items/eventcategories',
      params: {
        fields: 'id,name',
        sort: 'name',
        limit: 500,
      },
    }, req.auth.directusToken);
    res.json({ data: Array.isArray(data?.data) ? data.data : [] });
  } catch (error) {
    next(error);
  }
});

// ─── Admin Mobile: Events ────────────────────────────────────────────────────

app.get('/admin/events', requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const status = String(req.query.status || '').trim();
    const type = String(req.query.type || '').trim();
    const search = String(req.query.search || '').trim();
    const sortParam = String(req.query.sort || '').trim();
    const now = new Date().toISOString();

    const params = {
      limit,
      sort: sortParam === 'modified' ? '-created_at' : '-start_date',
      fields: 'id,title,status,start_date,end_date,location,location_address,image,event_type,eventcategory_id.name,created_at',
    };

    // Status filtering
    if (status === 'upcoming') {
      params['filter[status][_eq]'] = 'published';
      params['filter[start_date][_gte]'] = now;
    } else if (status === 'past') {
      params['filter[status][_in]'] = 'published,closed';
      params['filter[start_date][_lt]'] = now;
    } else if (status === 'cancelled') {
      params['filter[status][_eq]'] = 'cancelled';
    } else {
      params['filter[status][_in]'] = 'published,closed,cancelled,draft';
    }

    // Type filtering
    if (type && type !== 'all') {
      params['filter[event_type][_eq]'] = type;
    }

    // Search filtering
    if (search) {
      params['filter[title][_icontains]'] = search;
    }

    const { data } = await directusRequestAs({
      method: 'GET',
      url: `/items/${directusEventsCollection}`,
      params,
    }, req.auth.directusToken);

    const events = Array.isArray(data?.data) ? data.data : [];

    if (events.length === 0) {
      return res.json({ data: [] });
    }

    const eventIds = events.map(ev => ev.id).filter(Boolean);

    // Batch enrichment: attendee counts, check-in counts, and paid order totals in parallel
    const [regData, checkedData, orderData] = await Promise.all([
      // Registered count per event
      directusRequestAs({
        method: 'GET',
        url: `/items/${directusEventAttendeesCollection}`,
        params: {
          'filter[event_id][_in]': eventIds.join(','),
          'aggregate[count]': 'id',
          'groupBy[]': 'event_id',
          limit: eventIds.length,
        },
      }, req.auth.directusToken).then(r => r.data?.data || []).catch(() => []),
      // Checked-in count per event
      directusRequestAs({
        method: 'GET',
        url: `/items/${directusEventAttendeesCollection}`,
        params: {
          'filter[event_id][_in]': eventIds.join(','),
          'filter[checkin_status][_eq]': 'checked_in',
          'aggregate[count]': 'id',
          'groupBy[]': 'event_id',
          limit: eventIds.length,
        },
      }, req.auth.directusToken).then(r => r.data?.data || []).catch(() => []),
      // Paid order revenue per event
      directusRequestAs({
        method: 'GET',
        url: '/items/event_orders',
        params: {
          'filter[event_id][_in]': eventIds.join(','),
          'filter[status][_eq]': 'paid',
          'aggregate[sum]': 'grand_total',
          'aggregate[count]': 'id',
          'groupBy[]': 'event_id',
          limit: eventIds.length,
        },
      }, req.auth.directusToken).then(r => r.data?.data || []).catch(() => []),
    ]);

    const regMap = {};
    for (const row of regData) {
      regMap[row.event_id] = Number(row.count?.id || 0);
    }
    const checkedMap = {};
    for (const row of checkedData) {
      checkedMap[row.event_id] = Number(row.count?.id || 0);
    }
    const orderCountMap = {};
    const revenueMap = {};
    for (const row of orderData) {
      orderCountMap[row.event_id] = Number(row.count?.id || 0);
      revenueMap[row.event_id] = Number(row.sum?.grand_total || 0);
    }

    const enriched = events.map(ev => ({
      ...ev,
      registered_count: regMap[ev.id] || 0,
      checked_in_count: checkedMap[ev.id] || 0,
      tickets_sold: regMap[ev.id] || 0,
      total_revenue: revenueMap[ev.id] || 0,
    }));

    res.json({ data: enriched });
  } catch (error) {
    next(error);
  }
});

app.get('/admin/events/:id', requireAdmin, async (req, res, next) => {
  try {
    const { data } = await directusRequestAs({
      method: 'GET',
      url: `/items/${directusEventsCollection}/${req.params.id}`,
      params: {
        fields: 'id,title,status,start_date,end_date,location,location_address,description,event_details,event_location,location_mode,online_meeting_url,pic_id.id,pic_id.first_name,pic_id.last_name,pic_id.phone,point,publicEvent,eventcategory_id.id,eventcategory_id.name,event_type,slug,timezone,image',
      },
    }, req.auth.directusToken);

    if (!data?.data) return res.status(404).json({ error: 'Event not found' });

    const ev = data.data;
    const [regRes, checkedRes] = await Promise.all([
      directusRequestAs({
        method: 'GET',
        url: `/items/${directusEventAttendeesCollection}`,
        params: {
          'filter[event_id][_eq]': ev.id,
          'aggregate[count]': 'id',
          limit: 1,
        },
      }, req.auth.directusToken).catch(() => ({ data: { data: [] } })),
      directusRequestAs({
        method: 'GET',
        url: `/items/${directusEventAttendeesCollection}`,
        params: {
          'filter[event_id][_eq]': ev.id,
          'filter[checkin_status][_eq]': 'checked_in',
          'aggregate[count]': 'id',
          limit: 1,
        },
      }, req.auth.directusToken).catch(() => ({ data: { data: [] } })),
    ]);
    const registeredCount = Number(regRes.data?.data?.[0]?.count?.id ?? 0);
    const checkedInCount = Number(checkedRes.data?.data?.[0]?.count?.id ?? 0);

    res.json({ data: { ...ev, registered_count: registeredCount, checked_in_count: checkedInCount } });
  } catch (error) {
    next(error);
  }
});

app.patch('/admin/events/:id', requireAdmin, async (req, res, next) => {
  try {
    const body = req.body || {};
    const payload = {};

    // Only include fields that were sent
    const directFields = ['title', 'event_type', 'start_date', 'end_date', 'timezone',
      'location_mode', 'location', 'location_address', 'online_meeting_url',
      'description', 'event_details', 'event_location', 'image',
      'eventcategory_id', 'pic_id', 'point', 'publicEvent'];

    for (const field of directFields) {
      if (body.hasOwnProperty(field)) {
        payload[field] = body[field];
      }
    }

    const { data } = await directusRequestAs({
      method: 'PATCH',
      url: `/items/${directusEventsCollection}/${req.params.id}`,
      data: payload,
    }, req.auth.directusToken);

    res.json({ data: data?.data });
  } catch (error) {
    next(error);
  }
});

app.get('/admin/events/:id/tickets', requireAdmin, async (req, res, next) => {
  try {
    // Fetch tickets for this event
    const { data: ticketData } = await directusRequestAs({
      method: 'GET',
      url: '/items/event_tickets',
      params: {
        'filter[event_id][_eq]': req.params.id,
        fields: 'id,name,price,pricing_method,status,quantity_mode,quantity_total,sort,description,buyer_eligibility',
        sort: 'sort',
        limit: 200,
      },
    }, req.auth.directusToken);

    const tickets = Array.isArray(ticketData?.data) ? ticketData.data : [];

    // Get sold count per ticket
    if (tickets.length > 0) {
      const ticketIds = tickets.map(t => t.id).filter(Boolean);
      const { data: attendeeData } = await directusRequestAs({
        method: 'GET',
        url: `/items/${directusEventAttendeesCollection}`,
        params: {
          'filter[ticket_id][_in]': ticketIds.join(','),
          'aggregate[count]': 'id',
          'groupBy[]': 'ticket_id',
          limit: ticketIds.length,
        },
      }, req.auth.directusToken);

      const countMap = {};
      for (const row of (attendeeData?.data || [])) {
        countMap[row.ticket_id] = Number(row.count?.id || 0);
      }

      for (const ticket of tickets) {
        ticket.sold_count = countMap[ticket.id] || 0;
      }
    }

    res.json({ data: tickets });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/events/:id/tickets', requireAdmin, async (req, res, next) => {
  try {
    const body = req.body || {};
    const payload = {
      event_id: req.params.id,
      name: body.name || 'New Ticket',
      pricing_method: body.pricing_method || 'free',
      price: body.pricing_method === 'fixed' ? Number(body.price || 0) : 0,
      status: body.status || 'available',
      quantity_mode: body.quantity_mode || 'unlimited',
      quantity_total: body.quantity_mode === 'limited' ? Number(body.quantity_total || 0) : null,
      description: body.description || null,
      buyer_eligibility: body.buyer_eligibility || 'public',
      sort: body.sort || 0,
    };

    const { data } = await directusRequestAs({
      method: 'POST',
      url: '/items/event_tickets',
      data: payload,
    }, req.auth.directusToken);

    res.status(201).json({ data: data?.data });
  } catch (error) {
    next(error);
  }
});

app.patch('/admin/events/:id/tickets/:ticketId', requireAdmin, async (req, res, next) => {
  try {
    const body = req.body || {};
    const payload = {};
    const allowedFields = ['name', 'pricing_method', 'price', 'status', 'quantity_mode', 'quantity_total', 'description', 'buyer_eligibility', 'sort', 'description_footer'];
    for (const field of allowedFields) {
      if (body.hasOwnProperty(field)) payload[field] = body[field];
    }

    const { data } = await directusRequestAs({
      method: 'PATCH',
      url: `/items/event_tickets/${req.params.ticketId}`,
      data: payload,
    }, req.auth.directusToken);

    res.json({ data: data?.data });
  } catch (error) {
    next(error);
  }
});

app.delete('/admin/events/:id/tickets/:ticketId', requireAdmin, async (req, res, next) => {
  try {
    await directusRequestAs({
      method: 'DELETE',
      url: `/items/event_tickets/${req.params.ticketId}`,
    }, req.auth.directusToken);

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/events/:id/tickets/:ticketId/duplicate', requireAdmin, async (req, res, next) => {
  try {
    // Fetch original
    const { data: origData } = await directusRequestAs({
      method: 'GET',
      url: `/items/event_tickets/${req.params.ticketId}`,
      params: { fields: 'name,pricing_method,price,status,quantity_mode,quantity_total,description,buyer_eligibility,sort,description_footer' },
    }, req.auth.directusToken);

    const orig = origData?.data;
    if (!orig) return res.status(404).json({ error: 'Ticket not found' });

    const { data } = await directusRequestAs({
      method: 'POST',
      url: '/items/event_tickets',
      data: {
        ...orig,
        event_id: req.params.id,
        name: `${orig.name} (Copy)`,
      },
    }, req.auth.directusToken);

    res.status(201).json({ data: data?.data });
  } catch (error) {
    next(error);
  }
});

app.get('/admin/events/:id/orders', requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const search = String(req.query.search || '').trim();
    const statusFilter = String(req.query.status || '').trim();

    const params = {
      'filter[event_id][_eq]': req.params.id,
      fields: 'id,order_number,status,currency,subtotal,service_fee_total,grand_total,buyer_first_name,buyer_last_name,buyer_profile_id,payment_method,payment_reference,paid_at,date_created',
      sort: '-date_created',
      limit,
    };

    if (statusFilter && statusFilter !== 'all') {
      params['filter[status][_eq]'] = statusFilter;
    }

    if (search) {
      params['filter[_or][0][order_number][_icontains]'] = search;
      params['filter[_or][1][buyer_first_name][_icontains]'] = search;
      params['filter[_or][2][buyer_last_name][_icontains]'] = search;
    }

    const { data } = await directusRequestAs({
      method: 'GET',
      url: '/items/event_orders',
      params,
    }, req.auth.directusToken);

    const orders = Array.isArray(data?.data) ? data.data : [];

    // Get attendee count per order
    if (orders.length > 0) {
      const orderIds = orders.map(o => o.id).filter(Boolean);
      const { data: attData } = await directusRequestAs({
        method: 'GET',
        url: `/items/${directusEventAttendeesCollection}`,
        params: {
          'filter[order_id][_in]': orderIds.join(','),
          'aggregate[count]': 'id',
          'groupBy[]': 'order_id',
          limit: orderIds.length,
        },
      }, req.auth.directusToken);

      const countMap = {};
      for (const row of (attData?.data || [])) {
        countMap[row.order_id] = Number(row.count?.id || 0);
      }

      for (const order of orders) {
        order.ticket_count = countMap[order.id] || 0;
      }
    }

    res.json({ data: orders });
  } catch (error) {
    next(error);
  }
});

app.get('/admin/events/:id/stats', requireAdmin, async (req, res, next) => {
  try {
    const [ticketData, orderData, attendeeData] = await Promise.all([
      // Tickets with sold count
      directusRequestAs({
        method: 'GET',
        url: '/items/event_tickets',
        params: {
          'filter[event_id][_eq]': req.params.id,
          fields: 'id,name,price,pricing_method,quantity_mode,quantity_total,sort',
          sort: 'sort',
          limit: 200,
        },
      }, req.auth.directusToken).then(r => r.data?.data || []).catch(() => []),
      // Orders for revenue
      directusRequestAs({
        method: 'GET',
        url: '/items/event_orders',
        params: {
          'filter[event_id][_eq]': req.params.id,
          'filter[status][_eq]': 'paid',
          fields: 'id,grand_total,service_fee_total,subtotal',
          limit: -1,
        },
      }, req.auth.directusToken).then(r => r.data?.data || []).catch(() => []),
      // Attendee count per ticket
      directusRequestAs({
        method: 'GET',
        url: `/items/${directusEventAttendeesCollection}`,
        params: {
          'filter[event_id][_eq]': req.params.id,
          'aggregate[count]': 'id',
          'groupBy[]': 'ticket_id',
          limit: 200,
        },
      }, req.auth.directusToken).then(r => r.data?.data || []).catch(() => []),
    ]);

    const soldByTicket = {};
    for (const row of attendeeData) {
      soldByTicket[row.ticket_id] = Number(row.count?.id || 0);
    }

    const tickets_sold = Object.values(soldByTicket).reduce((sum, c) => sum + c, 0);
    const gross_sales = orderData.reduce((sum, o) => sum + Number(o.grand_total || 0), 0);
    const net_sales = orderData.reduce((sum, o) => sum + Number(o.subtotal || 0), 0);

    const per_ticket = ticketData.map(t => ({
      id: t.id,
      name: t.name,
      price: Number(t.price || 0),
      pricing_method: t.pricing_method,
      sold: soldByTicket[t.id] || 0,
      total: t.quantity_mode === 'unlimited' ? null : Number(t.quantity_total || 0),
    }));

    res.json({ net_sales, gross_sales, tickets_sold, per_ticket });
  } catch (error) {
    next(error);
  }
});

app.get('/admin/events/:id/attendees', requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const search = String(req.query.search || '').trim();

    const params = {
      limit,
      sort: 'holder_last_name,holder_first_name',
      'filter[event_id][_eq]': req.params.id,
      fields: [
        'id',
        'holder_first_name',
        'holder_last_name',
        'holder_email',
        'jci_chapter',
        'checkin_status',
        'checked_in_at',
        'ticket_id.name',
        'ticket_id.id',
      ].join(','),
    };

    if (search) {
      params['filter[_or][0][holder_first_name][_icontains]'] = search;
      params['filter[_or][1][holder_last_name][_icontains]'] = search;
      params['filter[_or][2][holder_email][_icontains]'] = search;
      params['filter[_or][3][jci_chapter][_icontains]'] = search;
    }

    const { data } = await directusRequestAs({
      method: 'GET',
      url: `/items/${directusEventAttendeesCollection}`,
      params,
    }, req.auth.directusToken);

    res.json({ data: Array.isArray(data?.data) ? data.data : [] });
  } catch (error) {
    next(error);
  }
});

app.patch('/admin/events/:eventId/attendees/:attendeeId/checkin', requireAdmin, async (req, res, next) => {
  try {
    const { data } = await directusRequestAs({
      method: 'PATCH',
      url: `/items/${directusEventAttendeesCollection}/${req.params.attendeeId}`,
      data: {
        checkin_status: 'checked_in',
        checked_in_at: new Date().toISOString(),
        checked_in_by: req.auth.sub,
      },
    }, req.auth.directusToken);

    res.json({ data: data?.data });
  } catch (error) {
    next(error);
  }
});

app.patch('/admin/events/:eventId/attendees/:attendeeId/uncheckin', requireAdmin, async (req, res, next) => {
  try {
    const { data } = await directusRequestAs({
      method: 'PATCH',
      url: `/items/${directusEventAttendeesCollection}/${req.params.attendeeId}`,
      data: {
        checkin_status: 'registered',
        checked_in_at: null,
        checked_in_by: null,
      },
    }, req.auth.directusToken);

    res.json({ data: data?.data });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/events/:id/walkin', requireAdmin, async (req, res, next) => {
  try {
    const { name, email, phone, ticket_type } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const nameParts = name.trim().split(' ');
    const firstName = nameParts[0] ?? '';
    const lastName = nameParts.slice(1).join(' ') || firstName;

    // Resolve a ticket id for the given ticket_type (name match)
    let ticketIdValue = null;
    try {
      const ticketRes = await directusRequestAs({
        method: 'GET',
        url: `/items/${directusEventTicketsCollection}`,
        params: {
          'filter[event_id][_eq]': req.params.id,
          'filter[name][_eq]': (ticket_type || 'REGULAR').toUpperCase(),
          limit: 1,
          fields: 'id',
        },
      }, req.auth.directusToken);
      ticketIdValue = ticketRes.data?.data?.[0]?.id ?? null;
    } catch {
      // non-fatal, proceed without a ticket id
    }

    const payload = {
      event_id: req.params.id,
      holder_first_name: firstName,
      holder_last_name: lastName,
      holder_email: email?.trim() || null,
      phone: phone?.trim() || null,
      jci_chapter: null,
      ticket_id: ticketIdValue,
      checkin_status: 'checked_in',
      checked_in_at: new Date().toISOString(),
      checked_in_by: req.auth.sub,
      is_walkin: true,
    };

    const { data } = await directusRequestAs({
      method: 'POST',
      url: `/items/${directusEventAttendeesCollection}`,
      data: payload,
    }, req.auth.directusToken);

    res.status(201).json({ data: data?.data });
  } catch (error) {
    next(error);
  }
});

// ─── Admin Mobile: Event Settings ───────────────────────────────────────────

app.get('/admin/events/:id/settings', requireAdmin, async (req, res, next) => {
  try {
    const [settingsData, fieldsData] = await Promise.all([
      directusRequestAs({
        method: 'GET',
        url: '/items/event_checkout_settings',
        params: {
          'filter[event_id][_eq]': req.params.id,
          fields: 'id,form_mode,max_tickets_per_order,checkout_time_limit_minutes,registration_status,registration_visibility,currency,tax_mode,require_login,allow_guest_checkout',
          limit: 1,
        },
      }, req.auth.directusToken).then(r => (r.data?.data || [])[0] || null).catch(() => null),
      directusRequestAs({
        method: 'GET',
        url: '/items/event_form_fields',
        params: {
          'filter[event_id][_eq]': req.params.id,
          'filter[active][_neq]': false,
          fields: 'id,scope,field_key,label,field_type,required,locked,sort,ticket_id',
          sort: 'sort',
          limit: 1000,
        },
      }, req.auth.directusToken).then(r => r.data?.data || []).catch(() => []),
    ]);

    res.json({ settings: settingsData, form_fields: fieldsData });
  } catch (error) {
    next(error);
  }
});

app.patch('/admin/events/:id/settings', requireAdmin, async (req, res, next) => {
  try {
    const body = req.body || {};

    // Check if settings exist
    const { data: existing } = await directusRequestAs({
      method: 'GET',
      url: '/items/event_checkout_settings',
      params: {
        'filter[event_id][_eq]': req.params.id,
        fields: 'id',
        limit: 1,
      },
    }, req.auth.directusToken);

    const existingId = existing?.data?.[0]?.id;
    const allowedFields = ['form_mode', 'max_tickets_per_order', 'checkout_time_limit_minutes', 'registration_status', 'registration_visibility', 'currency', 'tax_mode', 'require_login', 'allow_guest_checkout'];
    const payload = {};
    for (const f of allowedFields) {
      if (body.hasOwnProperty(f)) payload[f] = body[f];
    }

    let result;
    if (existingId) {
      const { data } = await directusRequestAs({
        method: 'PATCH',
        url: `/items/event_checkout_settings/${existingId}`,
        data: payload,
      }, req.auth.directusToken);
      result = data?.data;
    } else {
      const { data } = await directusRequestAs({
        method: 'POST',
        url: '/items/event_checkout_settings',
        data: { ...payload, event_id: req.params.id, currency: 'IDR', tax_mode: 'none' },
      }, req.auth.directusToken);
      result = data?.data;
    }

    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

// ─── Admin Mobile: Event Features ───────────────────────────────────────────

app.get('/admin/events/:id/features', requireAdmin, async (req, res, next) => {
  try {
    const [catalogData, assignedData] = await Promise.all([
      directusRequestAs({
        method: 'GET',
        url: '/items/event_features',
        params: { fields: 'id,key,name,description,active', limit: 50 },
      }, req.auth.directusToken).then(r => r.data?.data || []).catch(() => []),
      directusRequestAs({
        method: 'GET',
        url: '/items/events_features',
        params: {
          'filter[event_id][_eq]': req.params.id,
          fields: 'id,feature_id,enabled,config_json',
          limit: 50,
        },
      }, req.auth.directusToken).then(r => r.data?.data || []).catch(() => []),
    ]);

    // Merge: mark which features are added to this event
    const assignedMap = {};
    for (const a of assignedData) {
      assignedMap[a.feature_id] = a;
    }

    const features = catalogData.filter(f => f.active !== false).map(f => ({
      ...f,
      assigned: !!assignedMap[f.id],
      assignment_id: assignedMap[f.id]?.id || null,
      enabled: assignedMap[f.id]?.enabled ?? false,
      config_json: assignedMap[f.id]?.config_json || null,
    }));

    res.json({ data: features });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/events/:id/features/:featureId/add', requireAdmin, async (req, res, next) => {
  try {
    const { data } = await directusRequestAs({
      method: 'POST',
      url: '/items/events_features',
      data: {
        event_id: req.params.id,
        feature_id: req.params.featureId,
        enabled: true,
      },
    }, req.auth.directusToken);
    res.status(201).json({ data: data?.data });
  } catch (error) {
    next(error);
  }
});

app.delete('/admin/events/:id/features/:assignmentId/remove', requireAdmin, async (req, res, next) => {
  try {
    await directusRequestAs({
      method: 'DELETE',
      url: `/items/events_features/${req.params.assignmentId}`,
    }, req.auth.directusToken);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ─── Admin Mobile: Single Member ─────────────────────────────────────────────

app.get('/admin/members/:id', requireAdmin, async (req, res, next) => {
  try {
    const [memberData, eventCount, referralCount] = await Promise.all([
      directusRequestAs({
        method: 'GET',
        url: `/items/${membersCollection}/${req.params.id}`,
        params: {
          fields: [
            'id','first_name','last_name','email','phone','subscribed','subscribed_until',
            'deactived','member_id','join_date','is_admin','job_title','point',
            'referred_by','referral_chapter','referral_name',
            'dob','gender','marital','religion','education','uniform_size','dietary_restriction',
            'company_name','industry','business_website','instagram',
            'know_jci_from','public','notes',
            'address','address_kota','address_kode_pos',
          ].join(','),
        },
      }, req.auth.directusToken).then(r => r.data?.data || null),
      directusRequestAs({
        method: 'GET',
        url: '/items/event_attendees',
        params: {
          'filter[profile_id][_eq]': req.params.id,
          'aggregate[count]': 'id',
          limit: 1,
        },
      }, req.auth.directusToken).then(r => Number(r.data?.data?.[0]?.count?.id || 0)).catch(() => 0),
      directusRequestAs({
        method: 'GET',
        url: `/items/${membersCollection}`,
        params: {
          'filter[referred_by][_eq]': req.params.id,
          'aggregate[count]': 'id',
          limit: 1,
        },
      }, req.auth.directusToken).then(r => Number(r.data?.data?.[0]?.count?.id || 0)).catch(() => 0),
    ]);

    if (!memberData) return res.status(404).json({ error: 'Member not found' });

    res.json({ data: normalizeMember({ ...memberData, total_events: eventCount, total_referrals: referralCount }) });
  } catch (error) {
    next(error);
  }
});

// ─── Admin Mobile: Member Points ──────────────────────────────────────────────

app.get('/admin/members/:id/points', requireAdmin, async (req, res, next) => {
  try {
    const { data } = await directusRequestAs({
      method: 'GET',
      url: '/items/member_points',
      params: {
        'filter[profile_id][_eq]': req.params.id,
        fields: 'id,type,points,description,date_created',
        sort: '-date_created',
        limit: 200,
      },
    }, req.auth.directusToken);
    res.json({ data: Array.isArray(data?.data) ? data.data : [] });
  } catch (error) {
    next(error);
  }
});

// ─── Admin Mobile: Member Training ────────────────────────────────────────────

app.get('/admin/members/:id/training', requireAdmin, async (req, res, next) => {
  try {
    const { data } = await directusRequestAs({
      method: 'GET',
      url: '/items/member_training_records',
      params: {
        'filter[member_id][_eq]': req.params.id,
        fields: 'id,training_id.title,training_id.code,training_id.level,attended,passed,score,certificate_number,date_created',
        sort: '-date_created',
        limit: 100,
      },
    }, req.auth.directusToken);
    res.json({ data: Array.isArray(data?.data) ? data.data : [] });
  } catch (error) {
    next(error);
  }
});

// ─── Admin Mobile: Member Experiences (Officership) ───────────────────────────

app.get('/admin/members/:id/experiences', requireAdmin, async (req, res, next) => {
  try {
    const { data } = await directusRequestAs({
      method: 'GET',
      url: '/items/experiences',
      params: {
        'filter[profile_id][_eq]': req.params.id,
        'filter[deleted][_neq]': true,
        fields: 'id,name,role_type,chapters,startdate,enddate,status,verified,description,points',
        sort: '-startdate',
        limit: 100,
      },
    }, req.auth.directusToken);
    res.json({ data: Array.isArray(data?.data) ? data.data : [] });
  } catch (error) {
    next(error);
  }
});

// ─── Admin Mobile: Member Activity ────────────────────────────────────────────

app.get('/admin/members/:id/activity', requireAdmin, async (req, res, next) => {
  try {
    const [expData, attendeeData] = await Promise.all([
      directusRequestAs({
        method: 'GET',
        url: '/items/experiences',
        params: {
          'filter[profile_id][_eq]': req.params.id,
          'filter[deleted][_neq]': true,
          fields: 'id,name,role_type,chapters,startdate,status',
          sort: '-startdate',
          limit: 100,
        },
      }, req.auth.directusToken).then(r => Array.isArray(r.data?.data) ? r.data.data : []).catch(() => []),
      directusRequestAs({
        method: 'GET',
        url: '/items/event_attendees',
        params: {
          'filter[profile_id][_eq]': req.params.id,
          fields: 'id,event_id,checkin_status,checked_in_at,jci_chapter',
          sort: '-checked_in_at',
          limit: 100,
        },
      }, req.auth.directusToken).then(r => Array.isArray(r.data?.data) ? r.data.data : []).catch(() => []),
    ]);

    // Enrich attendees with event titles
    const eventIds = [...new Set(attendeeData.map(a => a.event_id).filter(Boolean))];
    let eventMap = {};
    if (eventIds.length > 0) {
      const evData = await directusRequestAs({
        method: 'GET',
        url: '/items/events',
        params: {
          'filter[id][_in]': eventIds.join(','),
          fields: 'id,title,start_date',
          limit: eventIds.length,
        },
      }, req.auth.directusToken).then(r => Array.isArray(r.data?.data) ? r.data.data : []).catch(() => []);
      evData.forEach(e => { eventMap[e.id] = e; });
    }

    const enrichedAttendees = attendeeData.map(a => ({
      ...a,
      event_title: eventMap[a.event_id]?.title || null,
      event_date: eventMap[a.event_id]?.start_date || a.checked_in_at || null,
    }));

    res.json({ experiences: expData, attendees: enrichedAttendees });
  } catch (error) {
    next(error);
  }
});

// ─── Admin Mobile: Member Tags & Interests ────────────────────────────────────

app.get('/admin/members/:id/tags', requireAdmin, async (req, res, next) => {
  try {
    const { data } = await directusRequestAs({
      method: 'GET',
      url: '/items/member_tags',
      params: {
        'filter[profile_id][_eq]': req.params.id,
        fields: 'id,category,value',
        limit: 200,
      },
    }, req.auth.directusToken);
    res.json({ data: Array.isArray(data?.data) ? data.data : [] });
  } catch (error) {
    next(error);
  }
});

// ─── Admin Mobile: Member Referrals ───────────────────────────────────────────

app.get('/admin/members/:id/referrals', requireAdmin, async (req, res, next) => {
  try {
    // First get the member to find their referred_by
    const memberData = await directusRequestAs({
      method: 'GET',
      url: `/items/${membersCollection}/${req.params.id}`,
      params: { fields: 'id,referred_by,referral_chapter,referral_name' },
    }, req.auth.directusToken).then(r => r.data?.data || null).catch(() => null);

    const [recruitedData, referrerData] = await Promise.all([
      // Members this person recruited
      directusRequestAs({
        method: 'GET',
        url: `/items/${membersCollection}`,
        params: {
          'filter[referred_by][_eq]': req.params.id,
          fields: 'id,first_name,last_name,email,subscribed,join_date',
          sort: '-join_date',
          limit: 100,
        },
      }, req.auth.directusToken).then(r => Array.isArray(r.data?.data) ? r.data.data : []).catch(() => []),
      // Who referred this person
      memberData?.referred_by
        ? directusRequestAs({
            method: 'GET',
            url: `/items/${membersCollection}/${memberData.referred_by}`,
            params: { fields: 'id,first_name,last_name,email' },
          }, req.auth.directusToken).then(r => r.data?.data || null).catch(() => null)
        : Promise.resolve(null),
    ]);

    res.json({
      referredBy: referrerData
        ? { id: referrerData.id, name: [referrerData.first_name, referrerData.last_name].filter(Boolean).join(' '), email: referrerData.email }
        : memberData?.referral_name
          ? { name: memberData.referral_name, chapter: memberData.referral_chapter }
          : null,
      recruited: recruitedData.map(m => ({
        id: m.id,
        name: [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || m.email,
        email: m.email,
        status: m.subscribed === true ? 'active' : 'expired',
        joinDate: m.join_date,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// ─── Admin Mobile: Member Membership History ──────────────────────────────────

app.get('/admin/members/:id/memberships', requireAdmin, async (req, res, next) => {
  try {
    const { data } = await directusRequestAs({
      method: 'GET',
      url: '/items/membership_history',
      params: {
        'filter[profile_id][_eq]': req.params.id,
        fields: 'id,year,membership_type,category,price,status,payment_method,payment_reference,valid_from,valid_until,paid_at,notes',
        sort: '-year',
        limit: 50,
      },
    }, req.auth.directusToken);
    res.json({ data: Array.isArray(data?.data) ? data.data : [] });
  } catch (error) {
    next(error);
  }
});

// ─── Admin Mobile: Experience Approvals ──────────────────────────────────────

app.get('/admin/experiences', requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const statusFilter = String(req.query.status || 'pending').trim();

    const params = {
      limit,
      sort: '-created_at',
      fields: [
        'id',
        'name',
        'status',
        'points',
        'role_type',
        'description',
        'created_at',
        'profile_id.id',
        'profile_id.first_name',
        'profile_id.last_name',
      ].join(','),
    };

    if (statusFilter !== 'all') {
      params['filter[status][_eq]'] = statusFilter;
    }

    const { data } = await directusRequestAs({
      method: 'GET',
      url: '/items/experiences',
      params,
    }, req.auth.directusToken);

    res.json({ data: Array.isArray(data?.data) ? data.data : [] });
  } catch (error) {
    next(error);
  }
});

app.patch('/admin/experiences/:id/approve', requireAdmin, async (req, res, next) => {
  try {
    const { data } = await directusRequestAs({
      method: 'PATCH',
      url: `/items/experiences/${req.params.id}`,
      data: {
        status: 'approved',
        reviewed_by: req.auth.sub,
        reviewed_at: new Date().toISOString(),
      },
    }, req.auth.directusToken);

    res.json({ data: data?.data });
  } catch (error) {
    next(error);
  }
});

app.patch('/admin/experiences/:id/reject', requireAdmin, async (req, res, next) => {
  try {
    const { data } = await directusRequestAs({
      method: 'PATCH',
      url: `/items/experiences/${req.params.id}`,
      data: {
        status: 'rejected',
        reviewed_by: req.auth.sub,
        reviewed_at: new Date().toISOString(),
      },
    }, req.auth.directusToken);

    res.json({ data: data?.data });
  } catch (error) {
    next(error);
  }
});

// ─── Admin Mobile: Business Verifications ────────────────────────────────────

app.get('/admin/businesses', requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const statusFilter = String(req.query.status || 'pending').trim();

    const params = {
      limit,
      sort: '-created_at',
      fields: [
        'id',
        'name',
        'verified',
        'introduction',
        'website',
        'created_at',
        'profile_id.id',
        'profile_id.first_name',
        'profile_id.last_name',
        'businesscategory_id.id',
        'businesscategory_id.name',
      ].join(','),
    };

    if (statusFilter === 'pending') {
      params['filter[verified][_null]'] = true;
    } else if (statusFilter === 'verified') {
      params['filter[verified][_eq]'] = true;
    } else if (statusFilter === 'rejected') {
      params['filter[verified][_eq]'] = false;
    }
    // 'all' → no filter

    const { data } = await directusRequestAs({
      method: 'GET',
      url: '/items/businesses',
      params,
    }, req.auth.directusToken);

    res.json({ data: Array.isArray(data?.data) ? data.data : [] });
  } catch (error) {
    next(error);
  }
});

app.patch('/admin/businesses/:id/verify', requireAdmin, async (req, res, next) => {
  try {
    const { data } = await directusRequestAs({
      method: 'PATCH',
      url: `/items/businesses/${req.params.id}`,
      data: {
        verified: true,
        verified_by: req.auth.sub,
        verified_at: new Date().toISOString(),
      },
    }, req.auth.directusToken);

    res.json({ data: data?.data });
  } catch (error) {
    next(error);
  }
});

app.patch('/admin/businesses/:id/reject', requireAdmin, async (req, res, next) => {
  try {
    const { data } = await directusRequestAs({
      method: 'PATCH',
      url: `/items/businesses/${req.params.id}`,
      data: {
        verified: false,
        verified_by: req.auth.sub,
        verified_at: new Date().toISOString(),
      },
    }, req.auth.directusToken);

    res.json({ data: data?.data });
  } catch (error) {
    next(error);
  }
});

// ─── Admin Mobile: Event Schedule CRUD ──────────────────────────────────────

app.get('/admin/events/:id/schedule', requireAdmin, async (req, res, next) => {
  try {
    const { data } = await directusRequestAs({
      method: 'GET',
      url: '/items/event_schedule_items',
      params: {
        'filter[event_id][_eq]': req.params.id,
        fields: 'id,name,start_at,end_at,place,tags,description,sort,hidden,canceled,status',
        sort: 'start_at',
        limit: 500,
      },
    }, req.auth.directusToken);

    res.json({ data: data?.data || [] });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/events/:id/schedule', requireAdmin, async (req, res, next) => {
  try {
    const { name, start_at, end_at, place, tags, description } = req.body || {};
    if (!name || !start_at || !end_at) {
      return res.status(400).json({ error: 'name, start_at, and end_at are required' });
    }

    const { data } = await directusRequestAs({
      method: 'POST',
      url: '/items/event_schedule_items',
      data: {
        event_id: req.params.id,
        name,
        start_at,
        end_at,
        place: place || null,
        tags: tags || null,
        description: description || null,
        status: 'published',
        hidden: false,
        canceled: false,
      },
    }, req.auth.directusToken);

    res.status(201).json({ data: data?.data });
  } catch (error) {
    next(error);
  }
});

app.patch('/admin/events/:id/schedule/:itemId', requireAdmin, async (req, res, next) => {
  try {
    const allowed = ['name', 'start_at', 'end_at', 'place', 'tags', 'description', 'sort', 'hidden', 'canceled', 'status'];
    const payload = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        payload[key] = req.body[key];
      }
    }

    const { data } = await directusRequestAs({
      method: 'PATCH',
      url: `/items/event_schedule_items/${req.params.itemId}`,
      data: payload,
    }, req.auth.directusToken);

    res.json({ data: data?.data });
  } catch (error) {
    next(error);
  }
});

app.delete('/admin/events/:id/schedule/:itemId', requireAdmin, async (req, res, next) => {
  try {
    await directusRequestAs({
      method: 'DELETE',
      url: `/items/event_schedule_items/${req.params.itemId}`,
    }, req.auth.directusToken);

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ─── Admin Mobile: Event Lineup Config ──────────────────────────────────────

app.get('/admin/events/:id/lineup', requireAdmin, async (req, res, next) => {
  try {
    // First get the feature_id for 'lineup' from the catalog
    const catalogRes = await directusRequestAs({
      method: 'GET',
      url: '/items/event_features',
      params: { 'filter[key][_eq]': 'lineup', fields: 'id', limit: 1 },
    }, req.auth.directusToken);
    const featureCatalog = catalogRes.data?.data || [];
    if (!featureCatalog.length) {
      return res.json({ data: { speakers: [] } });
    }
    const lineupFeatureId = featureCatalog[0].id;

    // Now get the events_features record for this event + feature
    const assignRes = await directusRequestAs({
      method: 'GET',
      url: '/items/events_features',
      params: {
        'filter[event_id][_eq]': req.params.id,
        'filter[feature_id][_eq]': lineupFeatureId,
        fields: 'id,config_json',
        limit: 1,
      },
    }, req.auth.directusToken);
    const assigned = (assignRes.data?.data || [])[0];

    if (!assigned) {
      return res.json({ data: { speakers: [], assignment_id: null } });
    }

    const config = assigned.config_json || {};
    res.json({
      data: {
        speakers: Array.isArray(config.speakers) ? config.speakers : [],
        assignment_id: assigned.id,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.patch('/admin/events/:id/lineup', requireAdmin, async (req, res, next) => {
  try {
    const { speakers } = req.body || {};
    if (!Array.isArray(speakers)) {
      return res.status(400).json({ error: 'speakers must be an array' });
    }

    // Get feature_id for lineup
    const catalogRes = await directusRequestAs({
      method: 'GET',
      url: '/items/event_features',
      params: { 'filter[key][_eq]': 'lineup', fields: 'id', limit: 1 },
    }, req.auth.directusToken);
    const featureCatalog = catalogRes.data?.data || [];
    if (!featureCatalog.length) {
      return res.status(404).json({ error: 'Lineup feature not found in catalog' });
    }
    const lineupFeatureId = featureCatalog[0].id;

    // Find the assignment
    const assignRes = await directusRequestAs({
      method: 'GET',
      url: '/items/events_features',
      params: {
        'filter[event_id][_eq]': req.params.id,
        'filter[feature_id][_eq]': lineupFeatureId,
        fields: 'id,config_json',
        limit: 1,
      },
    }, req.auth.directusToken);
    const assigned = (assignRes.data?.data || [])[0];

    if (!assigned) {
      return res.status(404).json({ error: 'Lineup feature not assigned to this event' });
    }

    // Update config_json
    const { data } = await directusRequestAs({
      method: 'PATCH',
      url: `/items/events_features/${assigned.id}`,
      data: { config_json: { speakers } },
    }, req.auth.directusToken);

    res.json({ data: data?.data });
  } catch (error) {
    next(error);
  }
});

// ─── Admin Mobile: Event Video Conference Config ────────────────────────────

app.get('/admin/events/:id/video-config', requireAdmin, async (req, res, next) => {
  try {
    // Get feature_id for video_conference
    const catalogRes = await directusRequestAs({
      method: 'GET',
      url: '/items/event_features',
      params: { 'filter[key][_eq]': 'video_conference', fields: 'id', limit: 1 },
    }, req.auth.directusToken);
    const featureCatalog = catalogRes.data?.data || [];
    if (!featureCatalog.length) {
      return res.json({ data: { provider: null, url: null } });
    }
    const videoFeatureId = featureCatalog[0].id;

    // Find the assignment
    const assignRes = await directusRequestAs({
      method: 'GET',
      url: '/items/events_features',
      params: {
        'filter[event_id][_eq]': req.params.id,
        'filter[feature_id][_eq]': videoFeatureId,
        fields: 'id,config_json',
        limit: 1,
      },
    }, req.auth.directusToken);
    const assigned = (assignRes.data?.data || [])[0];

    if (!assigned) {
      return res.json({ data: { provider: null, url: null, assignment_id: null } });
    }

    const config = assigned.config_json || {};
    res.json({
      data: {
        provider: config.provider || null,
        url: config.url || null,
        assignment_id: assigned.id,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.patch('/admin/events/:id/video-config', requireAdmin, async (req, res, next) => {
  try {
    const { provider, url } = req.body || {};

    // Get feature_id for video_conference
    const catalogRes = await directusRequestAs({
      method: 'GET',
      url: '/items/event_features',
      params: { 'filter[key][_eq]': 'video_conference', fields: 'id', limit: 1 },
    }, req.auth.directusToken);
    const featureCatalog = catalogRes.data?.data || [];
    if (!featureCatalog.length) {
      return res.status(404).json({ error: 'Video conference feature not found in catalog' });
    }
    const videoFeatureId = featureCatalog[0].id;

    // Find the assignment
    const assignRes = await directusRequestAs({
      method: 'GET',
      url: '/items/events_features',
      params: {
        'filter[event_id][_eq]': req.params.id,
        'filter[feature_id][_eq]': videoFeatureId,
        fields: 'id,config_json',
        limit: 1,
      },
    }, req.auth.directusToken);
    const assigned = (assignRes.data?.data || [])[0];

    if (!assigned) {
      return res.status(404).json({ error: 'Video conference feature not assigned to this event' });
    }

    // Update config_json on events_features
    await directusRequestAs({
      method: 'PATCH',
      url: `/items/events_features/${assigned.id}`,
      data: { config_json: { provider: provider || null, url: url || null } },
    }, req.auth.directusToken);

    // Also update events.online_meeting_url
    await directusRequestAs({
      method: 'PATCH',
      url: `/items/${directusEventsCollection}/${req.params.id}`,
      data: { online_meeting_url: url || null },
    }, req.auth.directusToken).catch(() => {});

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ─────────────────────────────────────────────────────────────────────────────

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
