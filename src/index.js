import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import crypto from 'node:crypto';

import { verifyBearerToken, requireAdmin } from './auth.js';
import { directusRequest } from './directus.js';
import { canProvisionPaidOrder, ensureWorkspaceUser, isGoogleWorkspaceProvisioningEnabled } from './google-workspace.js';
import { runEventTicketSync } from './sync-event-tickets-saleor.js';
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

  const syncSummary = eventIdsToClose.size > 0
    ? await runEventTicketSync({ dryRun: false, trigger: 'event_auto_archive' })
    : null;

  return {
    eventsClosed: eventsToClose.length,
    ticketsArchived: ticketsToArchive.length,
    syncSummary,
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

async function fetchEventTicketMappings() {
  return readDirectusItems(directusEventTicketsCollection, {
    limit: -1,
    fields: 'id,name,event_id,saleor_variant_id,saleor_sku',
  });
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
  const orderCommerce = await getOrderCommerceContext(orderCode);
  if (!orderCommerce) {
    return { projected: false, reason: 'saleor_order_context_not_found', orderCode };
  }

  const directusTickets = await fetchEventTicketMappings();
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

  if (checkoutSession?.id) {
    await updateDirectusItem(directusEventCheckoutSessionsCollection, checkoutSession.id, {
      status: 'projected',
      saleor_order_id: String(orderCommerce?.id || '').trim() || null,
      saleor_order_number: String(orderCommerce?.code || '').trim() || null,
      payment_reference: String(transactionId || orderCommerce?.paymentTransactionId || '').trim() || null,
      projected_at: new Date().toISOString(),
    });
  }

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

async function handleEventCheckoutProcessPayment(req, res, next) {
  try {
    const checkoutId = String(req.body?.checkoutId || '').trim();
    const checkoutToken = String(req.body?.checkoutToken || '').trim();
    const explicitTransactionId = String(req.body?.transactionId || '').trim();

    if (!checkoutId && !checkoutToken) {
      return res.status(400).json({ error: 'checkoutId or checkoutToken is required' });
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
      const eventProjection = existingOrderCode
        ? await projectSaleorEventOrderToDirectus({
            orderCode: existingOrderCode,
            transactionId: existingTransactionId,
            repairOnly: true,
          })
        : null;
      return res.status(200).json({
        success: true,
        finalized: true,
        alreadyFinalized: true,
        checkoutSessionId: checkoutSession.id,
        orderCode: existingOrderCode,
        orderId: checkoutSession.saleor_order_id || null,
        transactionId: existingTransactionId,
        ticketAccessToken,
        eventProjection,
      });
    }

    const transactionId =
      explicitTransactionId ||
      String(checkoutSession.payment_reference || '').trim();
    if (!transactionId) {
      return res.status(409).json({ error: 'Transaction ID is missing for checkout session' });
    }

    const processedTransaction = await processTransaction({
      id: transactionId,
    });
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

    const billingAddressUpdate = await updateCheckoutBillingAddress({
      id: checkoutId || checkoutSession.saleor_order_id,
      billingAddress: buildFallbackBillingAddress({
        customerEmail: checkoutSession.customer_email,
        storedPayload: checkoutSession.payload_json,
      }),
    });
    if (Array.isArray(billingAddressUpdate?.errors) && billingAddressUpdate.errors.length > 0) {
      return res.status(409).json({
        error: billingAddressUpdate.errors[0]?.message || 'Unable to set billing address for checkout',
        code: billingAddressUpdate.errors[0]?.code || 'CHECKOUT_BILLING_ADDRESS_FAILED',
      });
    }

    const completedCheckout = await completeCheckout({
      id: checkoutId || checkoutSession.saleor_order_id,
    });
    if (Array.isArray(completedCheckout?.errors) && completedCheckout.errors.length > 0) {
      return res.status(409).json({
        error: completedCheckout.errors[0]?.message || 'Unable to complete checkout',
        code: completedCheckout.errors[0]?.code || 'CHECKOUT_COMPLETE_FAILED',
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

    const eventProjection = await projectSaleorEventOrderToDirectus({
      orderCode: completedCheckout.order.code,
      transactionId: String(processedTransaction?.transaction?.pspReference || transactionId).trim() || transactionId,
    });

    const ticketAccessToken = createTicketAccessToken({
      orderCode: completedCheckout.order.code,
      eventId: checkoutSession.event_id || null,
      email: checkoutSession.customer_email || null,
      expMs: Date.now() + (ticketAccessTtlDays * 24 * 60 * 60 * 1000),
    });

    return res.status(200).json({
      success: true,
      finalized: true,
      checkoutSessionId: checkoutSession.id,
      orderCode: completedCheckout.order.code,
      orderId: completedCheckout.order.id,
      transactionId,
      transactionEventType,
      ticketAccessToken,
      eventProjection,
    });
  } catch (error) {
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

app.use(async (req, _res, next) => {
  const isWebhookRequest = req.path.startsWith('/webhooks');
  if (req.path === '/health' || isWebhookRequest || isPublicRegistrationRoute(req)) {
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
    req.auth = await verifyBearerToken(req.headers.authorization);
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

app.post('/webhooks/directus/event-tickets-sync', async (req, res, next) => {
  try {
    if (!directusSyncWebhookSecret) {
      return res.status(503).json({ error: 'DIRECTUS_SYNC_WEBHOOK_SECRET is not configured' });
    }

    if (!isValidSyncWebhookSecret(req)) {
      return res.status(401).json({ error: 'Invalid sync webhook secret' });
    }

    const dryRun = parseBoolean(req.body?.dryRun);
    const summary = await runEventTicketSync({ dryRun, trigger: 'directus_webhook' });
    return res.status(200).json({ success: true, summary });
  } catch (error) {
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

app.post('/dev/sync/event-tickets', requireAdmin, async (req, res, next) => {
  try {
    const dryRun = parseBoolean(req.body?.dryRun);
    const summary = await runEventTicketSync({ dryRun, trigger: 'api' });
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
