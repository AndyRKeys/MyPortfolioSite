import { requireAuth, setLogout } from './admin/auth.js';
import { initCv }                 from './admin/cv.js';
import { initNotes }              from './admin/notes.js';

requireAuth();
setLogout();
initCv();
initNotes();
