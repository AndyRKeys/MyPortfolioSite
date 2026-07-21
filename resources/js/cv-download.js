// CV download button — extracted from inline script to satisfy CSP script-src.
// Reactive: checkCvExists() runs on load and whenever the page regains visibility (#110).

(function () {
    // Canonical public download filename — mirrors CV_PUBLIC_FILENAME in
    // backend/utils/constants.js.
    var CV_PUBLIC_FILENAME = 'Andy_Keys_CV.pdf';

    var btn = document.getElementById('cv-download-btn');
    if (!btn) return;

    function checkCvExists() {
        fetch('/api/cv/exists')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                btn.style.display = (data && data.exists) ? '' : 'none';
            })
            .catch(function () {
                btn.style.display = 'none'; // API unreachable — hide safely
            });
    }

    checkCvExists();

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
            checkCvExists();
        }
    });

    btn.addEventListener('click', function () {
        btn.disabled = true;
        btn.textContent = 'Downloading…';
        fetch('/api/cv')
            .then(function (r) {
                if (!r.ok) throw new Error('CV not available');
                return r.blob();
            })
            .then(function (blob) {
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = CV_PUBLIC_FILENAME;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            })
            .catch(function () {
                alert('CV is not currently available. Please try again later.');
            })
            .finally(function () {
                btn.disabled = false;
                btn.textContent = 'Download CV';
            });
    });
})();
