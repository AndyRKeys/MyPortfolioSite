export function initNotes() {
    const notes = localStorage.getItem('privateProjectNotes');
    if (notes) document.getElementById('private-notes').value = notes;

    document.getElementById('save-private').addEventListener('click', () => {
        localStorage.setItem('privateProjectNotes', document.getElementById('private-notes').value);
        alert('Private notes saved locally.');
    });

    document.getElementById('clear-private').addEventListener('click', () => {
        document.getElementById('private-notes').value = '';
        localStorage.removeItem('privateProjectNotes');
    });
}
