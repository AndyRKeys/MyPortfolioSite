function getToken() {
    return localStorage.getItem('adminToken') || null;
}

// Check if the current user is logged in as admin (has valid JWT token)
function isAdminSession() {
    var token = getToken();
    if (!token) return false;
    try {
        var payload = JSON.parse(atob(token.split('.')[1]));
        return payload.exp * 1000 > Date.now();
    } catch (e) {
        return false;
    }
}

export { getToken, isAdminSession };
