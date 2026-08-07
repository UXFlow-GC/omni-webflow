document.addEventListener("DOMContentLoaded", function () {
  const [omni, orderConfirmationData] = await Promise.all([
    waitFor(function () {
      return window.Omni &&
        typeof window.Omni.trackCheckoutCompleted === "function"
          ? window.Omni
          : null;
    }, 15000, 150),

    waitFor(function () {
      const data = globalThis.orderConfirmationData;

      return data &&
        data.orderNumber &&
        Array.isArray(data.cartItems)
          ? data
          : null;
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

  // Fallback to the existing checkout-page data.
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
    total: readAmount("data-order-total", cart.total_price),
    subtotal: readAmount("data-order-subtotal", cart.total_price),
    currency: cart.currency || "",
    email: readText("data-customer-email"),
    first_name: readText("data-customer-first-name"),
    city: readText("data-customer-city"),
    country: readText("data-customer-country"),
    shipping_amount: readAmount("data-order-shipping", 0),
    payment_method: "stripe",
    items: cart.items
  };

  const key = "omni_checkout_completed_" + orderId;

  if (localStorage.getItem(key) === "1") {
    console.log("checkout_completed already sent");
    return;
  }

  sendCheckoutCompleted(orderData, key, orderId);
});

function waitFor(getValue, timeout = 15000, interval = 150) {
  return new Promise(function (resolve) {
    const start = Date.now();

    function check() {
      const value = getValue();

      if (value) {
        resolve(value);
        return;
      }

      if (Date.now() - start >= timeout) {
        resolve(null);
        return;
      }

      setTimeout(check, interval);
    }

    check();
  });
}

function readText(attr) {
  const el = document.querySelector("[" + attr + "]");
  if (!el) return "";
  const v = (el.getAttribute(attr) || "").trim();
  return v ? v : (el.textContent || "").trim();
}

function readAmount(attr, fallback) {
  const raw = readText(attr);
  if (!raw) return fallback;
  const num = parseFloat(raw.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(num) ? num : fallback;
}

async function sendCheckoutCompletedFromData(orderData, retryCount) {
  retryCount = retryCount || 0;

  const dedupeKey = "omni_checkout_completed_" + orderData.orderNumber;

  if (localStorage.getItem(dedupeKey) === "1") {
    console.log("checkout_completed already sent for", orderData.orderNumber);
    return;
  }

  var lineTotal = 0;
  for (var i = 0; i < (orderData.cartItems || []).length; i++) {
    var item = orderData.cartItems[i];
    lineTotal += (item.price || 0) * (item.qty || 1);
  }

  var shipping = (orderData.shippingMethod && orderData.shippingMethod.price) || 0;
  var discount = orderData.discountAmount || 0;

  var items = (orderData.cartItems || []).map(function (item) {
    return {
      product_id: item.sku || "",
      variant_id: item.sku || "",
      product_name: item.name || "",
      quantity: item.qty || 1,
      price: item.price || 0
    };
  });

  var payload = {
    order_id: orderData.orderNumber,
    total: lineTotal + shipping - discount,
    subtotal: lineTotal,
    currency: orderData.currency || "",
    email: orderData.email || "",
    first_name: orderData.first_name || "",
    last_name: orderData.last_name || "",
    city: (orderData.shipping && orderData.shipping.city) || "",
    country: (orderData.shipping && orderData.shipping.country) || "",
    state: (orderData.shipping && orderData.shipping.state) || "",
    payment_method: "stripe",
    shipping_amount: shipping,
    discount_code: "",
    tax_amount: 0,
    items: items
  };

  try {
    await window.Omni.trackCheckoutCompleted(payload);
    localStorage.setItem(dedupeKey, "1");
    console.log("Omni checkout_completed sent", orderData.orderNumber);
    sendOrderWebhookFromData(orderData);
  } catch (error) {
    console.error(
      "checkout_completed attempt " + (retryCount + 1) + " failed",
      error
    );

    if (retryCount < 2) {
      var delay = (retryCount + 1) * 2000;
      console.log("Retrying checkout_completed in " + (delay / 1000) + "s...");
      setTimeout(function () {
        sendCheckoutCompletedFromData(orderData, retryCount + 1);
      }, delay);
    } else {
      console.error("checkout_completed permanently failed after 3 attempts");
    }
  }
}

async function sendOrderWebhookFromData(orderData, retryCount) {
  retryCount = retryCount || 0;

  const dedupeKey = "omni_order_webhook_" + orderData.orderNumber;

  if (localStorage.getItem(dedupeKey) === "1") {
    console.log("order webhook already sent for", orderData.orderNumber);
    return;
  }

  try {
    await window.Omni.orderWebhook(orderData);
    localStorage.setItem(dedupeKey, "1");
    console.log("Omni order webhook sent", orderData.orderNumber);
  } catch (error) {
    console.error(
      "order webhook attempt " + (retryCount + 1) + " failed",
      error
    );

    if (retryCount < 2) {
      var delay = (retryCount + 1) * 2000;
      console.log("Retrying order webhook in " + (delay / 1000) + "s...");
      setTimeout(function () {
        sendOrderWebhookFromData(orderData, retryCount + 1);
      }, delay);
    } else {
      console.error("order webhook permanently failed after 3 attempts");
    }
  }
}