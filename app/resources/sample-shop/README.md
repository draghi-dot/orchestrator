# Sample Shop

A small local storefront. Run `node server.mjs`. It listens on HOST and PORT
(default 127.0.0.1:3000). No install step or external services are required.

## Product and checkout rules

- A notebook costs $60. The default cart has two notebooks ($120 subtotal).
- SAVE10 gives 10% off; SAVE20 gives 20% off. Discount applies to the subtotal.
- `total` means the discounted merchandise amount; `shipping` is reported separately.
- Shipping costs $8 and is free for a subtotal of $100 or more, before discount.
- Quantity must be an integer between 1 and 99, inclusive. Other quantities return HTTP 422.
- An unknown coupon returns HTTP 422 with `error: "invalid_code"`.
- Orders are private. A signed-in customer may only read their own orders.
  Reading another customer's order must return HTTP 403.

## HTTP API

- `GET /api/cart?code=SAVE20&quantity=2`: subtotal, discount, total, shipping.
- `GET /api/shipping?subtotal=100`: shipping cost for the given subtotal.
- `GET /api/orders/101`: Alice's order.
- `GET /api/orders/102`: Bob's order.
- `GET /api/session`: the current customer's name (401 without authentication).

## Test accounts

The QA host provides the `alice` and `bob` accounts. Use the host's named-account
HTTP tool to act as either customer. Credentials are generated and injected by
the host at startup; they are not part of this source snapshot.
