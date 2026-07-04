import { requireAuth, setLogout } from './admin/auth.js';
import { initAiBlog }            from './admin/ai-blog.js';

requireAuth();
setLogout();
initAiBlog();
