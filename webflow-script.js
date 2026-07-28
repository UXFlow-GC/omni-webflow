document.addEventListener("DOMContentLoaded", function () {
  if (!window.Omni) {
    console.warn("Omni not loaded");
    return;
  }

  if (globalThis.orderConfirmationData) {
    sendOrderWebhook(globalThis.orderConfirmationData);
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

async function sendOrderWebhook(orderData) {
  const dedupeKey = "omni_order_webhook_" + orderData.orderNumber;

  if (localStorage.getItem(dedupeKey) === "1") {
    console.log("Order webhook already sent for", orderData.orderNumber);
    return;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await window.Omni.orderWebhook(orderData);
      localStorage.setItem(dedupeKey, "1");
      console.log("Omni order webhook sent", orderData.orderNumber);
      return;
    } catch (error) {
      console.error(
        "Order webhook attempt " + (attempt + 1) + " failed",
        error
      );

      if (attempt < 2) {
        const delay = (attempt + 1) * 2000;
        console.log("Retrying order webhook in " + (delay / 1000) + "s...");
        await new Promise(function (resolve) { setTimeout(resolve, delay); });
      } else {
        console.error("Order webhook permanently failed after 3 attempts");
      }
    }
  }
}