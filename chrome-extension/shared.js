/* Shared helpers for the devtools page and the panel. */

// Firefox exposes the same APIs under `browser`; Chrome under `chrome`.
// eslint-disable-next-line no-var
var api = typeof globalThis.browser !== "undefined" ? globalThis.browser : globalThis.chrome;

const DEFAULT_SETTINGS = {
  serverHost: "127.0.0.1",
  serverPort: 3025,
  logLimit: 50,
  queryLimit: 30000,
  stringSizeLimit: 500,
  maxLogSize: 20000,
  showRequestHeaders: false,
  showResponseHeaders: false,
  captureConsole: true,
  captureNetwork: true,
  captureResponseBodies: true,
  /**
   * "debugger" uses the Chrome DevTools Protocol: richer output, but the
   * browser shows a "started debugging" banner. "inject" wraps the page's
   * console instead — no banner, and it is the only mode Firefox supports.
   */
  captureMode: "debugger",
  /**
   * Off by default: running page scripts or synthesizing input is equivalent
   * to XSS on the user's logged-in session. Enabled from the panel only.
   */
  allowPageControl: false,
};

/**
 * Ports the connector may be listening on.
 *
 * Loopback only, and deliberately so: earlier versions scanned private
 * network ranges and adopted whichever host answered, which let anyone on the
 * same network receive a developer's console output and screenshots.
 */
const DISCOVERY_HOSTS = ["127.0.0.1", "localhost"];
const DISCOVERY_PORTS = [3025, 3026, 3027, 3028, 3029, 3030, 3031, 3032, 3033, 3034, 3035];
const SERVER_SIGNATURE = "mcp-browser-connector-24x7";

function loadSettings() {
  return new Promise((resolve) => {
    try {
      api.storage.local.get("btmcpSettings", (stored) => {
        resolve({ ...DEFAULT_SETTINGS, ...(stored && stored.btmcpSettings) });
      });
    } catch {
      resolve({ ...DEFAULT_SETTINGS });
    }
  });
}

function saveSettings(settings) {
  return new Promise((resolve) => {
    try {
      api.storage.local.set({ btmcpSettings: settings }, () => resolve());
    } catch {
      resolve();
    }
  });
}

/** Confirms a real connector is listening, rather than some other local server. */
async function checkServer(host, port, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${host}:${port}/.identity`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const identity = await response.json();
    return identity && identity.signature === SERVER_SIGNATURE ? identity : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Finds the connector on loopback. Tries the configured address first, then
 * the small default port range.
 */
async function discoverServer(settings) {
  const candidates = [];
  const seen = new Set();
  const add = (host, port) => {
    const key = `${host}:${port}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push({ host, port });
    }
  };

  if (DISCOVERY_HOSTS.includes(settings.serverHost)) {
    add(settings.serverHost, Number(settings.serverPort));
  }
  for (const host of DISCOVERY_HOSTS) {
    for (const port of DISCOVERY_PORTS) add(host, port);
  }

  // Probed together rather than one-at-a-time: the whole sweep is a couple of
  // dozen loopback requests and should take milliseconds, not half a minute.
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const identity = await checkServer(candidate.host, candidate.port);
      return identity ? { ...candidate, identity } : null;
    })
  );

  return results.find(Boolean) || null;
}

/*
 * Page-injection scripts for the "wrap page console" capture mode.
 *
 * Kept here rather than inside the devtools closure so the exact strings that
 * ship can be evaluated against a real page in tests. This mode is what runs
 * where chrome.debugger is unavailable, which includes Firefox.
 */
const INJECT_BOOTSTRAP = `
  (function () {
    if (window.__btmcpInstalled) return true;
    window.__btmcpInstalled = true;
    window.__btmcpBuffer = [];
    var levels = ["log", "info", "warn", "error", "debug"];
    levels.forEach(function (level) {
      var original = console[level];
      console[level] = function () {
        try {
          var parts = Array.prototype.map.call(arguments, function (arg) {
            if (typeof arg === "string") return arg;
            try { return JSON.stringify(arg); } catch (e) { return String(arg); }
          });
          if (window.__btmcpBuffer.length < 500) {
            window.__btmcpBuffer.push({
              level: level,
              message: parts.join(" "),
              timestamp: Date.now()
            });
          }
        } catch (e) { /* never break the page */ }
        return original.apply(console, arguments);
      };
    });
    window.addEventListener("error", function (event) {
      if (window.__btmcpBuffer.length < 500) {
        window.__btmcpBuffer.push({
          level: "error",
          message: String(event.message) + " (" + event.filename + ":" + event.lineno + ")",
          timestamp: Date.now()
        });
      }
    });
    window.addEventListener("unhandledrejection", function (event) {
      if (window.__btmcpBuffer.length < 500) {
        window.__btmcpBuffer.push({
          level: "error",
          message: "Unhandled promise rejection: " + String(event.reason),
          timestamp: Date.now()
        });
      }
    });
    return true;
  })()
`;

const INJECT_DRAIN = `
  (function () {
    if (!window.__btmcpBuffer) return [];
    var out = window.__btmcpBuffer;
    window.__btmcpBuffer = [];
    return out;
  })()
`;

/*
 * Helpers evaluated in the inspected page for runPageScript / interactWithPage.
 *
 * Kept as source strings (like the inject bootstrap) so tests can run the exact
 * code that ships, without going through the whole MCP stack.
 *
 * Serialization happens here so a DOM node never has to cross the extension
 * boundary. The final credential scrub and string budget are applied later, in
 * the connector — cutting to the display limit in the page is what used to
 * slice a token in half and hide it from the redactor.
 */
const PAGE_VALUE_CAP = 50_000;

const PAGE_VALUE_SERIALIZE = `
(function serializeBtmcpValue(value, seen) {
  seen = seen || [];
  if (value === undefined) return { __type: "undefined" };
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return { __type: "bigint", value: String(value) };
  if (typeof value === "symbol") return { __type: "symbol", value: String(value) };
  if (typeof value === "function") return { __type: "function", name: value.name || "" };
  if (typeof value === "string") {
    return value.length > ${PAGE_VALUE_CAP} ? value.slice(0, ${PAGE_VALUE_CAP}) : value;
  }
  if (typeof value !== "object") return String(value);
  for (var i = 0; i < seen.length; i++) if (seen[i] === value) return "[Circular]";
  if (typeof Element !== "undefined" && value instanceof Element) {
    return {
      __type: "element",
      tagName: value.tagName,
      id: value.id || undefined,
      className: typeof value.className === "string" && value.className ? value.className : undefined,
      textContent: String(value.textContent || "").slice(0, ${PAGE_VALUE_CAP})
    };
  }
  var next = seen.concat([value]);
  if (Array.isArray(value) || (typeof NodeList !== "undefined" && value instanceof NodeList) ||
      (typeof HTMLCollection !== "undefined" && value instanceof HTMLCollection)) {
    var max = 50;
    var out = [];
    var len = value.length;
    for (var j = 0; j < len && j < max; j++) out.push(serializeBtmcpValue(value[j], next));
    if (len > max) out.push({ __type: "truncated", remaining: len - max });
    return out;
  }
  var obj = {};
  var keys = Object.keys(value);
  var keyMax = 50;
  for (var k = 0; k < keys.length && k < keyMax; k++) {
    try { obj[keys[k]] = serializeBtmcpValue(value[keys[k]], next); }
    catch (e) { obj[keys[k]] = { __type: "error", error: String(e && e.message ? e.message : e) }; }
  }
  return obj;
})
`;

const PAGE_LOCATE_ELEMENT = `
(function locateBtmcpElement(selector) {
  var el = null;
  var matched = 0;
  if (!selector || selector === "$0") {
    el = typeof $0 !== "undefined" ? $0 : null;
    matched = el ? 1 : 0;
  } else {
    var nodes = document.querySelectorAll(selector);
    matched = nodes.length;
    el = nodes[0] || null;
  }
  if (!el || typeof el.getBoundingClientRect !== "function") return { matched: 0 };
  try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
  var r = el.getBoundingClientRect();
  return {
    matched: matched,
    x: r.x + r.width / 2,
    y: r.y + r.height / 2,
    width: r.width,
    height: r.height,
    tagName: el.tagName
  };
})
`;

/*
 * Credential scrubbing, performed in the browser.
 *
 * The server scrubs too, but by then the data has already crossed a socket and
 * been truncated. Truncation is what defeated detection in practice: a JWT cut
 * at 500 characters arrives with only its header and no longer looks like a
 * token. Scrubbing here, before anything is shortened, means a secret is
 * matched while it is still whole and never leaves the page at all.
 *
 * Kept deliberately in step with src/util/redact.ts. Both run — this one to
 * avoid transmitting secrets, that one as defence in depth for anything a
 * different client sends.
 */
const BTMCP_REDACTED = "[REDACTED]";

const BTMCP_SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
  /\b(?:sess|session|client|tok|token|auth|cred|secret|apikey)_[A-Za-z0-9]{16,}\b/gi,
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[A-Za-z0-9_-]{35}\b/g,
];

/**
 * Base64url starting with an encoded '{"'. Only a candidate — see btmcpIsJwt.
 * Plenty of harmless data is encoded this way, including Clerk image
 * parameters, so redacting on the prefix alone destroys useful URLs.
 */
const BTMCP_JWT_CANDIDATE = /\beyJ[A-Za-z0-9_-]{15,}(?:\.[A-Za-z0-9_-]+){0,2}/g;

const BTMCP_JWT_HEADER_FIELDS = /"(?:alg|typ|kid)"/;

function btmcpDecodeBase64Prefix(value) {
  // Decode whole base64 groups only; the tail is often cut off.
  const usable = value.slice(0, 40);
  const aligned = usable.slice(0, usable.length - (usable.length % 4));
  if (!aligned) return "";
  try {
    return atob(aligned.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return "";
  }
}

/** Three segments is JWT-shaped; fewer means checking the decoded header. */
function btmcpIsJwt(candidate) {
  if (candidate.split(".").length >= 3) return true;
  return BTMCP_JWT_HEADER_FIELDS.test(btmcpDecodeBase64Prefix(candidate.split(".")[0] || ""));
}

const BTMCP_AUTH_SCHEME = /\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._~+/=-]{16,}/gi;

const BTMCP_SECRETISH_KEY =
  /("(?:[^"]*(?:password|passwd|secret|token|api[_-]?key|apikey|credential|private[_-]?key|auth)[^"]*)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;

function scrubSecrets(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  let out = value;
  for (const pattern of BTMCP_SECRET_PATTERNS) out = out.replace(pattern, BTMCP_REDACTED);
  out = out.replace(BTMCP_JWT_CANDIDATE, (m) => (btmcpIsJwt(m) ? BTMCP_REDACTED : m));
  out = out.replace(BTMCP_AUTH_SCHEME, (m, scheme) => scheme + " " + BTMCP_REDACTED);
  out = out.replace(BTMCP_SECRETISH_KEY, (m, keyPart) => keyPart + '"' + BTMCP_REDACTED + '"');
  return out;
}

/** Scrub first, then shorten — the order is what makes detection work. */
/**
 * Scrubs every string on a selected-element payload, before truncating it.
 *
 * The element took a different path to every other capture: it was sliced
 * inside the page and sent as-is, so nothing scrubbed it in the browser and the
 * slicing happened first — the ordering that hid a token from the pattern that
 * would have caught it. Applied here so the element crosses the socket under
 * the same rule as console and network entries.
 */
function sanitiseSelectedElement(element, limit) {
  if (!element || typeof element !== "object") return element;

  var out = {};
  for (var key in element) {
    if (!Object.prototype.hasOwnProperty.call(element, key)) continue;
    var value = element[key];

    if (typeof value === "string") {
      out[key] = scrubAndTruncate(value, limit);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      var nested = {};
      for (var inner in value) {
        if (!Object.prototype.hasOwnProperty.call(value, inner)) continue;
        var innerValue = value[inner];
        nested[inner] =
          typeof innerValue === "string" ? scrubAndTruncate(innerValue, limit) : innerValue;
      }
      out[key] = nested;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function scrubAndTruncate(value, limit) {
  if (typeof value !== "string") return value;
  const scrubbed = scrubSecrets(value);
  return scrubbed.length > limit ? scrubbed.slice(0, limit) + "... (truncated)" : scrubbed;
}
