import { requireAuth, setLogout } from './admin/auth.js';
import { initStats }              from './admin/stats.js';

requireAuth();
setLogout();
initStats();
