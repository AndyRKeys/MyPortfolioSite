import { requireAuth, setLogout } from './admin/auth.js';
import { initPasskeys }           from './admin/passkeys.js';

requireAuth();
setLogout();
initPasskeys();
