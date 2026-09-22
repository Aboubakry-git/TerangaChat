// Gestion du thème : le choix explicite prévaut sur la préférence du système.
(() => {
  const storageKey = 'terangachat-theme';
  const root = document.documentElement;
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function savedTheme() {
    try { return localStorage.getItem(storageKey); } catch (_) { return null; }
  }

  function applyTheme(theme) {
    root.dataset.theme = theme;
    const toggle = document.getElementById('themeToggle');
    if (!toggle) return;

    const isDark = theme === 'dark';
    toggle.querySelector('i').className = isDark ? 'fas fa-sun' : 'fas fa-moon';
    toggle.querySelector('span').textContent = isDark ? 'Mode clair' : 'Mode sombre';
    toggle.setAttribute('aria-label', isDark ? 'Activer le mode clair' : 'Activer le mode sombre');
  }

  // Au premier chargement, respecter le réglage du système d'exploitation.
  applyTheme(savedTheme() || (mediaQuery.matches ? 'dark' : 'light'));

  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(savedTheme() || (mediaQuery.matches ? 'dark' : 'light'));
    const toggle = document.getElementById('themeToggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const nextTheme = root.dataset.theme === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(storageKey, nextTheme); } catch (_) { /* stockage indisponible */ }
        applyTheme(nextTheme);
      });
    }
  });

  // Une préférence système ne modifie le thème que tant que l'utilisateur n'a rien choisi.
  mediaQuery.addEventListener('change', event => {
    if (!savedTheme()) applyTheme(event.matches ? 'dark' : 'light');
  });
})();
