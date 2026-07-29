/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webflow-order-webhook") {
      return handleWebflowOrderWebhook(request, env);
    }

    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = getAllowedOrigins(env);

    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
        ? origin
        : "",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (!allowedOrigins.includes(origin)) {
      return json({ error: "Origin not allowed" }, 403, corsHeaders);
    }

    if (url.pathname === "/stripe-session") {
      return handleStripeSession(request, url, env, corsHeaders);
    }

    if (url.pathname === "/order-webhook") {
      return handleOrderWebhook(request, env, corsHeaders);
    }

    return json({ error: "Not found" }, 404, corsHeaders);
  }
};

async function handleStripeSession(request, url, env, corsHeaders) {
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405, corsHeaders);
  }

  const sessionId = url.searchParams.get("session_id");

  if (!sessionId || !sessionId.startsWith("cs_")) {
    return json({ error: "Missing or invalid session_id" }, 400, corsHeaders);
  }

  const origin = request.headers.get("Origin") || "";
  const stripeSecretKey = getStripeSecretForOrigin(origin, env);

  if (!stripeSecretKey) {
    return json({ error: "No Stripe key configured for origin" }, 500, corsHeaders);
  }

  try {
    const session = await stripeGet(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      stripeSecretKey
    );

    if (session.payment_status !== "paid") {
      return json({ error: "Session is not paid" }, 400, corsHeaders);
    }

    const lineItems = await stripeGet(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items?limit=100`,
      stripeSecretKey
    );

    const currency = String(session.currency || "").toUpperCase();

    return json({
      order_id: session.id,
      total: centsToMajor(session.amount_total),
      subtotal: centsToMajor(session.amount_subtotal),
      currency,
      email: session.customer_details?.email || session.customer_email || "",
      phone: session.customer_details?.phone || "",
      first_name: getFirstName(session.customer_details?.name),
      last_name: getLastName(session.customer_details?.name),
      payment_method: "stripe",
      items: (lineItems.data || []).map((item) => ({
        product_id: item.price?.product || item.id || "",
        variant_id: item.price?.id || item.id || "",
        product_name: item.description || "",
        quantity: item.quantity || 1,
        price: centsToMajor(item.price?.unit_amount)
      }))
    }, 200, corsHeaders);
  } catch (error) {
    return json({ error: error.message || "Stripe lookup failed" }, 500, corsHeaders);
  }
}

async function handleOrderWebhook(request, env, corsHeaders) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, corsHeaders);
  }

  let body;
  try {
    body = await request.json();
  } catch (_error) {
    return json({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  if (!body.orderID || !body.omniBusinessId || !body.payload) {
    return json({ error: "Missing required fields: orderID, omniBusinessId, payload" }, 400, corsHeaders);
  }

  const omniUrl = `https://api.omnios.app/customOrders/webhook/save?omni_business_id=${encodeURIComponent(body.omniBusinessId)}`;

  try {
    const omniResponse = await fetch(omniUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const responseText = await omniResponse.text();

    return new Response(responseText, {
      status: omniResponse.status,
      headers: {
        ...corsHeaders,
        "Content-Type": "text/plain;charset=UTF-8"
      }
    });
  } catch (error) {
    return json({ error: error.message || "Omni webhook proxy failed" }, 502, corsHeaders);
  }
}

async function handleWebflowOrderWebhook(request, env) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const url = new URL(request.url);
  const omniBusinessId = url.searchParams.get("omni_business_id");

  if (!omniBusinessId) {
    return json({ error: "Missing omni_business_id query parameter" }, 400);
  }

  let body;
  try {
    body = await request.json();
  } catch (_error) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (body.triggerType !== "ecomm_new_order") {
    return json({ error: "Unsupported triggerType: " + body.triggerType }, 400);
  }

  const p = body.payload || {};

  if (!p.orderId) {
    return json({ error: "Missing payload.orderId" }, 400);
  }

  const totalPrice = parseAmount(p.totals?.total?.value);
  const subtotal = parseAmount(p.totals?.subtotal?.value);
  const currency = (p.totals?.total?.unit || "AUD").toUpperCase();

  let shipping = 0, tax = 0, discount = 0;
  if (Array.isArray(p.totals?.extras)) {
    for (const extra of p.totals.extras) {
      const amount = parseAmount(extra.price?.value);
      if (extra.type === "shipping") shipping += amount;
      else if (extra.type === "tax") tax += amount;
      else if (extra.type === "discount" || extra.type === "discount-shipping") discount += Math.abs(amount);
    }
  }

  const customerInfo = p.customerInfo || {};
  const nameParts = (customerInfo.fullName || "").trim().split(/\s+/);
  const firstName = nameParts[0] || "";
  const lastName = nameParts.slice(1).join(" ");

  const lineItems = (p.purchasedItems || []).map(function (item, index) {
    return {
      id: "wf_" + (item.productId || "") + "_" + index + "_" + (p.orderId || ""),
      product_id: item.productId || "",
      variant_id: item.variantId || item.productId || "",
      sku: item.variantSKU || "",
      title: item.productName || "",
      name: (item.productName || "") + (item.variantName ? " - " + item.variantName : ""),
      quantity: item.count || 1,
      price: parseAmount(item.variantPrice?.value),
      total_discount: 0,
      requires_shipping: true,
      taxable: true
    };
  }).filter(function (item) {
    return item.product_id && item.quantity > 0;
  });

  const shippingAddr = p.shippingAddress || {};

  const omniPayload = {
    orderID: String(p.orderId),
    omniBusinessId: omniBusinessId,
    omni_hash_fingerprint: "",
    payload: {
      id: String(p.orderId),
      order_number: p.orderId,
      name: "#" + String(p.orderId),
      currency: currency,
      created_at: p.acceptedOn || new Date().toISOString(),
      processed_at: p.acceptedOn || new Date().toISOString(),
      total_price: totalPrice,
      subtotal_price: subtotal,
      total_line_items_price: subtotal,
      total_shipping_price: shipping,
      total_tax: tax,
      total_discounts: discount,
      financial_status: mapWebflowStatus(p.status),
      payment_gateway_names: [p.paymentProcessor || "stripe"],
      source_name: "webflow",
      customer: {
        email: customerInfo.email || "",
        first_name: firstName,
        last_name: lastName
      },
      shipping_address: {
        address1: shippingAddr.line1 || "",
        address2: shippingAddr.line2 || "",
        city: shippingAddr.city || "",
        province: shippingAddr.state || "",
        province_code: shippingAddr.state || "",
        country: shippingAddr.country || "",
        country_code: shippingAddr.country || "",
        zip: shippingAddr.postalCode || "",
        first_name: shippingAddr.addressee || firstName,
        last_name: lastName,
        phone: ""
      },
      line_items: lineItems
    }
  };

  const omniUrl = "https://api.omnios.app/customOrders/webhook/save?omni_business_id=" + encodeURIComponent(omniBusinessId);

  try {
    const omniResponse = await fetch(omniUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(omniPayload)
    });

    const responseText = await omniResponse.text();

    return new Response(responseText, {
      status: omniResponse.status,
      headers: { "Content-Type": "text/plain;charset=UTF-8" }
    });
  } catch (error) {
    return json({ error: error.message || "Omni webhook proxy failed" }, 502);
  }
}

function mapWebflowStatus(status) {
  const map = {
    "pending": "pending",
    "unfulfilled": "paid",
    "fulfilled": "paid",
    "disputed": "disputed",
    "dispute-lost": "disputed",
    "refunded": "refunded"
  };
  return map[status] || "paid";
}

function parseAmount(value) {
  if (value === undefined || value === null || value === "") return 0;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function getAllowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function getStripeSecretForOrigin(origin, env) {
  const hostname = new URL(origin).hostname.replace(/^www\./, "");

  const map = {
    "commercialdehydrators.com.au": env.STRIPE_SECRET_AU,
    "dehydratorsamerica.com": env.STRIPE_SECRET_US,
    "commercialdehydrators.ca": env.STRIPE_SECRET_CA,
    "commercialdehydrators.co.nz": env.STRIPE_SECRET_NZ
  };

  return map[hostname];
}

async function stripeGet(url, secretKey) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${secretKey}`
    }
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error(body?.error?.message || "Stripe request failed");
  }

  return body;
}

function centsToMajor(value) {
  return Math.round(Number(value || 0)) / 100;
}

function getFirstName(name) {
  if (!name) return "";
  return String(name).trim().split(/\s+/)[0] || "";
}

function getLastName(name) {
  if (!name) return "";
  return String(name).trim().split(/\s+/).slice(1).join(" ");
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json"
    }
  });
}