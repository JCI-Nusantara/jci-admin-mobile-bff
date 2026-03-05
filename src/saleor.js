import axios from 'axios';

const saleorApiUrl = process.env.SALEOR_API_URL || process.env.SALEOR_ADMIN_API_URL;
const saleorApiToken = process.env.SALEOR_API_TOKEN || process.env.SALEOR_ADMIN_API_TOKEN;
const saleorEmail = process.env.SALEOR_EMAIL || '';
const saleorPassword = process.env.SALEOR_PASSWORD || '';
const saleorChannelId = process.env.SALEOR_CHANNEL_ID || '';

const saleor = axios.create({
  baseURL: saleorApiUrl || '',
  headers: {
    'Content-Type': 'application/json',
  },
});

let cachedUserToken = '';
let cachedUserTokenExpMs = 0;

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

  const { data } = await saleor.post(
    '',
    { query, variables },
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

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

export async function cancelOrder(orderId) {
  const mutation = `
    mutation CancelOrder($id: ID!) {
      orderCancel(id: $id) {
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

  const data = await request(mutation, { id: orderId });

  return {
    order: normalizeOrderNode(data?.orderCancel?.order || null),
    errors: Array.isArray(data?.orderCancel?.errors) ? data.orderCancel.errors : [],
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
