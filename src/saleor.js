import axios from 'axios';

const saleorApiUrl = process.env.SALEOR_API_URL || process.env.SALEOR_ADMIN_API_URL;
const saleorApiToken = process.env.SALEOR_API_TOKEN || process.env.SALEOR_ADMIN_API_TOKEN;
const saleorEmail = process.env.SALEOR_EMAIL || '';
const saleorPassword = process.env.SALEOR_PASSWORD || '';
const saleorChannelId = process.env.SALEOR_CHANNEL_ID || '';

const SALEOR_REQUEST_TIMEOUT_MS = Number(process.env.SALEOR_REQUEST_TIMEOUT_MS) || 20_000;

const saleor = axios.create({
  baseURL: saleorApiUrl || '',
  timeout: SALEOR_REQUEST_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
  },
});

let cachedUserToken = '';
let cachedUserTokenExpMs = 0;

function getOperationName(query) {
  const match = String(query || '').match(/\b(?:mutation|query)\s+([A-Za-z0-9_]+)/);
  return match?.[1] || 'AnonymousOperation';
}

function decodeJwtExpMs(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return 0;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    const exp = Number(json?.exp || 0);
    return Number.isFinite(exp) ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function createUserAccessToken() {
  if (!saleorApiUrl) {
    throw new Error('SALEOR_API_URL is required');
  }
  if (!saleorEmail || !saleorPassword) {
    throw new Error('SALEOR_EMAIL and SALEOR_PASSWORD are required to create Saleor token');
  }

  const mutation = `
    mutation TokenCreate($email:String!, $password:String!) {
      tokenCreate(email:$email, password:$password) {
        token
        errors {
          field
          code
          message
        }
      }
    }
  `;

  const { data } = await saleor.post('', {
    query: mutation,
    variables: {
      email: saleorEmail,
      password: saleorPassword,
    },
  });

  if (Array.isArray(data?.errors) && data.errors.length) {
    throw new Error(`Saleor GraphQL error: ${data.errors.map((item) => item.message).join('; ')}`);
  }

  const token = data?.data?.tokenCreate?.token || '';
  const errors = Array.isArray(data?.data?.tokenCreate?.errors) ? data.data.tokenCreate.errors : [];
  if (errors.length) {
    const message = errors.map((item) => `${item.code || 'ERR'} ${item.message || ''}`.trim()).join('; ');
    throw new Error(`Saleor tokenCreate failed: ${message}`);
  }

  if (!token) {
    throw new Error('Saleor tokenCreate did not return token');
  }

  cachedUserToken = token;
  cachedUserTokenExpMs = decodeJwtExpMs(token);
  return token;
}

async function getAuthorizationToken({ forceRefresh = false } = {}) {
  if (saleorEmail && saleorPassword) {
    const now = Date.now();
    const stillValid = cachedUserToken && cachedUserTokenExpMs > now + 15000;
    if (forceRefresh || !stillValid) {
      return createUserAccessToken();
    }
    return cachedUserToken;
  }

  return saleorApiToken;
}

async function doRequest(query, variables = {}, token) {
  if (!saleorApiUrl) {
    throw new Error('SALEOR_API_URL is required');
  }
  if (!token) {
    throw new Error('Provide SALEOR_API_TOKEN or SALEOR_EMAIL + SALEOR_PASSWORD');
  }

  const startedAt = Date.now();
  const operationName = getOperationName(query);
  const { data } = await saleor.post(
    '',
    { query, variables },
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );
  console.info(JSON.stringify({
    scope: 'saleor-graphql',
    operation: operationName,
    durationMs: Date.now() - startedAt,
  }));

  if (Array.isArray(data?.errors) && data.errors.length) {
    const message = data.errors.map((item) => item.message).join('; ');
    throw new Error(`Saleor GraphQL error: ${message}`);
  }

  return data?.data;
}

async function request(query, variables = {}) {
  const token = await getAuthorizationToken();

  try {
    return await doRequest(query, variables, token);
  } catch (error) {
    const message = String(error?.message || '');
    const shouldRetryWithFreshToken =
      Boolean(saleorEmail && saleorPassword) &&
      (message.includes('Signature has expired') || message.includes('Invalid token'));

    if (!shouldRetryWithFreshToken) {
      throw error;
    }

    const freshToken = await getAuthorizationToken({ forceRefresh: true });
    return doRequest(query, variables, freshToken);
  }
}

function normalizeOrderNode(node) {
  if (!node) return null;

  return {
    id: node.id,
    code: String(node.number || ''),
    state: node.status || null,
    currencyCode: node.total?.gross?.currency || null,
    totalWithTax: Number(node.total?.gross?.amount || 0),
    isPaid: Boolean(node.isPaid),
    payments: Array.isArray(node.transactions)
      ? node.transactions.map((transaction) => ({
          id: transaction.id,
          state:
            Number(transaction?.chargedAmount?.amount || 0) > 0
              ? 'Settled'
              : Number(transaction?.authorizedAmount?.amount || 0) > 0
                ? 'Authorized'
                : 'Created',
          transactionId: transaction.pspReference || '',
        }))
      : [],
  };
}

function normalizeOrderProvisioningNode(node) {
  if (!node) return null;
  const lines = Array.isArray(node.lines)
    ? node.lines.map((line) => ({
        productName: line?.productName || '',
        variantName: line?.variantName || '',
        sku: line?.productSku || '',
        productSlug: line?.variant?.product?.slug || '',
      }))
    : [];

  return {
    id: node.id,
    code: String(node.number || ''),
    state: node.status || null,
    isPaid: Boolean(node.isPaid),
    userEmail: String(
      node?.userEmail || node?.billingAddress?.email || node?.shippingAddress?.email || ''
    ).trim(),
    firstName: String(
      node?.billingAddress?.firstName || node?.shippingAddress?.firstName || ''
    ).trim(),
    lastName: String(
      node?.billingAddress?.lastName || node?.shippingAddress?.lastName || ''
    ).trim(),
    lines,
  };
}

function metadataArrayToObject(items) {
  const out = {};
  for (const item of Array.isArray(items) ? items : []) {
    const key = String(item?.key || '').trim();
    if (!key) continue;
    out[key] = item?.value ?? null;
  }
  return out;
}

function normalizeOrderCommerceNode(node) {
  if (!node) return null;

  const lines = Array.isArray(node.lines)
    ? node.lines.map((line) => ({
        id: line?.id || null,
        quantity: Number(line?.quantity || 0),
        sku: String(line?.productSku || line?.variant?.sku || '').trim(),
        productName: line?.productName || '',
        variantName: line?.variantName || '',
        unitAmount: Number(line?.unitPrice?.gross?.amount || 0),
        lineAmount: Number(line?.totalPrice?.gross?.amount || 0),
        currencyCode:
          line?.totalPrice?.gross?.currency ||
          line?.unitPrice?.gross?.currency ||
          node?.total?.gross?.currency ||
          null,
        variantId: line?.variant?.id || null,
        productId: line?.variant?.product?.id || null,
        productSlug: line?.variant?.product?.slug || '',
        productMetadata: metadataArrayToObject(line?.variant?.product?.metadata),
        variantMetadata: metadataArrayToObject(line?.variant?.metadata),
      }))
    : [];

  return {
    id: node.id,
    code: String(node.number || ''),
    state: node.status || null,
    isPaid: Boolean(node.isPaid),
    currencyCode: node.total?.gross?.currency || null,
    totalAmount: Number(node.total?.gross?.amount || 0),
    subtotalAmount: Number(node.subtotal?.gross?.amount || 0),
    paymentTransactionId:
      (Array.isArray(node.transactions) ? node.transactions.find((item) => item?.pspReference)?.pspReference : '') || '',
    buyer: {
      email: String(
        node?.userEmail || node?.billingAddress?.email || node?.shippingAddress?.email || ''
      ).trim(),
      firstName: String(
        node?.billingAddress?.firstName || node?.shippingAddress?.firstName || ''
      ).trim(),
      lastName: String(
        node?.billingAddress?.lastName || node?.shippingAddress?.lastName || ''
      ).trim(),
      phone: String(
        node?.billingAddress?.phone || node?.shippingAddress?.phone || ''
      ).trim(),
    },
    lines,
  };
}

function normalizeCheckoutNode(node) {
  if (!node) return null;

  return {
    id: node.id,
    token: node.token || null,
    email: String(node.email || '').trim(),
    currencyCode: node.totalPrice?.gross?.currency || null,
    totalAmount: Number(node.totalPrice?.gross?.amount || 0),
    lines: Array.isArray(node.lines)
      ? node.lines.map((line) => ({
          id: line?.id || null,
          quantity: Number(line?.quantity || 0),
          sku: String(line?.variant?.sku || '').trim(),
          variantId: line?.variant?.id || null,
          productId: line?.variant?.product?.id || null,
          productSlug: line?.variant?.product?.slug || '',
        }))
      : [],
  };
}

function normalizeTransactionResponse(payload, key) {
  const root = payload?.[key] || null;
  return {
    transaction: root?.transaction
      ? {
          id: root.transaction.id || null,
          pspReference: root.transaction.pspReference || '',
        }
      : null,
    transactionEvent: root?.transactionEvent
      ? {
          id: root.transactionEvent.id || null,
          type: root.transactionEvent.type || null,
          amount: Number(root.transactionEvent.amount?.amount || 0),
          currency: root.transactionEvent.amount?.currency || null,
        }
      : null,
    data: root?.data || null,
    errors: Array.isArray(root?.errors) ? root.errors : [],
  };
}

export async function getOrderByCode(orderCode) {
  const query = `
    query GetOrderByCode($query: String!) {
      orders(first: 5, filter: { search: $query }) {
        edges {
          node {
            id
            number
            status
            isPaid
            total {
              gross {
                amount
                currency
              }
            }
            transactions {
              id
              pspReference
              chargedAmount {
                amount
              }
              authorizedAmount {
                amount
              }
            }
          }
        }
      }
      draftOrders(first: 5, filter: { search: $query }) {
        edges {
          node {
            id
            number
            status
            isPaid
            total {
              gross {
                amount
                currency
              }
            }
            transactions {
              id
              pspReference
              chargedAmount {
                amount
              }
              authorizedAmount {
                amount
              }
            }
          }
        }
      }
    }
  `;

  const data = await request(query, { query: String(orderCode || '') });
  const orderNodes = Array.isArray(data?.orders?.edges)
    ? data.orders.edges.map((edge) => edge?.node).filter(Boolean)
    : [];
  const draftNodes = Array.isArray(data?.draftOrders?.edges)
    ? data.draftOrders.edges.map((edge) => edge?.node).filter(Boolean)
    : [];
  const nodes = [...orderNodes, ...draftNodes];

  if (!nodes.length) return null;

  const exact = nodes.find((node) => String(node.number || '') === String(orderCode || ''));
  return normalizeOrderNode(exact || nodes[0]);
}

export async function getOrderProvisioningContext(orderCode) {
  const query = `
    query GetOrderProvisioningContext($query: String!) {
      orders(first: 5, filter: { search: $query }) {
        edges {
          node {
            id
            number
            status
            isPaid
            metadata {
              key
              value
            }
            userEmail
            billingAddress {
              firstName
              lastName
            }
            shippingAddress {
              firstName
              lastName
            }
            lines {
              productName
              variantName
              productSku
              variant {
                product {
                  slug
                }
              }
            }
          }
        }
      }
      draftOrders(first: 5, filter: { search: $query }) {
        edges {
          node {
            id
            number
            status
            isPaid
            metadata {
              key
              value
            }
            userEmail
            billingAddress {
              firstName
              lastName
            }
            shippingAddress {
              firstName
              lastName
            }
            lines {
              productName
              variantName
              productSku
              variant {
                product {
                  slug
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await request(query, { query: String(orderCode || '') });
  const orderNodes = Array.isArray(data?.orders?.edges)
    ? data.orders.edges.map((edge) => edge?.node).filter(Boolean)
    : [];
  const draftNodes = Array.isArray(data?.draftOrders?.edges)
    ? data.draftOrders.edges.map((edge) => edge?.node).filter(Boolean)
    : [];
  const nodes = [...orderNodes, ...draftNodes];
  if (!nodes.length) return null;

  const exact = nodes.find((node) => String(node.number || '') === String(orderCode || ''));
  return normalizeOrderProvisioningNode(exact || nodes[0]);
}

export async function getOrderCommerceContext(orderCode) {
  const query = `
    query GetOrderCommerceContext($query: String!) {
      orders(first: 5, filter: { search: $query }) {
        edges {
          node {
            id
            number
            status
            isPaid
            userEmail
            billingAddress {
              firstName
              lastName
              phone
            }
            shippingAddress {
              firstName
              lastName
              phone
            }
            subtotal {
              gross {
                amount
                currency
              }
            }
            total {
              gross {
                amount
                currency
              }
            }
            transactions {
              id
              pspReference
              chargedAmount {
                amount
              }
              authorizedAmount {
                amount
              }
            }
            lines {
              id
              quantity
              productSku
              productName
              variantName
              unitPrice {
                gross {
                  amount
                  currency
                }
              }
              totalPrice {
                gross {
                  amount
                  currency
                }
              }
              variant {
                id
                sku
                metadata {
                  key
                  value
                }
                product {
                  id
                  slug
                  metadata {
                    key
                    value
                  }
                }
              }
            }
          }
        }
      }
      draftOrders(first: 5, filter: { search: $query }) {
        edges {
          node {
            id
            number
            status
            isPaid
            userEmail
            billingAddress {
              firstName
              lastName
              phone
            }
            shippingAddress {
              firstName
              lastName
              phone
            }
            subtotal {
              gross {
                amount
                currency
              }
            }
            total {
              gross {
                amount
                currency
              }
            }
            transactions {
              id
              pspReference
              chargedAmount {
                amount
              }
              authorizedAmount {
                amount
              }
            }
            lines {
              id
              quantity
              productSku
              productName
              variantName
              unitPrice {
                gross {
                  amount
                  currency
                }
              }
              totalPrice {
                gross {
                  amount
                  currency
                }
              }
              variant {
                id
                sku
                metadata {
                  key
                  value
                }
                product {
                  id
                  slug
                  metadata {
                    key
                    value
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await request(query, { query: String(orderCode || '') });
  const orderNodes = Array.isArray(data?.orders?.edges)
    ? data.orders.edges.map((edge) => edge?.node).filter(Boolean)
    : [];
  const draftNodes = Array.isArray(data?.draftOrders?.edges)
    ? data.draftOrders.edges.map((edge) => edge?.node).filter(Boolean)
    : [];
  const nodes = [...orderNodes, ...draftNodes];
  if (!nodes.length) return null;

  const exact = nodes.find((node) => String(node.number || '') === String(orderCode || ''));
  return normalizeOrderCommerceNode(exact || nodes[0]);
}

export async function markOrderAsPaid({ orderId, transactionReference }) {
  const mutation = `
    mutation MarkOrderAsPaid($id: ID!, $transactionReference: String) {
      orderMarkAsPaid(id: $id, transactionReference: $transactionReference) {
        order {
          id
          number
          status
          isPaid
          total {
            gross {
              amount
              currency
            }
          }
          transactions {
            id
            pspReference
            chargedAmount {
              amount
            }
            authorizedAmount {
              amount
            }
          }
        }
        errors {
          field
          code
          message
        }
      }
    }
  `;

  const data = await request(mutation, {
    id: orderId,
    transactionReference: transactionReference || null,
  });

  return {
    order: normalizeOrderNode(data?.orderMarkAsPaid?.order || null),
    errors: Array.isArray(data?.orderMarkAsPaid?.errors) ? data.orderMarkAsPaid.errors : [],
  };
}

export async function getVariantBySku(sku) {
  const query = `
    query GetVariantBySku($query: String!) {
      productVariants(first: 10, filter: { search: $query }) {
        edges {
          node {
            id
            sku
            name
          }
        }
      }
    }
  `;

  const data = await request(query, { query: String(sku || '') });
  const nodes = Array.isArray(data?.productVariants?.edges)
    ? data.productVariants.edges.map((edge) => edge?.node).filter(Boolean)
    : [];

  if (!nodes.length) return null;

  const exact = nodes.find((node) => String(node.sku || '') === String(sku || ''));
  return exact || nodes[0] || null;
}

export async function addItemToDraftOrder(orderId, productVariantId, quantity = 1) {
  const mutation = `
    mutation AddItemToDraftOrder($id: ID!, $input: [OrderLineCreateInput!]!) {
      orderLinesCreate(id: $id, input: $input) {
        order {
          id
          number
          status
          lines {
            id
            quantity
            productSku
            productName
          }
        }
        errors {
          field
          code
          message
        }
      }
    }
  `;

  const data = await request(mutation, {
    id: orderId,
    input: [
      {
        variantId: productVariantId,
        quantity,
      },
    ],
  });

  return {
    order: data?.orderLinesCreate?.order || null,
    errors: Array.isArray(data?.orderLinesCreate?.errors) ? data.orderLinesCreate.errors : [],
  };
}

export async function createDraftOrder() {
  const mutation = `
    mutation CreateDraftOrder($input: DraftOrderCreateInput!) {
      draftOrderCreate(input: $input) {
        order {
          id
          number
          status
        }
        errors {
          field
          code
          message
        }
      }
    }
  `;

  const input = saleorChannelId ? { channelId: saleorChannelId } : {};
  const data = await request(mutation, { input });

  return {
    order: data?.draftOrderCreate?.order || null,
    errors: Array.isArray(data?.draftOrderCreate?.errors) ? data.draftOrderCreate.errors : [],
  };
}

export async function createCheckout({ email, lines, channelSlug = 'default-channel', metadata, privateMetadata }) {
  const mutation = `
    mutation CreateCheckout($input: CheckoutCreateInput!) {
      checkoutCreate(input: $input) {
        checkout {
          id
          token
        }
        errors {
          field
          code
          message
        }
      }
    }
  `;

  const input = {
    channel: channelSlug,
    lines: Array.isArray(lines) ? lines : [],
    email: String(email || '').trim() || undefined,
    metadata: Array.isArray(metadata) ? metadata : undefined,
    privateMetadata: Array.isArray(privateMetadata) ? privateMetadata : undefined,
  };

  const data = await request(mutation, { input });
  return {
    checkout: normalizeCheckoutNode(data?.checkoutCreate?.checkout || null),
    errors: Array.isArray(data?.checkoutCreate?.errors) ? data.checkoutCreate.errors : [],
  };
}

export async function initializeTransaction({ id, paymentGatewayId, data: gatewayData, amount, customerIpAddress }) {
  const mutation = `
    mutation InitializeTransaction(
      $id: ID!
      $paymentGateway: PaymentGatewayToInitialize!
      $amount: PositiveDecimal
      $customerIpAddress: String
    ) {
      transactionInitialize(
        id: $id
        paymentGateway: $paymentGateway
        amount: $amount
        customerIpAddress: $customerIpAddress
      ) {
        data
        transaction {
          id
        }
        transactionEvent {
          type
        }
        errors {
          field
          code
          message
        }
      }
    }
  `;

  const payload = await request(mutation, {
    id,
    paymentGateway: {
      id: paymentGatewayId,
      data: gatewayData || null,
    },
    amount: Number.isFinite(Number(amount)) ? Number(amount) : undefined,
    customerIpAddress: String(customerIpAddress || '').trim() || undefined,
  });

  return normalizeTransactionResponse(payload, 'transactionInitialize');
}

export async function getVariantAvailability({ ids, channelSlug = 'default-channel' }) {
  const variantIds = Array.from(
    new Set((Array.isArray(ids) ? ids : []).map((item) => String(item || '').trim()).filter(Boolean))
  );

  if (variantIds.length === 0) {
    return [];
  }

  const query = `
    query VariantAvailability($ids: [ID!], $channel: String!) {
      productVariants(ids: $ids, channel: $channel, first: 100) {
        edges {
          node {
            id
            quantityAvailable
          }
        }
      }
    }
  `;

  const payload = await request(query, {
    ids: variantIds,
    channel: String(channelSlug || 'default-channel').trim() || 'default-channel',
  });

  const edges = Array.isArray(payload?.productVariants?.edges)
    ? payload.productVariants.edges
    : [];

  return edges
    .map((edge) => edge?.node)
    .filter(Boolean)
    .map((variant) => ({
      id: String(variant?.id || '').trim(),
      quantityAvailable: Number(variant?.quantityAvailable ?? 0),
    }));
}

export async function processTransaction({ id, token, data: processData, customerIpAddress }) {
  const mutation = `
    mutation ProcessTransaction(
      $id: ID
      $token: UUID
      $data: JSON
      $customerIpAddress: String
    ) {
      transactionProcess(
        id: $id
        token: $token
        data: $data
        customerIpAddress: $customerIpAddress
      ) {
        data
        transaction {
          id
          pspReference
        }
        transactionEvent {
          id
          type
          amount {
            amount
            currency
          }
        }
        errors {
          field
          code
          message
        }
      }
    }
  `;

  const payload = await request(mutation, {
    id: id || undefined,
    token: token || undefined,
    data: processData || null,
    customerIpAddress: String(customerIpAddress || '').trim() || undefined,
  });

  return normalizeTransactionResponse(payload, 'transactionProcess');
}

export async function updateCheckoutBillingAddress({ id, billingAddress }) {
  const mutation = `
    mutation UpdateCheckoutBillingAddress($id: ID!, $billingAddress: AddressInput!) {
      checkoutBillingAddressUpdate(id: $id, billingAddress: $billingAddress) {
        checkout {
          id
          token
        }
        errors {
          field
          code
          message
        }
      }
    }
  `;

  const payload = await request(mutation, {
    id,
    billingAddress,
  });

  return {
    checkout: normalizeCheckoutNode(payload?.checkoutBillingAddressUpdate?.checkout || null),
    errors: Array.isArray(payload?.checkoutBillingAddressUpdate?.errors)
      ? payload.checkoutBillingAddressUpdate.errors
      : [],
  };
}

export async function completeCheckout({ id, redirectUrl }) {
  const mutation = `
    mutation CompleteCheckout(
      $id: ID!
      $redirectUrl: String
    ) {
      checkoutComplete(
        id: $id
        redirectUrl: $redirectUrl
      ) {
        order {
          id
          number
          status
          isPaid
        }
        confirmationNeeded
        confirmationData
        errors {
          field
          code
          message
        }
      }
    }
  `;

  const payload = await request(mutation, {
    id,
    redirectUrl: String(redirectUrl || '').trim() || undefined,
  });

  return {
    order: normalizeOrderNode(payload?.checkoutComplete?.order || null),
    confirmationNeeded: Boolean(payload?.checkoutComplete?.confirmationNeeded),
    confirmationData: payload?.checkoutComplete?.confirmationData || null,
    errors: Array.isArray(payload?.checkoutComplete?.errors) ? payload.checkoutComplete.errors : [],
  };
}

export async function addFixedDiscountToOrder(orderId, amount, reason = 'Couple membership discount') {
  const mutation = `
    mutation AddOrderDiscount($id: ID!, $input: OrderDiscountCommonInput!) {
      orderDiscountAdd(id: $id, input: $input) {
        order {
          id
          number
          status
          total {
            gross {
              amount
              currency
            }
          }
        }
        errors {
          field
          code
          message
        }
      }
    }
  `;

  const normalizedAmount = Number(amount || 0);
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    throw new Error('Discount amount must be a positive number');
  }

  const data = await request(mutation, {
    id: orderId,
    input: {
      valueType: 'FIXED',
      value: normalizedAmount,
      reason,
    },
  });

  return {
    order: data?.orderDiscountAdd?.order || null,
    errors: Array.isArray(data?.orderDiscountAdd?.errors) ? data.orderDiscountAdd.errors : [],
  };
}
