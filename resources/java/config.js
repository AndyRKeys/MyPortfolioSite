const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
// In dev, point directly at the backend port so WebAuthn origin matching works.
// In production, all API requests are prefixed with /api and proxied by nginx.
// Exported as API_BASE for consistency with all consumer files.
export const API_BASE = isDev ? `http://${window.location.hostname}:8080` : '/api';

// Keep API as a deprecated alias so admin.js continues to work until Phase 8
// updates its import. Remove once Phase 8 is complete.
export const API = API_BASE;

export function isAdminSession() {
    return !!sessionStorage.getItem('adminToken');
}
