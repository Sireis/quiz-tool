// Capture the profile for this page so pending requests cannot change owners.
let pageProfile = localStorage.getItem('trainer_profile') || 'default';
const originalFetch = window.fetch.bind(window);
window.fetch = function(input, options = {}) {
  const url = new URL(input instanceof Request ? input.url : input, location.href);
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
    const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('X-Trainer-Profile', pageProfile);
    options = {...options, headers};
  }
  return originalFetch(input, options);
};

async function initProfiles() {
  const select = document.getElementById('profile-select');
  const form = document.getElementById('profile-form');
  const dialog = document.getElementById('profile-dialog');
  const name = document.getElementById('profile-name');
  const status = document.getElementById('profile-status');
  const activate = id => {
    localStorage.setItem('trainer_profile', id);
    location.reload();
  };
  // Listing must also work when a stored profile no longer exists.
  const response = await originalFetch('/api/profiles');
  if (!response.ok) throw new Error('Profile konnten nicht geladen werden.');
  const profiles = await response.json();
  if (!profiles.some(profile => profile.id === pageProfile)) {
    pageProfile = 'default';
    localStorage.setItem('trainer_profile', pageProfile);
  }
  select.replaceChildren(...profiles.map(profile => new Option(profile.name, profile.id)));
  select.value = pageProfile;
  select.disabled = false;
  select.addEventListener('change', () => activate(select.value));
  document.getElementById('profile-add').addEventListener('click', () => {
    dialog.showModal();
    name.focus();
  });
  document.getElementById('profile-cancel').addEventListener('click', () => {
    dialog.close();
    status.textContent = '';
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    status.textContent = '';
    try {
      const response = await fetch('/api/profiles', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: name.value}),
      });
      const profile = await response.json();
      if (!response.ok) throw new Error(profile.error || 'Profil konnte nicht erstellt werden.');
      activate(profile.id);
    } catch (error) {
      status.textContent = error.message;
      submit.disabled = false;
    }
  });
}
