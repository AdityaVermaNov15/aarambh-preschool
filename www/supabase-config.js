/* Your Supabase project settings (README step 2).
   The anon key is designed to be public: the database's Row Level Security
   rules decide what each signed-in person can see and change. */
window.SUPABASE_URL = "https://lpzzbgesznwbunxzmjzl.supabase.co";          // e.g. https://abcdxyz.supabase.co
window.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxwenpiZ2Vzem53YnVueHptanpsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxMzAxODksImV4cCI6MjEwNzcwNjE4OX0.pbbsqshtfRii_3cirOpNYX6gqDIjPH5rd22L99T4Ulg";
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
