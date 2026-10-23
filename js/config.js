/* Public browser configuration only. Never place a Supabase service-role key here. */
window.GLADIUS_CONFIG = Object.freeze({
  supabaseUrl: "https://gbcvawpszyhaqaitysyf.supabase.co",
  supabasePublishableKey: "sb_publishable_YhmkgoUMgsBOGF5fRiihoQ_xJcAuX0P",
  checkInFunction: "check-in",
  // Optional: set to "http://192.168.1.41:3000/check-in.html" for LAN testing.
  // Prefer opening admin.html through the same LAN address; leave empty in production.
  checkInBaseUrl: ""
});
