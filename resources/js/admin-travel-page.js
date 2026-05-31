import { requireAuth, setLogout } from './admin/auth.js';
import { initTravel }             from './admin/travel.js';

requireAuth();
setLogout();
initTravel();
