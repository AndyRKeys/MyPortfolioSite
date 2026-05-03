const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
// In dev, use same hostname as frontend (localhost/127.0.0.1) to ensure WebAuthn origin matching
export const API = isDev ? `http://${window.location.hostname}:8080` : '';
