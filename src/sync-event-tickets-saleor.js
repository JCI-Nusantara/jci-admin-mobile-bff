import axios from 'axios';

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toSku(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function relationId(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object' && (typeof value.id === 'string' || typeof value.id === 'number')) {
    return String(value.id);
  }
  return '';
}

function ticketToSku(ticket, eventSlug) {
  const explicitSku = asString(ticket.sku || ticket.code || '');
  if (explicitSku) return explicitSku;

  const ticketName = asString(ticket.name || 'ticket');
  const ticketId = relationId(ticket.id);
  return toSku(`${eventSlug}-${ticketName}-${ticketId.slice(0, 8)}`);
}

function stockForTicket(ticket) {
  const mode = asString(ticket.quantity_mode || 'limited');
  if (mode === 'unlimited') return { trackInventory: false, quantity: 0 };
  const quantity = Math.max(0, Math.floor(asNumber(ticket.quantity_total, 0)));
  return { trackInventory: true, quantity };
}

function buildConfig() {
  return {
    directusUrl: process.env.DIRECTUS_URL || '',
    directusStaticToken: process.env.DIRECTUS_STATIC_TOKEN || '',
    directusEmail: process.env.DIRECTUS_EMAIL || '',
    directusPassword: process.env.DIRECTUS_PASSWORD || '',
    directusEventsCollection: process.env.DIRECTUS_EVENTS_COLLECTION || 'events',
    directusEventTicketsCollection: process.env.DIRECTUS_EVENT_TICKETS_COLLECTION || 'event_tickets',
    saleorApiUrl: process.env.SALEOR_API_URL || '',
    saleorApiToken: process.env.SALEOR_API_TOKEN || '',
    saleorEmail: process.env.SALEOR_EMAIL || '',
    saleorPassword: process.env.SALEOR_PASSWORD || '',
    saleorChannelId: process.env.SALEOR_CHANNEL_ID || '',
    saleorSyncProductTypeId: process.env.SALEOR_SYNC_PRODUCT_TYPE_ID || '',
    saleorSyncProductTypeName: process.env.SALEOR_SYNC_PRODUCT_TYPE_NAME || '',
    saleorSyncWarehouseId: process.env.SALEOR_SYNC_WAREHOUSE_ID || '',
    saleorSyncCategoryId: process.env.SALEOR_SYNC_CATEGORY_ID || '',
    syncLogEnabled: String(process.env.DIRECTUS_SYNC_LOG_ENABLED || 'true').toLowerCase() === 'true',
    syncLogCollection: process.env.DIRECTUS_SYNC_LOG_COLLECTION || 'vendure_sync_logs',
  };
}

function assertConfig(config) {
  if (!config.directusUrl) throw new Error('DIRECTUS_URL is required');
  if (!config.saleorApiUrl) throw new Error('SALEOR_API_URL is required');
  if (!config.saleorChannelId) throw new Error('SALEOR_CHANNEL_ID is required');
  if (!config.directusStaticToken && !(config.directusEmail && config.directusPassword)) {
    throw new Error('Set DIRECTUS_STATIC_TOKEN or DIRECTUS_EMAIL + DIRECTUS_PASSWORD');
  }
  if (!config.saleorApiToken && !(config.saleorEmail && config.saleorPassword)) {
    throw new Error('Set SALEOR_API_TOKEN or SALEOR_EMAIL + SALEOR_PASSWORD');
  }
}

async function getDirectusToken(client, config) {
  if (config.directusStaticToken) return config.directusStaticToken;
  const { data } = await client.post('/auth/login', {
    email: config.directusEmail,
    password: config.directusPassword,
  });
  const token = data?.data?.access_token || '';
  if (!token) throw new Error('Failed to obtain Directus access token');
  return token;
}

async function fetchDirectusItems(client, token, collection, fields) {
  const { data } = await client.get(`/items/${collection}`, {
    params: { limit: -1, fields: fields.join(',') },
    headers: { Authorization: `Bearer ${token}` },
  });
  return Array.isArray(data?.data) ? data.data : [];
}

async function getSaleorToken(client, config) {
  if (config.saleorEmail && config.saleorPassword) {
    const mutation = `
      mutation TokenCreate($email: String!, $password: String!) {
        tokenCreate(email: $email, password: $password) {
          token
          errors { field code message }
        }
      }
    `;
    const { data } = await client.post('', {
      query: mutation,
      variables: { email: config.saleorEmail, password: config.saleorPassword },
    });
    const errors = data?.data?.tokenCreate?.errors || [];
    if (Array.isArray(errors) && errors.length > 0) {
      throw new Error(`Saleor tokenCreate failed: ${errors.map((e) => `${e.code || 'ERR'} ${e.message || ''}`).join('; ')}`);
    }
    const token = data?.data?.tokenCreate?.token || '';
    if (!token) throw new Error('Saleor tokenCreate returned empty token');
    return token;
  }
  return config.saleorApiToken;
}

async function saleorRequest(client, token, query, variables = {}) {
  const response = await client.post(
    '',
    { query, variables },
    { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true }
  );
  const { data, status, statusText } = response;
  if (status >= 400) {
    throw new Error(`Saleor request failed: ${status} ${statusText} ${JSON.stringify(data)}`);
  }
  if (Array.isArray(data?.errors) && data.errors.length > 0) {
    throw new Error(`Saleor GraphQL error: ${data.errors.map((item) => item.message).join('; ')}`);
  }
  return data?.data || {};
}

async function resolveProductTypeId(client, token, config) {
  if (config.saleorSyncProductTypeId) return config.saleorSyncProductTypeId;
  const data = await saleorRequest(
    client,
    token,
    `query { productTypes(first: 50) { edges { node { id name hasVariants } } } }`
  );
  const nodes = (data?.productTypes?.edges || []).map((edge) => edge?.node).filter(Boolean);
  if (config.saleorSyncProductTypeName) {
    const named = nodes.find((node) => String(node.name || '').toLowerCase() === config.saleorSyncProductTypeName.toLowerCase());
    if (named?.id) return named.id;
  }
  const variantType = nodes.find((node) => Boolean(node.hasVariants));
  return variantType?.id || nodes[0]?.id || '';
}

async function resolveWarehouseId(client, token, config) {
  if (config.saleorSyncWarehouseId) return config.saleorSyncWarehouseId;
  const data = await saleorRequest(client, token, `query { warehouses(first: 50) { edges { node { id } } } }`);
  return data?.warehouses?.edges?.[0]?.node?.id || '';
}

async function resolveCategoryId(client, token, config) {
  if (config.saleorSyncCategoryId) return config.saleorSyncCategoryId;
  const data = await saleorRequest(client, token, `query { categories(first: 50) { edges { node { id } } } }`);
  return data?.categories?.edges?.[0]?.node?.id || '';
}

async function findProductBySlug(client, token, slug) {
  const data = await saleorRequest(client, token, `query { products(first: 100) { edges { node { id slug } } } }`);
  const nodes = (data?.products?.edges || []).map((edge) => edge?.node).filter(Boolean);
  return nodes.find((item) => String(item.slug || '') === slug) || null;
}

async function createProduct(client, token, { name, slug, productTypeId, categoryId, eventId }) {
  const mutation = `
    mutation ProductCreate($input: ProductCreateInput!) {
      productCreate(input: $input) {
        product { id slug }
        errors { field code message }
      }
    }
  `;
  const input = {
    name,
    slug,
    productType: productTypeId,
    category: categoryId || null,
    metadata: [
      { key: 'directus_event_id', value: String(eventId) },
      { key: 'source_system', value: 'directus' },
    ],
  };
  const data = await saleorRequest(client, token, mutation, { input });
  const payload = data?.productCreate || {};
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`productCreate(${slug}) failed: ${payload.errors.map((e) => `${e.code || 'ERR'} ${e.message || ''}`).join('; ')}`);
  }
  return payload.product || null;
}

async function ensureProductCategory(client, token, { productId, categoryId }) {
  if (!categoryId) return;
  const mutation = `
    mutation ProductUpdate($id: ID!, $input: ProductInput!) {
      productUpdate(id: $id, input: $input) {
        product { id }
        errors { field code message }
      }
    }
  `;
  const data = await saleorRequest(client, token, mutation, { id: productId, input: { category: categoryId } });
  const payload = data?.productUpdate || {};
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`productUpdate(${productId}) failed: ${payload.errors.map((e) => `${e.code || 'ERR'} ${e.message || ''}`).join('; ')}`);
  }
}

async function findVariantBySku(client, token, sku) {
  const data = await saleorRequest(
    client,
    token,
    `
      query ProductVariants($search: String!) {
        productVariants(first: 20, filter: { search: $search }) {
          edges { node { id sku } }
        }
      }
    `,
    { search: sku }
  );
  const nodes = (data?.productVariants?.edges || []).map((edge) => edge?.node).filter(Boolean);
  return nodes.find((item) => String(item.sku || '') === sku) || null;
}

async function createVariant(client, token, config, { productId, sku, name, warehouseId, quantity, trackInventory, ticketId, eventId }) {
  const mutation = `
    mutation ProductVariantCreate($input: ProductVariantCreateInput!) {
      productVariantCreate(input: $input) {
        productVariant { id sku }
        errors { field code message }
      }
    }
  `;
  const input = {
    attributes: [],
    product: productId,
    sku,
    name,
    trackInventory,
    metadata: [
      { key: 'directus_ticket_id', value: String(ticketId) },
      { key: 'directus_event_id', value: String(eventId) },
      { key: 'source_system', value: 'directus' },
    ],
  };
  if (warehouseId && trackInventory) {
    input.stocks = [{ warehouse: warehouseId, quantity }];
  }
  const data = await saleorRequest(client, token, mutation, { input });
  const payload = data?.productVariantCreate || {};
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`productVariantCreate(${sku}) failed: ${payload.errors.map((e) => `${e.code || 'ERR'} ${e.message || ''}`).join('; ')}`);
  }
  return payload.productVariant || null;
}

async function assignProductVariantToChannel(client, token, config, { productId, variantId }) {
  const mutation = `
    mutation ProductChannelListingUpdate($id: ID!, $input: ProductChannelListingUpdateInput!) {
      productChannelListingUpdate(id: $id, input: $input) {
        product { id }
        errors { field code message }
      }
    }
  `;
  const input = {
    updateChannels: [
      {
        channelId: config.saleorChannelId,
        isPublished: true,
        visibleInListings: true,
        isAvailableForPurchase: true,
        addVariants: [variantId],
      },
    ],
  };
  const data = await saleorRequest(client, token, mutation, { id: productId, input });
  const payload = data?.productChannelListingUpdate || {};
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const message = payload.errors.map((e) => `${e.code || 'ERR'} ${e.message || ''}`).join('; ');
    if (!message.toLowerCase().includes('already') && !message.toLowerCase().includes('assigned')) {
      throw new Error(`productChannelListingUpdate(${productId}) failed: ${message}`);
    }
  }
}

async function setVariantChannelPrice(client, token, config, { variantId, price }) {
  const mutation = `
    mutation ProductVariantChannelListingUpdate($id: ID!, $input: [ProductVariantChannelListingAddInput!]!) {
      productVariantChannelListingUpdate(id: $id, input: $input) {
        variant { id }
        errors { field code message }
      }
    }
  `;
  const input = [{ channelId: config.saleorChannelId, price: Number(price).toFixed(2) }];
  const data = await saleorRequest(client, token, mutation, { id: variantId, input });
  const payload = data?.productVariantChannelListingUpdate || {};
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`productVariantChannelListingUpdate(${variantId}) failed: ${payload.errors.map((e) => `${e.code || 'ERR'} ${e.message || ''}`).join('; ')}`);
  }
}

async function writeSyncLogStart(directus, token, config, { runId, dryRun, trigger }) {
  if (!config.syncLogEnabled) return null;
  try {
    const { data } = await directus.post(
      `/items/${config.syncLogCollection}`,
      {
        run_id: runId,
        status: 'running',
        dry_run: Boolean(dryRun),
        source_file: `event_tickets_saleor_sync:${trigger}`,
        started_at: new Date().toISOString(),
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return data?.data?.id ? String(data.data.id) : null;
  } catch (error) {
    console.warn('[sync] unable to write start log', error?.message || error);
    return null;
  }
}

async function writeSyncLogFinish(directus, token, config, logId, { status, stats, errorMessage }) {
  if (!config.syncLogEnabled || !logId) return;
  try {
    await directus.patch(
      `/items/${config.syncLogCollection}/${logId}`,
      {
        status,
        ended_at: new Date().toISOString(),
        stats,
        error_message: errorMessage || null,
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (error) {
    console.warn('[sync] unable to write finish log', error?.message || error);
  }
}

export async function runEventTicketSync({ dryRun = false, trigger = 'manual' } = {}) {
  const config = buildConfig();
  assertConfig(config);

  const directus = axios.create({
    baseURL: config.directusUrl.replace(/\/$/, ''),
    headers: { 'Content-Type': 'application/json' },
  });
  const saleor = axios.create({
    baseURL: config.saleorApiUrl,
    headers: { 'Content-Type': 'application/json' },
  });

  const runId = `saleor-sync-${new Date().toISOString()}`;
  let logId = null;
  let directusToken = '';
  const summary = {
    dryRun: Boolean(dryRun),
    runId,
    trigger,
    totals: {
      tickets: 0,
      createdProducts: 0,
      existingProducts: 0,
      createdVariants: 0,
      existingVariants: 0,
      skipped: 0,
    },
  };

  try {
    directusToken = await getDirectusToken(directus, config);
    logId = await writeSyncLogStart(directus, directusToken, config, { runId, dryRun, trigger });

    const saleorToken = await getSaleorToken(saleor, config);
    const productTypeId = await resolveProductTypeId(saleor, saleorToken, config);
    const warehouseId = await resolveWarehouseId(saleor, saleorToken, config);
    const categoryId = await resolveCategoryId(saleor, saleorToken, config);

    const [events, tickets] = await Promise.all([
      fetchDirectusItems(directus, directusToken, config.directusEventsCollection, ['id', 'title', 'slug', 'status']),
      fetchDirectusItems(
        directus,
        directusToken,
        config.directusEventTicketsCollection,
        ['id', 'event_id', 'name', 'status', 'price', 'pricing_method', 'quantity_mode', 'quantity_total', 'sort']
      ),
    ]);

    const eventById = new Map(events.map((row) => [relationId(row.id), row]));
    const candidateTickets = tickets.filter((ticket) => asString(ticket.status) === 'available' && relationId(ticket.event_id));
    summary.totals.tickets = candidateTickets.length;

    console.log(
      `[sync] mode=${dryRun ? 'dry-run' : 'apply'} tickets=${candidateTickets.length} productType=${productTypeId} category=${categoryId || 'none'} warehouse=${warehouseId || 'none'} channel=${config.saleorChannelId}`
    );

    const productCache = new Map();
    const variantCache = new Map();

    for (const ticket of candidateTickets) {
      const eventId = relationId(ticket.event_id);
      const event = eventById.get(eventId);
      if (!event) {
        summary.totals.skipped += 1;
        console.log(`[skip] ticket=${ticket.id} reason=event_not_found event_id=${eventId}`);
        continue;
      }

      const eventTitle = asString(event.title || `event-${eventId}`);
      const eventSlug = asString(event.slug || slugify(`event-${eventId}`));
      const productSlug = slugify(`event-${eventSlug || eventId}`);
      const sku = ticketToSku(ticket, eventSlug || String(eventId));
      const price = Math.max(0, asNumber(ticket.price, 0));
      const { trackInventory, quantity } = stockForTicket(ticket);
      const variantName = asString(ticket.name || sku);

      let product = productCache.get(productSlug) || null;
      if (!product) product = await findProductBySlug(saleor, saleorToken, productSlug);

      if (!product) {
        if (dryRun) {
          summary.totals.createdProducts += 1;
          product = { id: 'dry-run-product', slug: productSlug };
          console.log(`[dry-run] create product slug=${productSlug} event_id=${eventId}`);
        } else {
          product = await createProduct(saleor, saleorToken, { name: eventTitle, slug: productSlug, productTypeId, categoryId, eventId });
          if (!product?.id) {
            summary.totals.skipped += 1;
            console.log(`[skip] ticket=${ticket.id} reason=product_create_empty slug=${productSlug}`);
            continue;
          }
          summary.totals.createdProducts += 1;
          console.log(`[ok] product created slug=${productSlug} id=${product.id}`);
        }
      } else {
        summary.totals.existingProducts += 1;
      }

      productCache.set(productSlug, product);
      if (!dryRun) await ensureProductCategory(saleor, saleorToken, { productId: product.id, categoryId });

      let existingVariant = variantCache.get(sku) || null;
      if (!existingVariant) {
        existingVariant = await findVariantBySku(saleor, saleorToken, sku);
        if (existingVariant) variantCache.set(sku, existingVariant);
      }

      if (existingVariant) {
        summary.totals.existingVariants += 1;
        if (!dryRun) {
          await assignProductVariantToChannel(saleor, saleorToken, config, { productId: product.id, variantId: existingVariant.id });
          await setVariantChannelPrice(saleor, saleorToken, config, { variantId: existingVariant.id, price });
        }
        console.log(`[exists] variant sku=${sku} id=${existingVariant.id}`);
        continue;
      }

      if (dryRun) {
        summary.totals.createdVariants += 1;
        console.log(`[dry-run] create variant sku=${sku} product_slug=${productSlug} price=${price.toFixed(2)} trackInventory=${trackInventory} qty=${quantity}`);
        continue;
      }

      const variant = await createVariant(saleor, saleorToken, config, {
        productId: product.id,
        sku,
        name: variantName,
        warehouseId,
        quantity,
        trackInventory,
        ticketId: relationId(ticket.id),
        eventId,
      });
      if (!variant?.id) {
        summary.totals.skipped += 1;
        console.log(`[skip] ticket=${ticket.id} reason=variant_create_empty sku=${sku}`);
        continue;
      }

      await assignProductVariantToChannel(saleor, saleorToken, config, { productId: product.id, variantId: variant.id });
      await setVariantChannelPrice(saleor, saleorToken, config, { variantId: variant.id, price });
      summary.totals.createdVariants += 1;
      variantCache.set(sku, variant);
      console.log(`[ok] variant created sku=${sku} id=${variant.id}`);
    }

    await writeSyncLogFinish(directus, directusToken, config, logId, {
      status: 'success',
      stats: summary,
      errorMessage: null,
    });

    return summary;
  } catch (error) {
    await writeSyncLogFinish(directus, directusToken, config, logId, {
      status: 'failed',
      stats: summary,
      errorMessage: error?.message || String(error),
    });
    throw error;
  }
}
