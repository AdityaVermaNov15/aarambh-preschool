/* Your Supabase project settings (README step 2).
   The anon key is designed to be public: the database's Row Level Security
   rules decide what each signed-in person can see and change. */
window.SUPABASE_URL = "PASTE_SUPABASE_URL";          // e.g. https://abcdxyz.supabase.co
window.SUPABASE_ANON_KEY = "PASTE_SUPABASE_ANON_KEY";
/* Public VAPID key for phone alerts (README step 6). */
window.VAPID_PUBLIC_KEY = "PASTE_VAPID_PUBLIC_KEY";

/* School settings. Change these if the school is outside India. */
window.AARAMBH_CONFIG = {
  timeZone: "Asia/Kolkata",   // school's clock: decides "today" for attendance, menus and plans on every phone
  currency: "INR",            // fees currency (ISO code, e.g. USD, AED, GBP)
  locale: "en-IN",            // number formatting for fees
  countryCode: "+91",         // country code pre-selected on sign-up and log-in
  privacyUrl: "privacy.html"  // shown at sign-up (consent) and in Me → Privacy
};
