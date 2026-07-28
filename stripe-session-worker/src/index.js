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

    const url = new URL(request.url);

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