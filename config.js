/*
Project configuration.

Replace the placeholders below with the config from the TLS Firebase project — Project
settings, General, "Your apps", the web app's config object. See SETUP.md for the walkthrough.

None of this is secret. A Firebase web config ships to every browser that loads the page by
design; it identifies the project, it does not authorise anything. What actually protects the
data is firestore.rules plus staff sign-in, not hiding these values.
*/

export const FIREBASE_CONFIG = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.firebasestorage.app",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME",
};

// Shown in the sign-in prompt so staff know which account to use. The real allowlist lives in
// firestore.rules — this is a label, and changing it grants nobody anything.
export const STAFF_HINT = "Sign in with your The Loading Screen staff Google account.";

export const ORG = "TLS";
export const DIVISIONS = ["Surge", "Hardwire", "Overclock"];
