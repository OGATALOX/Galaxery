// public/js/main.js
document.addEventListener('DOMContentLoaded', ()=> {
  const input = document.getElementById('search-input');
  const ac = document.getElementById('autocomplete');

  if(!input) return;

  let lastQ = '';
  input.addEventListener('input', async (e) => {
    const q = e.target.value.trim();
    if(!q) { ac.innerHTML = ''; return; }
    // We support typing with or without #. Remove starting text so we pass prefix only.
    // Find last token typed (space-separated)
    const parts = q.split(/\s+/);
    const token = parts[parts.length-1];
    const prefix = token.replace(/^#+/, '').toLowerCase();
    if(prefix.length === 0){ ac.innerHTML = ''; return; }
    if(prefix === lastQ) return;
    lastQ = prefix;
    try {
      const res = await fetch('/tags/autocomplete?q=' + encodeURIComponent(prefix));
      const tags = await res.json();
      ac.innerHTML = tags.map(t => `<div class="ac-item" data-tag="${t.name}">${t.name} <span class="count">(${t.cnt})</span></div>`).join('');
      // click handler
      ac.querySelectorAll('.ac-item').forEach(el => el.addEventListener('click', () => {
        // replace last token with chosen tag
        parts[parts.length-1] = el.dataset.tag;
        input.value = parts.join(' ') + ' ';
        ac.innerHTML = '';
        input.focus();
      }));
    } catch(e) { ac.innerHTML = ''; }
  });

  // submit search when user presses enter
  input.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){
      e.preventDefault();
      // collect all tags typed (space separated). Accept with or without #
      const tokens = input.value.split(/\s+/).map(t => t.trim()).filter(Boolean);
      const norm = tokens.map(t => t.startsWith('#') ? t : ('#'+t)).join(',');
      window.location.href = '/?tags=' + encodeURIComponent(norm);
    }
  });
});
