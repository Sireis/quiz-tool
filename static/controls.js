// Native disclosures keep menus and sidebar groups usable without custom menu roles.
(() => {
  const popups = () => [...document.querySelectorAll('details[data-popup]')];
  document.addEventListener('click', event => {
    for (const popup of popups()) {
      if (!popup.open) continue;
      if (!popup.contains(event.target)) popup.open = false;
      else if (event.target.closest('button')) {
        // A following dialog remembers the visible trigger for focus restoration.
        popup.open = false;
        popup.querySelector('summary').focus();
      }
    }
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const popup = popups().find(item => item.open);
    if (!popup) return;
    popup.open = false;
    popup.querySelector('summary').focus();
    event.preventDefault();
    event.stopImmediatePropagation();
  });
})();
