// Development: point at the local backend port
// Production: set to '' (empty string) — Nginx proxies /auth/* to Node on the same domain
export const API = 'http://localhost:8080';
