// Check if the current user is logged in as admin (has valid JWT token)
function isAdminSession() {
    var token = localStorage.getItem('adminToken');
    if (!token) return false;
    try {
        var payload = JSON.parse(atob(token.split('.')[1]));
        return payload.exp * 1000 > Date.now();
    } catch (e) {
        return false;
    }
}
