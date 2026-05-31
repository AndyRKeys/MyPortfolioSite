import { requireAuth, setLogout } from './admin/auth.js';
import { initDeploy }             from './admin/deploy.js';

requireAuth();
setLogout();
initDeploy();
