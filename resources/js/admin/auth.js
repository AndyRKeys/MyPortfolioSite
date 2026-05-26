import { API_BASE } from '../config.js';

export function getToken() {
    return localStorage.getItem('adminToken');
}

export function isAuthenticated() {
    const token = getToken();
    if (!token) return false;
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        return payload.exp * 1000 > Date.now();
    } catch {
        return false;
    }
}

export function requireAuth() {
    if (!isAuthenticated()) location.replace('/login/');
}

export function setLogout() {
    document.getElementById('logout-link').addEventListener('click', (event) => {
        event.preventDefault();
        localStorage.removeItem('adminToken');
        location.replace('/login/');
    });
}

export function authFetch(path, opts = {}) {
    return fetch(`${API_BASE}${path}`, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${getToken()}`,
            ...(opts.headers || {}),
        },
    });
}

// For multipart uploads — lets the browser set the correct Content-Type boundary
export function authFetchMultipart(path, formData) {
    return fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${getToken()}` },
        body: formData,
    });
}

export function todayIso() {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
