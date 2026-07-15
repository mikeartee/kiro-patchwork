// Checkout pricing logic for the Patchwork sample app.
//
// LOCAL-ONLY grounding for Kiro Patchwork incident drills. Kept tiny and
// dependency-light (no framework), matching the rest of the repo. The pricing
// logic lives here as pure, synchronous, exported functions so it can be
// unit-tested without starting a live server (see server.js for the HTTP
// surface, which binds to localhost only and is never deployed).
//
// _Requirements: 14.1, 14.5_

/**
 * The coupon catalogue. Each coupon carries a flat `discount` (in whole
 * currency units) applied to the cart subtotal. Coupons intentionally carry no
 * loyalty/tier metadata.
 */
export const COUPONS = {
  SAVE5: { code: 'SAVE5', discount: 5 },
  SAVE10: { code: 'SAVE10', discount: 10 },
  WELCOME: { code: 'WELCOME', discount: 15 },
};

/**
 * Apply zero or more coupon codes to a cart and return the discounted total.
 * Unknown coupon codes are ignored. The total never drops below zero.
 *
 * @param {{ subtotal: number }} cart
 * @param {string[]} couponCodes
 * @returns {number} the discounted total, floored at 0.
 */
export function applyCoupons(cart, couponCodes) {
  let total = cart.subtotal;
  for (const code of couponCodes) {
    const coupon = COUPONS[code];
    if (!coupon) continue; // unknown coupon code: ignore it
    total -= coupon.discount;
  }
  return Math.max(0, total);
}

/**
 * Compute a checkout result from a parsed request body. Pure and synchronous so
 * task 6.3's reproduction test can drive it directly, no live server required.
 *
 * @param {{ subtotal?: number, coupons?: string[] }} body
 * @returns {{ subtotal: number, coupons: string[], total: number }}
 */
export function computeCheckout(body) {
  const subtotal = Number(body?.subtotal ?? 0);
  const coupons = Array.isArray(body?.coupons) ? body.coupons : [];
  const total = applyCoupons({ subtotal }, coupons);
  return { subtotal, coupons, total };
}
