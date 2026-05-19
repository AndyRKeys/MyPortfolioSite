/**
 * dev-env.js — Visual indicator for non-production environments.
 * Prepends [DEV] to the page title, tints the A|K nav logo orange,
 * and tints the favicon when running on localhost, 127.0.0.1, or
 * port 3001 (dev server), so the browser tab and nav are immediately
 * distinguishable from the live site.
 */
(function () {
    const isDev =
        location.hostname === 'localhost' ||
        location.hostname === '127.0.0.1' ||
        location.port === '3001';

    if (!isDev) return;

    // Prefix page title
    document.title = '[DEV] ' + document.title;

    // Tint the A|K nav logo orange
    const navLabel = document.querySelector('.nav-toggle-label');
    if (navLabel) navLabel.style.color = 'darkorange';

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
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            ctx.globalCompositeOperation = 'source-atop';
            ctx.fillStyle = 'rgba(255, 140, 0, 0.55)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            favicon.href = canvas.toDataURL('image/png');
        };
        img.src = favicon.href;
    }
})();
