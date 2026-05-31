import { requireAuth, setLogout } from './admin/auth.js';
import { initPosts }              from './admin/posts.js';

requireAuth();
setLogout();
initPosts();
