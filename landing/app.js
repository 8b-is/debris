/**
 * app.js — tier CTAs and error rendering.
 *
 * The only network call this page makes is POST /api/checkout. No analytics, no
 * CDN, no font, no tag manager.
 *
 * The price table is a local copy of server/src/plans.ts. A test in the server
 * lane compares the two and fails if they diverge, which is what makes the
 * duplication safe (docs/adr/0004-static-landing-that-stands-alone.md).
 */

const TIERS = Object.freeze([
  Object.freeze({ id: "free", name: "Free", cents: 0, seats: 1, recommended: false }),
  Object.freeze({ id: "family", name: "Family", cents: 490, seats: 5, recommended: false }),
  Object.freeze({ id: "household", name: "Household", cents: 990, seats: 12, recommended: true }),
]);

const CHECKOUT_URL = "/api/checkout";

/**
 * Render integer cents as a euro amount. The currency symbol exists only here,
 * so no layer above this ever sees a float.
 */
function formatPrice(cents) {
  const whole = Math.trunc(cents / 100);
  const rest = Math.abs(cents % 100);
  return `€${whole}.${String(rest).padStart(2, "0")}`;
}

function tierMarkup(tier) {
  const badge = tier.recommended
    ? ' <span class="pill pill--gold">most families</span>'
    : "";
  const price = tier.cents === 0 ? "free" : `${formatPrice(tier.cents)}<span class="per">/mo</span>`;
  return `
      <article class="card tier${tier.recommended ? " tier--recommended" : ""}" data-tier="${tier.id}">
        <div class="tier__head">
          <h3 class="tier__name">${tier.name}${badge}</h3>
          <p class="tier__price">${price}</p>
          <p class="tier__seats">${tier.seats} ${tier.seats === 1 ? "seat" : "seats"}</p>
        </div>
        <button class="btn btn--primary tier__cta" type="button" data-plan="${tier.id}">choose ${tier.name}</button>
      </article>`;
}

function renderTiers(root) {
  if (!root) return;
  root.innerHTML = TIERS.map(tierMarkup).join("");
}

/**
 * POST a tier to the checkout endpoint.
 *
 * On success the browser is handed to the returned url. On a 400 the server's
 * own error string is rendered verbatim: a client that paraphrases a server
 * error will eventually paraphrase it wrong.
 */
async function requestCheckout(plan, email) {
  const res = await fetch(CHECKOUT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ plan, email }),
  });

  const body = await res.json().catch(() => null);

  if (res.ok && body && typeof body.url === "string") {
    window.location.assign(body.url);
    return { ok: true, url: body.url };
  }

  const error = body && typeof body.error === "string" ? body.error : `http_${res.status}`;
  return { ok: false, error };
}

function showError(alertEl, message) {
  if (!alertEl) return;
  alertEl.textContent = message;
  alertEl.hidden = false;
}

function clearError(alertEl) {
  if (!alertEl) return;
  alertEl.textContent = "";
  alertEl.hidden = true;
}

function init() {
  const tierRoot = document.querySelector("[data-tiers]");
  renderTiers(tierRoot);

  const form = document.querySelector("[data-checkout-form]");
  const emailInput = form?.querySelector("input[type=email]");
  const alertEl = document.querySelector("[data-checkout-alert]");
  const buttons = Array.from(document.querySelectorAll(".tier__cta"));
  const patronRow = document.querySelector("[data-tier-patron]");

  // Patron is a footnote row, not a card: it is wired but visually quiet.
  if (patronRow) {
    patronRow.addEventListener("click", () => {
      void startCheckout("patron", emailInput, alertEl, buttons);
    });
  }

  tierRoot?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest(".tier__cta");
    if (!(button instanceof HTMLButtonElement)) return;
    void startCheckout(button.dataset.plan, emailInput, alertEl, buttons);
  });

  // Enter in the email field starts the recommended tier rather than whichever
  // card happens to be first in the DOM.
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const preferred =
      buttons.find((b) => b.dataset.plan === "household") ?? buttons[0];
    if (preferred instanceof HTMLButtonElement) {
      void startCheckout(preferred.dataset.plan, emailInput, alertEl, buttons);
    }
  });

  emailInput?.addEventListener("input", () => clearError(alertEl));
}

async function startCheckout(plan, emailInput, alertEl, buttons) {
  const email = typeof emailInput?.value === "string" ? emailInput.value.trim() : "";
  if (!plan) return;

  clearError(alertEl);

  // The form carries `novalidate`, so the browser will not check the field for
  // us. Without this, "not-an-email" is POSTed and comes back as email_required,
  // which is a worse answer than saying so before the request.
  if (!email) {
    showError(alertEl, "email_required");
    emailInput?.focus();
    return;
  }
  if (emailInput && !emailInput.checkValidity()) {
    showError(alertEl, "invalid_email");
    emailInput.focus();
    return;
  }

  for (const b of buttons) b.disabled = true;

  try {
    const result = await requestCheckout(plan, email);
    if (!result.ok) showError(alertEl, result.error);
  } catch {
    // A network failure is reported, not swallowed: the family must know the
    // button did nothing rather than assume it worked.
    showError(alertEl, "network_error");
  } finally {
    for (const b of buttons) b.disabled = false;
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
}