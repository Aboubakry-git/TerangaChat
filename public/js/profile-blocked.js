// TerangaChat — interactions page Utilisateurs bloqués
(function () {
  'use strict';

  function init() {
    document.querySelectorAll('[data-action="unblock"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const item = btn.closest('.blocked-item');
        if (!item) return;
        const userId = item.dataset.userId;
        if (!userId) return;

        if (!confirm('Débloquer cet utilisateur ?')) return;

        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> ...';

        fetch('/profile/unblock/' + encodeURIComponent(userId), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Accept': 'application/json' },
        })
          .then(function (res) {
            if (!res.ok) throw new Error('Erreur serveur');
            item.style.transition = 'opacity .2s';
            item.style.opacity = '0';
            setTimeout(function () {
              item.remove();
              const list = document.querySelector('.blocked-list');
              if (list && list.children.length === 0) {
                location.reload();
              }
            }, 200);
          })
          .catch(function () {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-unlock"></i> Débloquer';
            alert('Erreur lors du déblocage');
          });
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
