document.addEventListener("DOMContentLoaded", async function () {
  const [omni, orderConfirmationData] = await Promise.all([
    waitFor(function () {
      return (
        window.Omni &&
        typeof window.Omni.trackCheckoutCompleted === "function"
          ? window.Omni
          : null
      );
    }, 15000, 150),

    waitFor(function () {
      const data = globalThis.orderConfirmationData;

      return (
        data &&
        data.orderNumber &&
        Array.isArray(data.cartItems)
          ? data
          : null
      );
    }, 15000, 150)
  ]);

  if (!omni) {
    console.warn("Omni not available after 15 seconds");
    return;
  }

  if (orderConfirmationData) {
    await sendCheckoutCompletedFromData(orderConfirmationData);
    return;
  }

  console.warn(
    "orderConfirmationData not available after 15 seconds, using fallback"
  );

  await sendCheckoutCompletedFromFallback();
});

function waitFor(getValue, timeout = 15000, interval = 150) {
  return new Promise(function (resolve) {
    const startedAt = Date.now();

    function check() {
      let value = null;

      try {
        value = getValue();
      } catch (error) {
        console.warn("waitFor check failed", error);
      }

      if (value) {
        resolve(value);
        return;
      }

      if (Date.now() - startedAt >= timeout) {
        resolve(null);
        return;
      }

      setTimeout(check, interval);
    }

    check();
  });
}

async function sendCheckoutCompletedFromFallback() {
  const orderId = new URLSearchParams(window.location.search).get("orderId");

  if (!orderId) {
    console.warn("Omni: no orderId in URL");
    return;
  }

  const cart =
    window.CartSnapshot &&
    typeof window.CartSnapshot.toCheckoutPayload === "function"
      ? window.CartSnapshot.toCheckoutPayload()
      : null;

  if (!cart || !Array.isArray(cart.items) || !cart.items.length) {
    console.warn("Omni: CartSnapshot.toCheckoutPayload() unavailable");
    return;
  }

  const orderData = {
    order_id: orderId,
    total: readAmount("data-order-total", toNumber(cart.total_price)),
    subtotal: readAmount("data-order-subtotal", toNumber(cart.total_price)),
    currency: cart.currency || "",
    email: readText("data-customer-email"),
    first_name: readText("data-customer-first-name"),
    city: readText("data-customer-city"),
    country: readText("data-customer-country"),
    shipping_amount: readAmount("data-order-shipping", 0),
    payment_method: "stripe",
    items: cart.items
  };

  const dedupeKey = getCheckoutDedupeKey(orderId);

  if (hasBeenSent(dedupeKey)) {
    console.log("checkout_completed already sent for", orderId);
    return;
  }

  try {
    await window.Omni.trackCheckoutCompleted(orderData);

    markAsSent(dedupeKey);

    console.log("Omni checkout_completed sent", orderId);
  } catch (error) {
    console.error("Fallback checkout_completed failed", error);
  }
}

async function sendCheckoutCompletedFromData(orderData, retryCount = 0) {
  const orderNumber = orderData?.orderNumber;

  if (!orderNumber) {
    console.warn("Omni: orderConfirmationData has no orderNumber");
    return;
  }

  const dedupeKey = getCheckoutDedupeKey(orderNumber);

  if (hasBeenSent(dedupeKey)) {
    console.log("checkout_completed already sent for", orderNumber);

    // Still attempt webhook independently.
    await sendOrderWebhookFromData(orderData);

    return;
  }

  const cartItems = Array.isArray(orderData.cartItems)
    ? orderData.cartItems
    : [];

  const subtotal = cartItems.reduce(function (total, item) {
    return (
      total +
      toNumber(item.price) *
        toNumber(item.qty, 1)
    );
  }, 0);

  const shipping = toNumber(orderData.shippingMethod?.price);
  const discount = toNumber(orderData.discountAmount);

  const items = cartItems.map(function (item) {
    return {
      product_id: item.sku || "",
      variant_id: item.sku || "",
      product_name: item.name || "",
      quantity: toNumber(item.qty, 1),
      price: toNumber(item.price)
    };
  });

  const payload = {
    order_id: orderNumber,
    total: subtotal + shipping - discount,
    subtotal: subtotal,
    currency: orderData.currency || "",
    email: orderData.email || "",
    first_name: orderData.first_name || "",
    last_name: orderData.last_name || "",
    city: orderData.shipping?.city || "",
    country: orderData.shipping?.country || "",
    state: orderData.shipping?.state || "",
    payment_method: "stripe",
    shipping_amount: shipping,
    discount_code: orderData.discountCode || "",
    tax_amount: toNumber(orderData.taxAmount),
    items: items
  };

  try {
    await window.Omni.trackCheckoutCompleted(payload);

    markAsSent(dedupeKey);

    console.log("Omni checkout_completed sent", orderNumber);

    // Independent from checkout_completed success/failure retries.
    await sendOrderWebhookFromData(orderData);
  } catch (error) {
    console.error(
      "checkout_completed attempt " + (retryCount + 1) + " failed",
      error
    );

    if (retryCount < 2) {
      const delay = (retryCount + 1) * 2000;

      console.log(
        "Retrying checkout_completed in " + delay / 1000 + "s..."
      );

      setTimeout(function () {
        sendCheckoutCompletedFromData(
          orderData,
          retryCount + 1
        );
      }, delay);

      return;
    }

    console.error(
      "checkout_completed permanently failed after 3 attempts"
    );

    // Still attempt webhook even if tracking failed.
    await sendOrderWebhookFromData(orderData);
  }
}

async function sendOrderWebhookFromData(orderData, retryCount = 0) {
  if (
    !window.Omni ||
    typeof window.Omni.orderWebhook !== "function"
  ) {
    console.warn("Omni.orderWebhook unavailable");
    return;
  }

  const orderNumber = orderData?.orderNumber;

  if (!orderNumber) {
    console.warn("Omni: cannot send webhook without orderNumber");
    return;
  }

  const dedupeKey = getWebhookDedupeKey(orderNumber);

  if (hasBeenSent(dedupeKey)) {
    console.log("order webhook already sent for", orderNumber);
    return;
  }

  try {
    await window.Omni.orderWebhook(orderData);

    markAsSent(dedupeKey);

    console.log("Omni order webhook sent", orderNumber);
  } catch (error) {
    console.error(
      "order webhook attempt " + (retryCount + 1) + " failed",
      error
    );

    if (retryCount < 2) {
      const delay = (retryCount + 1) * 2000;

      console.log(
        "Retrying order webhook in " + delay / 1000 + "s..."
      );

      setTimeout(function () {
        sendOrderWebhookFromData(
          orderData,
          retryCount + 1
        );
      }, delay);

      return;
    }

    console.error(
      "order webhook permanently failed after 3 attempts"
    );
  }
}

function readText(attr) {
  const el = document.querySelector("[" + attr + "]");

  if (!el) {
    return "";
  }

  const value = (el.getAttribute(attr) || "").trim();

  return value || (el.textContent || "").trim();
}

function readAmount(attr, fallback = 0) {
  const raw = readText(attr);

  if (!raw) {
    return fallback;
  }

  const parsed = parseFloat(
    raw.replace(/[^0-9.-]/g, "")
  );

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function toNumber(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function getCheckoutDedupeKey(orderId) {
  return "omni_checkout_completed_" + orderId;
}

function getWebhookDedupeKey(orderId) {
  return "omni_order_webhook_" + orderId;
}

function hasBeenSent(key) {
  try {
    return localStorage.getItem(key) === "1";
  } catch (error) {
    console.warn("Unable to read localStorage", error);
    return false;
  }
}

function markAsSent(key) {
  try {
    localStorage.setItem(key, "1");
  } catch (error) {
    console.warn("Unable to write localStorage", error);
  }
}