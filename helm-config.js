/* Helm — public runtime config.
   These two values are SAFE to ship in client code:
   the anon key is a public, RLS-scoped key (it grants nothing without a valid
   user session), and the URL is just your project endpoint. Your data is
   protected by Row-Level Security + end-to-end encryption, not by hiding these.

   To go live, create a Supabase project (see SUPABASE_SETUP.md) and paste the
   Project URL and the anon/public key below. Until both are filled in, Helm
   runs exactly as before — fully offline, on-device only, no accounts. */
window.HELM_CONFIG = {
  SUPABASE_URL: "https://kwcowblxeyoqfviirpoo.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_Ge5UQhkHkkYPAjnbcLYOOQ_f7DQoqvH",  // public, RLS-gated publishable key
};
