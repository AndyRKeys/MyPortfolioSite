const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
// In dev, point directly at the backend port so WebAuthn origin matching works.
// In production, all API requests are prefixed with /api and proxied by nginx.
export const API = isDev ? `http://${window.location.hostname}:8080` : '/api';
