import { initForm } from './travel/form.js';
import { initGeocode } from './travel/geocode.js';
import { loadAll } from './travel/list.js';

export function initTravel() {
    loadAll();
    initForm();
    initGeocode();
}
