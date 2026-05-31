// ── Admin dashboard entry point (#378) ────────────────────────────────────────
// The dashboard is a static navigation page — no section modules needed here.
// Each sub-page loads only its own module via admin-*-page.js entry points.
import { requireAuth, setLogout } from './admin/auth.js';

requireAuth();
setLogout();
