// ── Admin hub — imports and initialises all admin modules ─────────────────────
import { requireAuth, setLogout } from './admin/auth.js';
import { initTravel }             from './admin/travel.js';
import { initPosts }              from './admin/posts.js';
import { initCv }                 from './admin/cv.js';
import { initDeploy }             from './admin/deploy.js';
import { initPasskeys }           from './admin/passkeys.js';
import { initStats }              from './admin/stats.js';
import { initNotes }              from './admin/notes.js';

requireAuth();
setLogout();
initTravel();
initPosts();
initCv();
initDeploy();
initPasskeys();
initNotes();
initStats();
