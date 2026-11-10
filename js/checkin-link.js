/**
 * Builds the URL encoded in the QR code.
 *  - rotating QR: check-in.html?m=<meeting id>&c=<15-second code>
 *  - static link: check-in.html?token=<meeting secret>
 * `configuredBase` (js/config.js checkInBaseUrl) may be an origin, a directory or a
 * full check-in.html URL; empty means "next to the current page".
 */
export function buildCheckInUrl(params, currentHref, configuredBase = "") {
  const base = String(configuredBase || "").trim();
  let link;
  if (base) {
    link = new URL(base, currentHref);
    if (!/check-in\.html$/i.test(link.pathname)) {
      link = new URL("check-in.html", link.href.endsWith("/") ? link.href : `${link.href}/`);
    }
  } else {
    link = new URL("check-in.html", currentHref);
  }
  link.search = "";
  link.hash = "";
  for (const [key, value] of Object.entries(params)) link.searchParams.set(key, value);
  return link;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[0-9]{1,12}\.[0-9a-f]{20}$/;

/** Reads the check-in page query string. Returns null when it is not a usable link. */
export function parseCheckInParams(search) {
  const params = new URLSearchParams(search);
  const meetingId = (params.get("m") || "").trim();
  const code = (params.get("c") || "").trim();
  const token = (params.get("token") || "").trim();
  if (UUID.test(meetingId) && CODE.test(code)) return { kind: "rotating", meetingId: meetingId.toLowerCase(), code };
  if (token.length >= 32 && token.length <= 160) return { kind: "static", token };
  return null;
}

export function isLoopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127(?:\.\d{1,3}){3}$/.test(host);
}
