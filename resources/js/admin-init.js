// Admin page initialisation — extracted from inline script to satisfy CSP script-src.

// Default travel date and post date to today
(function () {
    var today = new Date();
    var yyyy = today.getFullYear();
    var mm = String(today.getMonth() + 1).padStart(2, '0');
    var dd = String(today.getDate()).padStart(2, '0');
    var todayStr = yyyy + '-' + mm + '-' + dd;
    var travelDate = document.getElementById('travel-date');
    if (travelDate) travelDate.value = todayStr;
    var postDate = document.getElementById('post-date');
    if (postDate) postDate.value = todayStr;
})();

// Issue #34: wire styled file input button to hidden native input
(function () {
    var btn = document.querySelector('.file-input-btn');
    var input = document.getElementById('travel-file');
    var label = document.querySelector('.file-input-label');
    if (!btn || !input || !label) return;
    btn.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
        label.textContent = input.files.length > 0
            ? input.files[0].name
            : 'No file chosen';
    });
})();

// Issue #39: custom coordinate stepper buttons
(function () {
    var STEP = 0.000001;
    var holdDelay = 400;
    var holdInterval = 80;

    function nudge(inputId, direction) {
        var el = document.getElementById(inputId);
        if (!el) return;
        var val = parseFloat(el.value) || 0;
        var decimals = (STEP.toString().split('.')[1] || '').length;
        el.value = (val + direction * STEP).toFixed(decimals);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    document.querySelectorAll('.coord-step-btn').forEach(function (btn) {
        var timer, interval;

        function startHold() {
            var targetId = btn.dataset.target;
            var dir = parseInt(btn.dataset.dir, 10);
            nudge(targetId, dir);
            timer = setTimeout(function () {
                interval = setInterval(function () { nudge(targetId, dir); }, holdInterval);
            }, holdDelay);
        }

        function stopHold() {
            clearTimeout(timer);
            clearInterval(interval);
        }

        btn.addEventListener('mousedown', startHold);
        btn.addEventListener('touchstart', function (e) { e.preventDefault(); startHold(); }, { passive: false });
        btn.addEventListener('mouseup', stopHold);
        btn.addEventListener('mouseleave', stopHold);
        btn.addEventListener('touchend', stopHold);
        btn.addEventListener('touchcancel', stopHold);
    });
})();

// Issue #110: CV file input — wire button, show rename notice if not cv.pdf
(function () {
    var fileBtn    = document.getElementById('cv-file-btn');
    var fileInput  = document.getElementById('cv-file-input');
    var fileLabel  = document.getElementById('cv-file-label');
    var renameNote = document.getElementById('cv-rename-notice');
    if (!fileBtn || !fileInput || !fileLabel || !renameNote) return;

    fileBtn.addEventListener('click', function () { fileInput.click(); });

    fileInput.addEventListener('change', function () {
        if (fileInput.files.length > 0) {
            var name = fileInput.files[0].name;
            fileLabel.textContent = name;
            renameNote.style.display = (name.toLowerCase() !== 'cv.pdf') ? '' : 'none';
        } else {
            fileLabel.textContent = 'No file chosen';
            renameNote.style.display = 'none';
        }
    });
})();
