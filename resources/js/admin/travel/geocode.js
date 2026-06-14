import { setMessage } from './messages.js';

// ── Constants ─────────────────────────────────────────────────────────────────

// Nominatim base URL — shared by reverse-geocode (reverseGeocodeToLocation)
// and forward-geocode (geocodeLocation) to avoid drift between the two calls.
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';

// Duration (ms) to flash a success outline on the location input after
// Geocode normalises the field value.
const LOCATION_FLASH_MS = 1500;

// ── Module state ──────────────────────────────────────────────────────────────

let geoconfirmMap    = null;
let geoconfirmMarker = null;

// ── Map helpers ───────────────────────────────────────────────────────────────

export function updateGeoconfirmMap(lat, lng) {
    if (!window.L) return;
    const mapEl = document.getElementById('geoconfirm-map');
    if (!mapEl) return;
    mapEl.classList.remove('hidden');

    if (!geoconfirmMap) {
        geoconfirmMap = L.map('geoconfirm-map', { scrollWheelZoom: false, zoomControl: true });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 18,
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(geoconfirmMap);
    }

    const latlng = [lat, lng];
    geoconfirmMap.setView(latlng, 10);

    if (geoconfirmMarker) {
        geoconfirmMarker.setLatLng(latlng);
    } else {
        geoconfirmMarker = L.marker(latlng).addTo(geoconfirmMap);
    }

    // Leaflet needs a size nudge after becoming visible
    setTimeout(() => geoconfirmMap.invalidateSize(), 50);
}

export function hideGeoconfirmMap() {
    const mapEl = document.getElementById('geoconfirm-map');
    if (mapEl) mapEl.classList.add('hidden');
    if (geoconfirmMarker && geoconfirmMap) {
        geoconfirmMap.removeLayer(geoconfirmMarker);
        geoconfirmMarker = null;
    }
}

// ── Location helpers ──────────────────────────────────────────────────────────

// Build canonical "City, Country" from a Nominatim address object.
// Falls back to the first two comma-separated parts of display_name when the
// address object lacks a city-level field (e.g. Tokyo returns addresstype
// "province", not "city", so address.province must be checked explicitly).
function normaliseLocation(address, displayName) {
    if (address) {
        const city    = address.city || address.town || address.village || address.hamlet ||
                        address.municipality || address.province ||
                        address.county || address.state_district || address.state || '';
        const country = address.country || '';
        if (city && country) return `${city}, ${country}`;
    }
    const parts = displayName ? displayName.split(',').map(p => p.trim()).filter(Boolean) : [];
    return parts.slice(0, 2).join(', ') || null;
}

// Reverse geocode lat/lng to a human-readable location string using Nominatim.
// Only populates the Location field if it is currently empty.
export async function reverseGeocodeToLocation(lat, lng) {
    if (document.getElementById('travel-location').value.trim()) return;
    try {
        const url = `${NOMINATIM_URL}/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10&addressdetails=1`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
        if (!res.ok) return;
        const data = await res.json();
        const locationStr = normaliseLocation(data.address, data.display_name);
        if (locationStr) document.getElementById('travel-location').value = locationStr;
    } catch {
        // Reverse geocode failure is non-fatal — silently ignore
    }
}

// ── Forward geocode (button handler) ─────────────────────────────────────────

async function geocodeLocation() {
    const q = document.getElementById('travel-location').value.trim();
    if (!q) { setMessage('Enter a location name first.', true); return; }
    const btn = document.getElementById('geocode-btn');
    btn.disabled = true;
    btn.textContent = 'Looking up…';
    setMessage('');
    try {
        const url = `${NOMINATIM_URL}/search?format=json&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
        const results = await res.json();
        if (!results.length) { setMessage('Location not found — try a more specific name.', true); return; }
        const { lat, lon, display_name, address } = results[0];
        const parsedLat = parseFloat(lat);
        const parsedLng = parseFloat(lon);
        document.getElementById('travel-lat').value = parsedLat.toFixed(6);
        document.getElementById('travel-lng').value = parsedLng.toFixed(6);

        const normalised = normaliseLocation(address, display_name);
        if (normalised) {
            const locationInput = document.getElementById('travel-location');
            locationInput.value = normalised;
            locationInput.style.outline = '2px solid var(--color-success)';
            setTimeout(() => { locationInput.style.outline = ''; }, LOCATION_FLASH_MS);
        }

        setMessage(`Coordinates set — confirm pin location on the map below (matched: ${display_name.split(',').slice(0, 3).join(',')}).`, false, true);
        updateGeoconfirmMap(parsedLat, parsedLng);
    } catch {
        setMessage('Geocode failed — check your connection and try again.', true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Geocode';
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initGeocode() {
    document.getElementById('geocode-btn').addEventListener('click', () => geocodeLocation());

    // Update confirmation map when coords are changed manually
    const coordHandler = () => {
        const lat = parseFloat(document.getElementById('travel-lat').value);
        const lng = parseFloat(document.getElementById('travel-lng').value);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            updateGeoconfirmMap(lat, lng);
        } else {
            hideGeoconfirmMap();
        }
    };
    ['travel-lat', 'travel-lng'].forEach(id => {
        const el = document.getElementById(id);
        el.addEventListener('change', coordHandler);
        el.addEventListener('input', coordHandler);
    });
}
