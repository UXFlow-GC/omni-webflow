# Omni — Add-to-Cart Event & Order Webhook Integration Guide

This guide extends the [Custom Storefront Event Integration Guide](./omni-benchfoods-dehydrators.md) with two additional integrations:

1. **Add to Cart event** — fired from the browser whenever a customer adds a product to their cart.
2. **Order Webhook** — a server-to-server callback your backend sends to Omni after an order is created or updated, carrying the full order payload.

Both flows share the same Business ID and fingerprint you already use for `page_viewed` / `checkout_started` / `checkout_completed`.

---

## Quick Reference


| Term                 | Definition                                                                                                                                                                                                       | Format / Example      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **Business ID**      | Your unique identifier in Omni. Required on every request.                                                                                                                                | `b_tlfs`              |
| **Omni Fingerprint** | The SHA-256 hash returned by `/generateHashFingerprint`. Stored in a first-party cookie, sent on every browser event, **and forwarded on the order webhook** to attribute the order. | `cbc85a74...293ce7be` |
| **Order ID**         | A unique, stable identifier for the order in your system.                                                                                                                                 | `ORD-2026-04-00123`   |



| Environment | Base URL                    |
| ----------- | --------------------------- |
| Development | `https://devapi.omnios.app` |
| Production  | `https://api.omnios.app`    |


> [!NOTE]
> **Authentication.** No handshake is required for either endpoint. The Business ID alone is sufficient. The order webhook must be sent from your **backend server**, not the browser.

---

## Integration Overview

```
Browser flow (already implemented)
  └─ page_viewed → /saveShopifyPixelData
  └─ checkout_started → /saveShopifyPixelData
  └─ checkout_completed → /saveShopifyPixelData

NEW — Add this guide:
  ┌─ Browser: customer clicks "Add to Cart"
  │      └─ product_added_to_cart → /saveShopifyPixelData
  │
  └─ Backend: your server receives an order from your payment system
         └─ POST /customOrders/webhook/save (full order payload)
```

> [!IMPORTANT]
> **Why both?** The `product_added_to_cart` event powers cart-level attribution (which ad drove the add-to-cart). The order webhook delivers the complete authoritative order record — customer info, line items, taxes, shipping, totals — which Omni needs for accurate revenue, COGS, and ad-platform conversion forwarding.

> [!IMPORTANT]
> **Attribution key: `omni_hash_fingerprint`.** Since you already store the fingerprint hash in a first-party cookie (from Step 1 of the [base guide](./omni-benchfoods-dehydrators.md)), you forward that same hash on the order webhook (as a top-level field on the request body). Omni uses it to look up the visitor, the session, and the full ad-click history. The hash alone is enough — no session ID or other identifiers required.

---

## Part 1: `product_added_to_cart` Event

Fire this from the browser **every time** a customer adds a line item to their cart. It uses the same endpoint as your other browser events.

### Endpoint

`**POST /saveShopifyPixelData`**


| Header            | Type   | Required    | Description                    |
| ----------------- | ------ | ----------- | ------------------------------ |
| `Content-Type`    | string | Yes         | Must be `application/json`     |
| `X-Forwarded-For` | string | Recommended | The customer's real IP address |



| Query Parameter    | Type   | Required | Description                      |
| ------------------ | ------ | -------- | -------------------------------- |
| `omni_business_id` | string | Yes      | Your Omni Business ID (`b_tlfs`) |


### Required Fields


| Field                   | Type   | Description                                                            |
| ----------------------- | ------ | ---------------------------------------------------------------------- |
| `event_name`            | string | Must be `"product_added_to_cart"`                                      |
| `event_id`              | string | Any unique identifier for this event (e.g. `crypto.randomUUID()`)      |
| `event_timestamp`       | string | ISO 8601 UTC timestamp                                                 |
| `omniBusinessId`        | string | Your Business ID (`b_tlfs`) — must match the query param               |
| `omni_hash_fingerprint` | string | The fingerprint hash from `/generateHashFingerprint`                   |
| `product_id`            | string | Your product identifier                                                |
| `product_name`          | string | Product display name                                                   |
| `quantity`              | number | Number of units added in this action                                   |
| `total_price`           | number | Line price for this add (unit price × quantity), in the store currency |
| `currency`              | string | ISO 4217 currency code, e.g. `"USD"`                                   |


### Strongly Recommended Fields


| Field        | Type   | Description                                                                |
| ------------ | ------ | -------------------------------------------------------------------------- |
| `user_agent` | string | Customer's browser user agent                                              |
| `referrer`   | string | Page where the add-to-cart happened                                        |
| `host_name`  | string | Your storefront domain                                                     |
| `params`     | object | UTMs / click IDs captured on the landing page (same shape as other events) |
| `cookies`    | object | Ad platform cookies (same shape as other events)                           |


### Optional Fields


| Field        | Type   | Description                                       |
| ------------ | ------ | ------------------------------------------------- |
| `variant_id` | string | Variant identifier if your products have variants |
| `language`   | string | Browser language                                  |


### Example Request

```bash
curl -X POST "https://api.omnios.app/saveShopifyPixelData?omni_business_id=b_tlfs" \
  -H "Content-Type: application/json" \
  -H "X-Forwarded-For: 203.0.113.42" \
  -d '{
    "event_name": "product_added_to_cart",
    "event_id": "evt_8a3f9c12",
    "event_timestamp": "2026-04-06T14:05:12.000Z",
    "omniBusinessId": "b_tlfs",
    "omni_hash_fingerprint": "cbc85a743b866dc37f798f30d293c7e8a234b026f2f37254d1ef6fcf293ce7be",
    "product_id": "prod-001",
    "product_name": "Classic T-Shirt",
    "quantity": 1,
    "total_price": 40.00,
    "currency": "USD",
    "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "referrer": "https://mystore.com/products/classic-tshirt",
    "host_name": "mystore.com",
    "params": { "utm_source": "facebook", "utm_medium": "cpc", "fbclid": "IwAR0abc123def456" },
    "cookies": { "fbp": "fb.1.1711234567890.1234567890" }
  }'
```

### Response


| Status | Body                                                                | Meaning                                                 |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------- |
| `200`  | `{ "fingerprintId": 12345, "sessionId": 67890 }`                    | Add-to-cart recorded and linked to the visitor session. |
| `500`  | `{ "error": "An error occurred while saving Shopify Pixel Data." }` | Omni-side error. Retry with exponential backoff.        |


> [!TIP]
> **Attribution is driven entirely by `omni_hash_fingerprint`.** As long as the same hash is sent on `page_viewed`, `product_added_to_cart`, `checkout_started`, `checkout_completed`, and the order webhook (as a top-level body field — see Part 2), Omni will link all the activity to the same visitor session.

---

## Part 2: Order Webhook

After a customer completes an order in your system, your **backend server** posts the full order to Omni. This is the authoritative record Omni uses for revenue, attribution to ad platforms, COGS, and customer matching.

> [!IMPORTANT]
> **This is a server-to-server call.** Do **not** send it from the browser. Trigger it from your order-creation handler (e.g. after your payment processor confirms the charge, or from your order-management system's webhook).

### Endpoint

`**POST /customOrders/webhook/save`**


| Header         | Type   | Required | Description                |
| -------------- | ------ | -------- | -------------------------- |
| `Content-Type` | string | Yes      | Must be `application/json` |



| Query Parameter    | Type   | Required | Description                      |
| ------------------ | ------ | -------- | -------------------------------- |
| `omni_business_id` | string | Yes      | Your Omni Business ID (`b_tlfs`) |


### Top-Level Request Body


| Field                   | Type            | Required                     | Description                                                                                                                                                                                           |
| ----------------------- | --------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orderID`               | string | number | Yes                          | Your unique order identifier (same value as `payload.id` below)                                                                                                                                       |
| `omniBusinessId`        | string          | Yes                          | Your Business ID (`b_tlfs`)                                                                                                                                                                           |
| `omni_hash_fingerprint` | string          | **Required for attribution** | The SHA-256 fingerprint hash from the visitor's `omni_fingerprint` cookie at checkout time. Same value you sent on every browser event. This is how Omni links the order back to the visitor session. |
| `payload`               | object          | Yes                          | The full order object — see schema below                                                                                                                                                              |


### `payload` Object Schema

Map your order fields to the schema below. Send what you have — Omni handles missing fields gracefully — but the fields marked **Required** must be present for the order to be stored.

#### Top-Level Order Fields

Money values are plain numbers (or numeric strings) in the order's `currency`.


| Field                    | Type            | Required    | Description                                                                                                                                                                       |
| ------------------------ | --------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                     | string | number | Yes         | Your unique order ID (matches the top-level `orderID`)                                                                                                                            |
| `created_at`             | string          | Yes         | ISO 8601 timestamp when the order was placed. Drives the hour bucket in our hourly revenue/profit dashboards.                                                                     |
| `updated_at`             | string          | Recommended | ISO 8601 — last time the order changed on your side. Sent on every re-post so Omni knows it's a newer version.                                                                    |
| `processed_at`           | string          | Optional    | ISO 8601 — when payment cleared (defaults to `created_at` if omitted)                                                                                                             |
| `currency`               | string          | Yes         | ISO 4217 currency code (e.g. `"USD"`). Applies to all money fields.                                                                                                               |
| `total_price`            | string | number | Yes         | Order total customer paid (items + tax + shipping − discounts). Drives `revenue` in the dashboard.                                                                                |
| `total_line_items_price` | string | number | Yes         | Sum of line item prices × quantities, **before** any discounts. Drives `total_gross_sales`.                                                                                       |
| `subtotal_price`         | string | number | Yes         | Items after discounts, before tax / shipping. Used by retention and Facebook Custom Audience queries.                                                                             |
| `total_tax`              | string | number | Recommended | Total tax on the order. Drives `total_tax` in the dashboard.                                                                                                                      |
| `total_shipping_price`   | string | number | Recommended | Total shipping charged to the customer. Drives `total_shipping`.                                                                                                                  |
| `total_discounts`        | string | number | Recommended | Total discounts applied. Drives `total_discounts`.                                                                                                                                |
| `financial_status`       | string          | Recommended | e.g. `"paid"`, `"pending"`, `"refunded"`                                                                                                                                          |
| `fulfillment_status`     | string          | Optional    | e.g. `"fulfilled"`, `"partial"`, `null`                                                                                                                                           |
| `order_number`           | number          | Recommended | Human-readable order number                                                                                                                                                       |
| `name`                   | string          | Recommended | Display name (e.g. `"#1001"`)                                                                                                                                                     |
| `cancelled_at`           | string          | Optional    | ISO 8601 when the order was cancelled                                                                                                                                             |
| `cancel_reason`          | string          | Optional    | Reason if cancelled                                                                                                                                                               |
| `checkout_token`         | string          | Optional    | Checkout identifier if available                                                                                                                                                  |
| `note`                   | string          | Optional    | Free-text order note                                                                                                                                                              |
| `tags`                   | string          | Optional    | Comma-separated order tags                                                                                                                                                        |
| `payment_gateway_names`  | array           | Optional    | e.g. `["stripe"]`                                                                                                                                                                 |
| `source_name`            | string          | Optional    | Order source, e.g. `"web"`                                                                                                                                                        |
| `browser_ip`             | string          | Optional    | Customer's IP at checkout                                                                                                                                                         |
| `customer`               | object          | Yes         | Customer object — see schema                                                                                                                                                      |
| `shipping_address`       | object          | Recommended | Shipping address object                                                                                                                                                           |
| `line_items`             | array           | Yes         | Array of line items — see schema                                                                                                                                                  |
| `discount_codes`         | array           | Optional    | Array of `{ code, amount, type }`                                                                                                                                                 |


> [!NOTE]
> **Fields Omni computes for you — do not send.**
>
> - `cogs`, `transaction_fee`, `shipping_cost` — computed by Omni.
> - `customer.orders_count` — Omni derives this from prior orders for the same customer (matched on `customer.id`, falling back to `email` then `phone`). Drives the new-customer metric.
>
> Any extra fields you send beyond the schema above are silently ignored — so it's safe to forward your full internal order object if that's easier.

#### `customer` Object


| Field               | Type            | Required    | Description                                     |
| ------------------- | --------------- | ----------- | ----------------------------------------------- |
| `id`                | string | number | Yes         | Your stable customer identifier                 |
| `email`             | string          | Yes         | Customer email                                  |
| `first_name`        | string          | Recommended |                                                 |
| `last_name`         | string          | Recommended |                                                 |
| `phone`             | string          | Recommended |                                                 |
| `created_at`        | string          | Recommended | ISO 8601 — when the customer record was created |
| `updated_at`        | string          | Recommended | ISO 8601                                        |
| `currency`          | string          | Optional    | Customer's preferred currency                   |
| `accepts_marketing` | boolean         | Optional    |                                                 |
| `tags`              | string          | Optional    |                                                 |
| `default_address`   | object          | Optional    | Same shape as `shipping_address`                |


#### `shipping_address` Object


| Field           | Type   | Description                     |
| --------------- | ------ | ------------------------------- |
| `address1`      | string | Street address                  |
| `address2`      | string | Apt / suite                     |
| `city`          | string |                                 |
| `province`      | string | State/region name               |
| `province_code` | string | State/region code (e.g. `"CA"`) |
| `country`       | string | Country name                    |
| `country_code`  | string | ISO country code (e.g. `"US"`)  |
| `zip`           | string | Postal code                     |
| `first_name`    | string |                                 |
| `last_name`     | string |                                 |
| `phone`         | string |                                 |


#### `line_items[]` Object


| Field                  | Type            | Required    | Description                                  |
| ---------------------- | --------------- | ----------- | -------------------------------------------- |
| `id`                   | string | number | Yes         | Unique line item ID                          |
| `product_id`           | string | number | Yes         | Your product ID                              |
| `variant_id`           | string | number | Recommended | Your variant ID                              |
| `title`                | string          | Yes         | Product title                                |
| `name`                 | string          | Recommended | Display name (often `title + variant_title`) |
| `variant_title`        | string          | Optional    |                                              |
| `sku`                  | string          | Recommended |                                              |
| `quantity`             | number          | Yes         |                                              |
| `price`                | string | number | Yes         | Unit price in store currency                 |
| `total_discount`       | string | number | Optional    | Per-line discount amount                     |
| `grams`                | number          | Optional    | Weight                                       |
| `requires_shipping`    | boolean         | Optional    |                                              |
| `taxable`              | boolean         | Optional    |                                              |
| `vendor`               | string          | Optional    |                                              |
| `tax_lines`            | array           | Optional    | Array of `{ price, rate, title }`            |
| `discount_allocations` | array           | Optional    | Array of `{ amount }`                        |
| `properties`           | array           | Optional    | Array of `{ name, value }` custom properties |


### Attribution Linking

Omni resolves the order to a browser session in this priority order:

1. **Matching `checkout_completed` event** — if you fired `checkout_completed` earlier with the same `order_id` as `payload.id`, the link is automatic.
2. **Top-level `omni_hash_fingerprint`** — Omni uses the hash to find the visitor and their most recent session. **This is the primary mechanism for your integration.**
3. **Customer email / phone** — final fallback when neither of the above matches.

> [!IMPORTANT]
> **Best practice:** always include `omni_hash_fingerprint` as a top-level body field on the order webhook — it's the same hash value you've been sending on every browser event.

### Example Request

```bash
curl -X POST "https://api.omnios.app/customOrders/webhook/save?omni_business_id=b_tlfs" \
  -H "Content-Type: application/json" \
  -d '{
    "orderID": "ORD-2026-04-00123",
    "omniBusinessId": "b_tlfs",
    "omni_hash_fingerprint": "cbc85a743b866dc37f798f30d293c7e8a234b026f2f37254d1ef6fcf293ce7be",
    "payload": {
      "id": "ORD-2026-04-00123",
      "order_number": 1001,
      "name": "#1001",
      "created_at": "2026-04-06T14:15:00.000Z",
      "updated_at": "2026-04-06T14:15:00.000Z",
      "processed_at": "2026-04-06T14:15:00.000Z",
      "currency": "USD",
      "financial_status": "paid",
      "fulfillment_status": null,
      "payment_gateway_names": ["stripe"],
      "source_name": "web",
      "checkout_token": "chk_7d8e9f",
      "browser_ip": "203.0.113.42",
      "note": null,
      "tags": "web,first-purchase",
      "total_price":            "132.50",
      "subtotal_price":         "120.00",
      "total_tax":              "7.50",
      "total_shipping_price":   "5.00",
      "total_discounts":        "0.00",
      "total_line_items_price": "120.00",
      "customer": {
        "id": "cust-555",
        "email": "customer@example.com",
        "first_name": "Jane",
        "last_name": "Doe",
        "phone": "+15551234567",
        "created_at": "2025-11-01T10:00:00.000Z",
        "updated_at": "2026-04-06T14:15:00.000Z",
        "currency": "USD",
        "accepts_marketing": true,
        "default_address": {
          "address1": "123 Main St",
          "city": "Austin",
          "province": "Texas",
          "province_code": "TX",
          "country": "United States",
          "country_code": "US",
          "zip": "78701"
        }
      },
      "shipping_address": {
        "first_name": "Jane",
        "last_name": "Doe",
        "address1": "123 Main St",
        "city": "Austin",
        "province": "Texas",
        "province_code": "TX",
        "country": "United States",
        "country_code": "US",
        "zip": "78701",
        "phone": "+15551234567"
      },
      "discount_codes": [],
      "line_items": [
        {
          "id": "li-001",
          "product_id": "prod-001",
          "variant_id": "var-001",
          "title": "Classic T-Shirt",
          "name": "Classic T-Shirt - Medium",
          "variant_title": "Medium",
          "sku": "TS-CLASSIC-M",
          "quantity": 1,
          "price": "40.00",
          "total_discount": "0.00",
          "requires_shipping": true,
          "taxable": true,
          "tax_lines": [{ "price": "2.50", "rate": 0.0625, "title": "State Tax" }]
        },
        {
          "id": "li-002",
          "product_id": "prod-002",
          "variant_id": "var-002",
          "title": "Baseball Cap",
          "name": "Baseball Cap - Black",
          "variant_title": "Black",
          "sku": "CAP-BLK",
          "quantity": 2,
          "price": "40.00",
          "total_discount": "0.00",
          "requires_shipping": true,
          "taxable": true,
          "tax_lines": [{ "price": "5.00", "rate": 0.0625, "title": "State Tax" }]
        }
      ]
    }
  }'
```

### Response


| Status | Body                                     | Meaning                                                                                                                                                     |
| ------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`  | `Order webhook received`                 | Order accepted and stored.                                                                                                                                  |
| `200`  | `Received with errors, but acknowledged` | Omni encountered an error processing the payload. Check logs / contact Omni — do not retry blindly; the response is acknowledged so you don't double-write. |


> [!NOTE]
> The endpoint always responds `200` to avoid retry storms. Successful storage is indicated by the body `Order webhook received`. Any other body means inspect the payload for missing required fields.

### When to Fire


| Event                                               | Send Webhook? | Notes                                                  |
| --------------------------------------------------- | ------------- | ------------------------------------------------------ |
| Order created                                       | **Yes**       | Send immediately after payment confirmation            |
| Order updated (edits, refunds, fulfillment changes) | **Yes**       | Resend the full updated payload — Omni upserts on `id` |
| Order cancelled                                     | **Yes**       | Set `cancelled_at` and `cancel_reason` in the payload  |


> [!TIP]
> Omni upserts on `payload.id`. You can safely resend the same order multiple times — each call updates the existing record. Use this for retries and for ongoing order state changes.

---

## End-to-End Timing Diagram

```
Customer lands ──────────────► /generateHashFingerprint → store hash in cookie
                                /saveShopifyPixelData (page_viewed)
                                  └─ omni_hash_fingerprint

Customer adds item to cart ──► /saveShopifyPixelData (product_added_to_cart)
                                  └─ omni_hash_fingerprint

Customer clicks checkout ────► /saveShopifyPixelData (checkout_started)
                                  └─ omni_hash_fingerprint

Customer completes payment ──► /saveShopifyPixelData (checkout_completed)
                                  └─ omni_hash_fingerprint + order_id

Your backend creates order ──► /customOrders/webhook/save (server-to-server)
                                  └─ payload.id = order_id
                                  └─ top-level omni_hash_fingerprint
                                       (same hash from the cookie)
```

---

## Testing


| Step | Action                                                                                                                          | Expected Outcome                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1    | Fire a `product_added_to_cart` event with the visitor's `omni_hash_fingerprint`                                                 | Response contains `fingerprintId` and `sessionId`                    |
| 2    | Fire a second `product_added_to_cart` with the same `omni_hash_fingerprint`                                                     | Same `sessionId` returned                                            |
| 3    | Fire `checkout_started` and `checkout_completed` reusing the same hash                                                          | Same `sessionId` returned                                            |
| 4    | From your server, POST a test order to `/customOrders/webhook/save` with the same `omni_hash_fingerprint` at the body top-level | Response body is `Order webhook received`                            |
| 5    | Re-POST the same order with an updated total                                                                                    | Response is `Order webhook received`; Omni's record updates in place |


> [!TIP]
> Use the development base URL `https://devapi.omnios.app` for testing. Swap to `https://api.omnios.app` for production.

---

## Troubleshooting


| Symptom                                                            | Likely Cause                                                                                    | Fix                                                                                                                                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product_added_to_cart` returns `fingerprintId` but no `sessionId` | No `page_viewed` event was fired before the add-to-cart                                         | Ensure `page_viewed` fires on every page load, including product pages                                                                                    |
| Order webhook returns `Received with errors, but acknowledged`     | Missing required fields in `payload` (e.g. `id`, `created_at`, `customer.id`)                   | Verify required fields exist; ensure money values are plain numbers/strings and `payload.currency` is set                                                 |
| Order appears in Omni but is attributed to "Direct" / no session   | Top-level `omni_hash_fingerprint` is missing or doesn't match the hash sent on browser events   | Confirm the same hash from the `omni_fingerprint` cookie is forwarded to your backend at checkout and sent as a top-level body field on the order webhook |
| Hash sent on order webhook doesn't match what's stored in Omni     | Hash was regenerated (cookie cleared) between checkout and webhook firing                       | Capture the hash from the `omni_fingerprint` cookie *at checkout time* and persist it on the order on your side before sending the webhook                |
| `total_price` looks wrong in the dashboard                         | Currency conversion — values are converted to USD on ingest using the order's `created_at` date | Confirm `payload.currency` is set to the correct ISO 4217 code                                                                                            |
| Order webhook 500s on your side                                    | Network/timeout from your server to Omni                                                        | Retry with exponential backoff. Omni upserts, so retries are safe.                                                                                        |


---

## Implementation Checklist

### Add to Cart Event

- `product_added_to_cart` fires on every "Add to Cart" click
- `product_id`, `product_name`, `quantity`, `total_price`, and `currency` are populated
- `omni_hash_fingerprint`, `omniBusinessId`, and `event_timestamp` are present on every call
- `omni_business_id` is included as a **query parameter** on the request URL
- `params` and `cookies` objects carry the same landing-page values you send on other events

### Order Webhook

- Webhook is sent from your **backend server**, not the browser
- Triggered immediately after payment confirmation and again on any order update
- `omni_business_id` query param is present and matches body's `omniBusinessId`
- `orderID` at the top level matches `payload.id`
- `payload.id`, `payload.created_at`, `payload.currency`, `payload.customer.id`, and `payload.line_items` are all populated
- `payload.total_price`, `payload.subtotal_price`, and `payload.total_line_items_price` are sent as plain numbers or numeric strings
- `payload.total_tax`, `payload.total_shipping_price`, and `payload.total_discounts` are sent when applicable
- Top-level body includes `omni_hash_fingerprint` set to the value from the `omni_fingerprint` cookie at checkout time
- The hash on the order webhook is the **same value** stored in the `omni_fingerprint` cookie during the customer's session (capture it at checkout and persist it on the order before sending the webhook)
- You are **not** sending `session_id`, `fingerprint_id`, `transaction_fee`, `shipping_cost`, or `customer.orders_count` — Omni handles these
- Order updates resend the full payload (Omni upserts on `payload.id`)
- Retries use exponential backoff

