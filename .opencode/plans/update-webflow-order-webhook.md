# Update handleWebflowOrderWebhook: remove signature check + reserve order number

## Goal
1. Remove the HMAC secret/signature check from `/webflow-order-webhook`. The ONLY guard is `omni_business_id`.
2. Map the real Webflow `ecomm_new_order` payload to Omni's order schema, keeping only necessary fields.
3. Do NOT use Webflow's `orderId` as the order number — call `shopifyReserveOrderNumber` to reserve one.

## File to edit
`stripe-session-worker/src/index.js`

## 1. New constant
```js
const RESERVE_ORDER_NUMBER_URL = "https://us-central1-mclellanhill-gcp.cloudfunctions.net/onlineCheckoutLink/shopifyReserveOrderNumber";
```

## 2. Rewrite `handleWebflowOrderWebhook`
- Keep method guard (POST) and `omni_business_id` guard. **Remove** the `site`-secret lookup and `x-webflow-signature` verification entirely.
- Parse body with `await request.json()` (no more raw text needed).
- Keep `body.triggerType !== "ecomm_new_order"` check and `p = body.payload || {}`.
- `storeMarket = (url.searchParams.get("site") || "").toUpperCase()`.
- Reserve order number:
  ```js
  const paymentIntentId = p.stripeDetails?.paymentIntentId || "";
  const orderNumber = await reserveOrderNumber(paymentIntentId, storeMarket, env);
  if (!orderNumber) {
    return json({ error: "Failed to reserve order number" }, 502);
  }
  ```
- Use `orderNumber` (not `p.orderId`) for `orderID`, `payload.id`, `payload.order_number`, `payload.name: "#" + orderNumber`.
- Convert all minor-unit amounts to major via existing `centsToMajor`:
  - `total_price = centsToMajor(p.totals?.total?.value)`
  - `subtotal_price = centsToMajor(p.totals?.subtotal?.value)`
  - extras: `shipping`/`tax` from `centsToMajor(extra.price?.value)`, `discount` as `Math.abs(centsToMajor(extra.price?.value))`
  - line item `price: centsToMajor(item.variantPrice?.value)`
  - (All Webflow `value` fields are in cents, e.g. total `37702` = `$377.02`; Omni schema expects major units, same as the stripe-session path.)
- Keep existing mappings: status via `mapWebflowStatus`, `customerInfo.fullName/email`, `shippingAddress`, `purchasedItems` → line items, `acceptedOn`, `paymentProcessor`, currency from `p.totals.total.unit`.

## 3. New helper `reserveOrderNumber(paymentIntentId, storeMarket, env)`
```js
async function reserveOrderNumber(paymentIntentId, storeMarket, env) {
  const response = await fetch(RESERVE_ORDER_NUMBER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      paymentIntentId,
      storeMarket,
      secret: env.RESERVE_ORDER_NUMBER_SECRET
    })
  });

  if (!response.ok) return null;

  const text = (await response.text()).trim();
  if (!text.length) return null;
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      const orderNumber = String(parsed?.orderNumber ?? "").trim();
      return orderNumber || null;
    } catch (_error) {
      return text;
    }
  }
  return text;
}
```

## 4. Remove dead code
- `verifyWebflowSignature` (lines ~314-333)
- `hexToBytes` (lines ~335-341)
- `parseAmount` (lines ~308-312) — no longer used after switching to `centsToMajor`

## 5. Deployment note (not a code change)
- Set secret: `wrangler secret put RESERVE_ORDER_NUMBER_SECRET`
- The `WEBFLOW_WEBHOOK_SECRET_*` secrets are now unused and can be removed.
- Webflow webhook URL stays: `https://stripe-session-worker.uxflow-gc.workers.dev/webflow-order-webhook?omni_business_id=b_tlfs&site=us`
