document.addEventListener("DOMContentLoaded", function () {
  if (!window.Omni) {
    console.warn("Omni not loaded");
    return;
  }

  if (globalThis.orderConfirmationData) {
    sendCheckoutCompletedFromData(globalThis.orderConfirmationData);
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session_id");

  if (!sessionId) {
    console.warn("No order confirmation data or Stripe session_id found");
    return;
  }

  const dedupeKey = `omni_checkout_completed_${sessionId}`;

  if (localStorage.getItem(dedupeKey) === "1") {
    console.log("checkout_completed already sent");
    return;
  }

  const workerUrl = "https://stripe-session-worker.uxflow-gc.workers.dev/stripe-session?session_id=" + encodeURIComponent(sessionId);

  async function sendCheckoutCompleted(retryCount = 0) {
    try {
      const response = await fetch(workerUrl);

      if (!response.ok) {
        throw new Error(`Worker returned ${response.status}`);
      }

      const order = await response.json();

      await window.Omni.trackCheckoutCompleted(order);

      localStorage.setItem(dedupeKey, "1");

      console.log("Omni checkout_completed sent", order.order_id);
    } catch (error) {
      console.error(
        `checkout_completed attempt ${retryCount + 1} failed`,
        error
      );

      if (retryCount < 2) {
        const delay = (retryCount + 1) * 2000;

        console.log(
          `Retrying checkout_completed in ${delay / 1000}s...`
        );

        setTimeout(function () {
          sendCheckoutCompleted(retryCount + 1);
        }, delay);
      } else {
        console.error(
          "checkout_completed permanently failed after 3 attempts"
        );
      }
    }
  }

  sendCheckoutCompleted();
});

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