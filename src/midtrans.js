import axios from 'axios';

const midtransServerKey = process.env.MIDTRANS_SERVER_KEY || '';
const midtransIsProduction = String(process.env.MIDTRANS_IS_PRODUCTION || 'false').toLowerCase() === 'true';

const snapBaseUrl = midtransIsProduction
  ? 'https://app.midtrans.com'
  : 'https://app.sandbox.midtrans.com';

function getSnapClient() {
  if (!midtransServerKey) {
    throw new Error('MIDTRANS_SERVER_KEY is required');
  }

  const auth = Buffer.from(`${midtransServerKey}:`).toString('base64');
  return axios.create({
    baseURL: snapBaseUrl,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Basic ${auth}`
    }
  });
}

function normalizePositiveInt(value, fallback = 0) {
  const intValue = Number(value);
  if (!Number.isFinite(intValue)) return fallback;
  return Math.max(0, Math.round(intValue));
}

export async function createSnapTransaction({
  orderId,
  baseAmount,
  feeAmount,
  feeLabel,
  customer,
  enabledPayments,
  customExpiry
}) {
  const safeBaseAmount = normalizePositiveInt(baseAmount);
  const safeFeeAmount = normalizePositiveInt(feeAmount);
  const grossAmount = safeBaseAmount + safeFeeAmount;

  if (!orderId) throw new Error('orderId is required');
  if (grossAmount <= 0) throw new Error('gross amount must be greater than 0');

  const itemDetails = [
    {
      id: 'order-subtotal',
      name: 'Order Subtotal',
      quantity: 1,
      price: safeBaseAmount
    }
  ];

  if (safeFeeAmount > 0) {
    itemDetails.push({
      id: 'payment-fee',
      name: feeLabel || 'Payment Fee',
      quantity: 1,
      price: safeFeeAmount
    });
  }

  const payload = {
    transaction_details: {
      order_id: orderId,
      gross_amount: grossAmount
    },
    item_details: itemDetails
  };

  if (customer && typeof customer === 'object') {
    payload.customer_details = customer;
  }
  if (Array.isArray(enabledPayments) && enabledPayments.length > 0) {
    payload.enabled_payments = enabledPayments;
  }
  if (customExpiry && typeof customExpiry === 'object') {
    payload.custom_expiry = customExpiry;
  }

  const client = getSnapClient();
  const { data } = await client.post('/snap/v1/transactions', payload);
  return data;
}
