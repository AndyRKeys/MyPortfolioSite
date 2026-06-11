import { requireAuth, setLogout } from './admin/auth.js';
import { initActivity }           from './admin/activity.js';

requireAuth();
setLogout();
initActivity();
