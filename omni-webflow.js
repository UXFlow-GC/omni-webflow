/*
 * Omni Webflow Shared Tracking Script
 *
 * Install site-wide in Webflow before </body> or in Head with defer.
 *
 * Required per-site config before this script loads:
 *
 * <script>
 *   window.OMNI_CONFIG = {
 *     businessId: "b_tlfs",
 *     apiBase: "https://api.omnios.app",
 *     cookieDomain: ".example.com", // optional
 *     defaultCurrency: "AUD",        // optional
 *     debug: false                    // optional
 *   };
 * </script>
 * <script src="https://cdn.jsdelivr.net/gh/UXFlow-GC/omni-webflow@v1.0.0/omni-webflow.js" defer></script>
 *
 * Public API:
 *   window.Omni.ready()
 *   window.Omni.trackPageViewed()
 *   window.Omni.trackCheckoutStarted(data)
 *   window.Omni.trackCheckoutCompleted(data)
 *   window.Omni.getFingerprint()
 */
(function () {
  "use strict";

  var DEFAULT_CONFIG = {
    apiBase: "https://api.omnios.app",
    businessId: "b_tlfs",
    fingerprintCookieName: "omni_fingerprint",
    landingParamsStorageKey: "omni_landing_params",
    cookieSnapshotStorageKey: "omni_cookie_snapshot",
    sessionStartedStorageKey: "omni_session_started_at",
    defaultCurrency: "AUD",
    debug: false,
    autoTrackPageViews: true,
    pageViewDelayMs: 0
  };

  var config = Object.assign({}, DEFAULT_CONFIG, window.OMNI_CONFIG || {});

  if (!config.businessId) {
    warn("Missing OMNI_CONFIG.businessId; Omni tracking disabled.");
    return;
  }

  var state = {
    fingerprintPromise: null,
    pageTracked: false
  };

  window.Omni = window.Omni || {};
  Object.assign(window.Omni, {
    ready: ready,
    trackPageViewed: trackPageViewed,
    trackCheckoutStarted: trackCheckoutStarted,
    trackCheckoutCompleted: trackCheckoutCompleted,
    getFingerprint: getOrCreateFingerprint,
    getLandingParams: getLandingParams,
    getAdCookies: getAdCookies,
    config: config
  });

  initializeCompatibilityKeys();
  captureLandingParamsOnce();
  captureCookieSnapshot();

  if (config.autoTrackPageViews) {
    onReady(function () {
      setTimeout(function () {
        trackPageViewed().catch(function (error) {
          warn("page_viewed failed", error);
        });
      }, config.pageViewDelayMs);
    });
  }

  function ready() {
    return getOrCreateFingerprint();
  }

  async function trackPageViewed(extra) {
    if (state.pageTracked && !extra?.allowDuplicate) return null;
    state.pageTracked = true;

    return sendEvent(Object.assign(baseEvent("page_viewed"), {
      host_name: window.location.hostname,
      page_slug: window.location.pathname || "/",
      user_agent: navigator.userAgent || "",
      referrer: document.referrer || "",
      language: navigator.language || "",
      params: getLandingParams(),
      cookies: getAdCookies()
    }, stripInternalOptions(extra)));
  }

  async function trackCheckoutStarted(data) {
    var payload = Object.assign(baseEvent("checkout_started"), {
      total_price: numberOrZero(data && data.total_price),
      currency: upper(data && data.currency, config.defaultCurrency),
      item_count: numberOrZero(data && data.item_count),
      user_email: value(data && (data.user_email || data.email)),
      phone: value(data && data.phone),
      first_name: value(data && data.first_name),
      city: value(data && data.city),
      country: value(data && data.country),
      host_name: window.location.hostname,
      user_agent: navigator.userAgent || "",
      referrer: document.referrer || "",
      language: navigator.language || "",
      params: getLandingParams(),
      cookies: getAdCookies(),
      items: Array.isArray(data && data.items) ? data.items : undefined
    });

    return sendEvent(removeUndefined(payload));
  }

  async function trackCheckoutCompleted(data) {
    if (!data || !data.order_id) {
      throw new Error("trackCheckoutCompleted requires data.order_id");
    }

    var payload = Object.assign(baseEvent("checkout_completed"), {
      order_id: String(data.order_id),
      total: numberOrZero(data.total),
      subtotal: numberOrZero(data.subtotal),
      currency: upper(data.currency, config.defaultCurrency),
      email: value(data.email || data.user_email),
      phone: value(data.phone),
      first_name: value(data.first_name),
      last_name: value(data.last_name),
      city: value(data.city),
      country: value(data.country),
      state: value(data.state),
      payment_method: value(data.payment_method || "stripe"),
      discount_code: value(data.discount_code),
      tax_amount: optionalNumber(data.tax_amount),
      shipping_amount: optionalNumber(data.shipping_amount),
      user_agent: navigator.userAgent || "",
      referrer: document.referrer || "",
      params: getLandingParams(),
      cookies: getAdCookies(),
      items: Array.isArray(data.items) ? data.items : undefined
    });

    return sendEvent(removeUndefined(payload));
  }

  async function baseEvent(eventName) {
    return {
      event_name: eventName,
      event_id: makeEventId(eventName),
      event_timestamp: new Date().toISOString(),
      omniBusinessId: config.businessId,
      omni_hash_fingerprint: await getOrCreateFingerprint()
    };
  }

  async function sendEvent(eventPromiseOrObject) {
    var event = await eventPromiseOrObject;
    var url = config.apiBase.replace(/\/$/, "") + "/saveShopifyPixelData?omni_business_id=" + encodeURIComponent(config.businessId);

    log("Sending Omni event", event);

    var response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      keepalive: true
    });

    var body = await safeResponseJson(response);

    if (!response.ok) {
      var error = new Error("Omni event failed: " + response.status);
      error.response = body;
      throw error;
    }

    log("Omni event response", body);
    return body;
  }

  async function getOrCreateFingerprint() {
    var existing = getCookie(config.fingerprintCookieName);
    if (isValidFingerprint(existing)) return existing;

    if (!state.fingerprintPromise) {
      state.fingerprintPromise = generateFingerprint().then(function (hash) {
        setCookie(config.fingerprintCookieName, hash, {
          days: 365,
          domain: config.cookieDomain,
          sameSite: "Lax",
          secure: window.location.protocol === "https:"
        });
        return hash;
      }).catch(function (error) {
        state.fingerprintPromise = null;
        throw error;
      });
    }

    return state.fingerprintPromise;
  }

  async function generateFingerprint() {
    var url = config.apiBase.replace(/\/$/, "") + "/generateHashFingerprint";
    var payload = {
      userAgent: navigator.userAgent || "",
      screenResolution: getScreenResolution(),
      language: navigator.language || "",
      omniBusinessId: config.businessId
    };

    log("Generating Omni fingerprint", payload);

    var response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true
    });

    var body = await safeResponseJson(response);

    if (!response.ok || !body || !body.hash) {
      var error = new Error("Omni fingerprint generation failed");
      error.response = body;
      throw error;
    }

    return body.hash;
  }

  function initializeCompatibilityKeys() {
    try {
      if (!localStorage.getItem("omni_session_id")) {
        localStorage.setItem("omni_session_id", makeNumericSessionId());
      }

      if (!localStorage.getItem("omni_session_start_time")) {
        localStorage.setItem("omni_session_start_time", String(Date.now()));
      }

      localStorage.setItem("omni_session_last_activity", String(Date.now()));

      if (!localStorage.getItem("omni_initial_url")) {
        localStorage.setItem("omni_initial_url", window.location.href);
      }

      localStorage.setItem("omni_utms_applied", "1");

      getOrCreateFingerprint().then(function (fingerprint) {
        localStorage.setItem("omni_fingerprint", fingerprint);
      }).catch(function (_error) {});
    } catch (error) {
      warn("Could not initialize compatibility keys", error);
    }
  }

  function captureLandingParamsOnce() {
    try {
      if (sessionStorage.getItem(config.landingParamsStorageKey)) return;

      var params = {};
      var searchParams = new URLSearchParams(window.location.search || "");
      searchParams.forEach(function (value, key) {
        params[key] = value;
      });

      sessionStorage.setItem(config.landingParamsStorageKey, JSON.stringify(params));
      sessionStorage.setItem(config.sessionStartedStorageKey, new Date().toISOString());
    } catch (error) {
      warn("Could not capture landing params", error);
    }
  }

  function getLandingParams() {
    try {
      var stored = sessionStorage.getItem(config.landingParamsStorageKey);
      return stored ? JSON.parse(stored) : {};
    } catch (_error) {
      return {};
    }
  }

  function captureCookieSnapshot() {
    try {
      sessionStorage.setItem(config.cookieSnapshotStorageKey, JSON.stringify(readAdCookies()));
    } catch (error) {
      warn("Could not capture cookie snapshot", error);
    }
  }

  function getAdCookies() {
    var liveCookies = readAdCookies();
    var storedCookies = {};

    try {
      storedCookies = JSON.parse(sessionStorage.getItem(config.cookieSnapshotStorageKey) || "{}");
    } catch (_error) {}

    return Object.assign({}, storedCookies, liveCookies);
  }

  function readAdCookies() {
    var direct = parseCookies();
    var params = getLandingParams();

    return {
      fbp: direct._fbp || direct.fbp || "",
      fbc: direct._fbc || direct.fbc || makeFbcFromFbclid(params.fbclid),
      gcl_au: direct._gcl_au || direct.gcl_au || "",
      gcl_aw: direct._gcl_aw || direct.gcl_aw || "",
      gclid: direct.gclid || params.gclid || "",
      ttp: direct._ttp || direct.ttp || "",
      ttclid: direct.ttclid || params.ttclid || "",
      scid: direct._scid || direct.scid || params.scid || "",
      li_fat_id: direct.li_fat_id || params.li_fat_id || ""
    };
  }

  function makeFbcFromFbclid(fbclid) {
    if (!fbclid) return "";
    var timestamp = Math.floor(Date.now());
    return "fb.1." + timestamp + "." + fbclid;
  }

  function parseCookies() {
    return document.cookie.split(";").reduce(function (acc, part) {
      var pieces = part.trim().split("=");
      var key = decodeURIComponent(pieces.shift() || "");
      if (!key) return acc;
      acc[key] = decodeURIComponent(pieces.join("=") || "");
      return acc;
    }, {});
  }

  function getCookie(name) {
    return parseCookies()[name] || "";
  }

  function setCookie(name, value, options) {
    var opts = options || {};
    var cookie = encodeURIComponent(name) + "=" + encodeURIComponent(value) + "; path=/";

    if (opts.days) {
      var expires = new Date(Date.now() + opts.days * 24 * 60 * 60 * 1000);
      cookie += "; expires=" + expires.toUTCString();
    }
    if (opts.domain) cookie += "; domain=" + opts.domain;
    if (opts.sameSite) cookie += "; SameSite=" + opts.sameSite;
    if (opts.secure) cookie += "; Secure";

    document.cookie = cookie;
  }

  function getScreenResolution() {
    var width = window.screen && window.screen.width ? window.screen.width : window.innerWidth;
    var height = window.screen && window.screen.height ? window.screen.height : window.innerHeight;
    return width + "x" + height;
  }

  function makeNumericSessionId() {
    return String(Math.floor(Math.random() * 9000) + 1000);
  }

  function makeEventId(eventName) {
    return [
      "webflow",
      eventName,
      Date.now(),
      Math.random().toString(36).slice(2, 10)
    ].join("_");
  }

  function isValidFingerprint(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
  }

  function numberOrZero(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function optionalNumber(value) {
    if (value === undefined || value === null || value === "") return undefined;
    return numberOrZero(value);
  }

  function value(input) {
    if (input === undefined || input === null) return undefined;
    return String(input);
  }

  function upper(input, fallback) {
    return String(input || fallback || "").toUpperCase();
  }

  function stripInternalOptions(input) {
    if (!input) return {};
    var copy = Object.assign({}, input);
    delete copy.allowDuplicate;
    return copy;
  }

  function removeUndefined(object) {
    return Object.keys(object).reduce(function (acc, key) {
      if (object[key] !== undefined) acc[key] = object[key];
      return acc;
    }, {});
  }

  async function safeResponseJson(response) {
    try {
      return await response.json();
    } catch (_error) {
      return null;
    }
  }

  function onReady(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
    } else {
      callback();
    }
  }

  function log() {
    if (!config.debug) return;
    console.log.apply(console, ["[Omni]"].concat(Array.prototype.slice.call(arguments)));
  }

  function warn() {
    if (!config.debug) return;
    console.warn.apply(console, ["[Omni]"].concat(Array.prototype.slice.call(arguments)));
  }
})();
