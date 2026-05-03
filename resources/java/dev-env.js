/**
 * dev-env.js — Visual indicator for non-production environments.
 * Issue #31: Prepends [DEV] to the page title and tints the favicon
 * when running on localhost or 127.0.0.1, so the browser tab is
 * immediately distinguishable from the live site.
 */
(function () {
    const isLocal =
        location.hostname === 'localhost' ||
        location.hostname === '127.0.0.1';

    if (!isLocal) return;

    // Prefix page title
    document.title = '[DEV] ' + document.title;

    // Tint favicon so the tab icon is visually distinct
    const favicon = document.querySelector('link[rel*="icon"]');
    if (favicon) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function () {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth || 32;
            canvas.height = img.naturalHeight || 32;
            const ctx = canvas.getContext('2d');
            // Draw original favicon with an orange tint overlay
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            ctx.globalCompositeOperation = 'source-atop';
            ctx.fillStyle = 'rgba(255, 140, 0, 0.55)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            favicon.href = canvas.toDataURL('image/png');
        };
        img.src = favicon.href;
    }
})();
