import exifr from 'https://esm.sh/exifr@7.1.3';
import { todayIso } from '../auth.js';
import { setMessage } from './messages.js';
import { updateGeoconfirmMap, reverseGeocodeToLocation } from './geocode.js';

// Returns true only if coords are finite numbers and not the null-island 0,0
// that DJI and some cameras emit when GPS is unavailable.
function hasValidGps(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
}

async function extractGpsFromFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return null;
    try {
        let gps = null;
        try {
            const tags = await exifr.parse(file, { gps: true });
            if (tags && hasValidGps(tags.latitude, tags.longitude)) {
                gps = { latitude: tags.latitude, longitude: tags.longitude };
            }
        } catch { /* fall through to exifr.gps() */ }

        if (!gps) {
            const raw = await exifr.gps(file);
            if (raw && hasValidGps(raw.latitude, raw.longitude)) gps = raw;
        }
        return gps;
    } catch {
        return null;
    }
}

// Loop through sorted files to find the first one with valid GPS coords.
export async function tryAutofillGpsFromFileList(files) {
    const sortedImages = files
        .filter(f => f.type && f.type.startsWith('image/'))
        .sort((a, b) => a.name.localeCompare(b.name));

    for (const file of sortedImages) {
        const gps = await extractGpsFromFile(file);
        if (gps) {
            document.getElementById('travel-lat').value = gps.latitude.toFixed(6);
            document.getElementById('travel-lng').value = gps.longitude.toFixed(6);
            setMessage(`GPS auto-filled from ${file.name}.`);
            updateGeoconfirmMap(gps.latitude, gps.longitude);
            await reverseGeocodeToLocation(gps.latitude, gps.longitude);
            return;
        }
    }
    setMessage('No GPS data in any photo — enter coordinates manually or use Geocode.', false, true);
}

// Try to read DateTimeOriginal from image EXIF and populate the date input.
export async function tryAutofillDateFromFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return;
    const currentVal = document.getElementById('travel-date').value;
    if (currentVal && currentVal !== todayIso()) return;
    try {
        const tags = await exifr.parse(file, ['DateTimeOriginal']);
        if (tags && tags.DateTimeOriginal instanceof Date) {
            const d    = tags.DateTimeOriginal;
            const yyyy = d.getFullYear();
            const mm   = String(d.getMonth() + 1).padStart(2, '0');
            const dd   = String(d.getDate()).padStart(2, '0');
            document.getElementById('travel-date').value = `${yyyy}-${mm}-${dd}`;
        }
    } catch {
        // EXIF date unavailable — ignore
    }
}
