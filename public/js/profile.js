// TerangaChat — interactions page Profil (100% sans inline handlers)
(function () {
  'use strict';

  let currentEditField = null;

  // ============================================================
  // AVATAR : clic sur la photo → ouvre le sélecteur de fichier
  // ============================================================
  function initAvatarUpload() {
    const wrap = document.querySelector('.avatar-edit-wrap');
    const input = document.getElementById('avatarInput');
    if (!wrap || !input) return;

    const openPicker = function (e) {
      e.preventDefault();
      input.click();
    };

    wrap.addEventListener('click', openPicker);
    wrap.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        input.click();
      }
    });

    input.addEventListener('change', function () {
      const file = this.files[0];
      if (!file) return;

      if (file.size > 10 * 1024 * 1024) {
        alert('Image trop volumineuse (max 10 Mo)');
        this.value = '';
        return;
      }

      const reader = new FileReader();
      reader.onload = function (ev) {
        let img = wrap.querySelector('.avatar-edit-img');
        if (img && img.tagName === 'IMG') {
          img.src = ev.target.result;
        } else {
          if (img) img.remove();
          const newImg = document.createElement('img');
          newImg.className = 'avatar-edit-img';
          newImg.src = ev.target.result;
          newImg.alt = 'Avatar';
          wrap.insertBefore(newImg, wrap.firstChild);
        }
      };
      reader.readAsDataURL(file);
    });
  }

  // ============================================================
  // MODALE D'ÉDITION
  // ============================================================
  function openEdit(field, title, value) {
    currentEditField = field;
    const modal = document.getElementById('editModal');
    const titleEl = document.getElementById('editModalTitle');
    const input = document.getElementById('editModalInput');
    if (!modal || !titleEl || !input) return;

    titleEl.textContent = 'Modifier ' + title;
    input.value = value || '';
    input.maxLength = field === 'statusText' ? 140 : 100;

    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(function () { input.focus(); input.select(); }, 60);
  }

  function closeEdit() {
    const modal = document.getElementById('editModal');
    if (modal) {
      modal.classList.remove('active');
      modal.setAttribute('aria-hidden', 'true');
    }
    currentEditField = null;
  }

  function saveEdit() {
    if (!currentEditField) return;
    const input = document.getElementById('editModalInput');
    const value = (input.value || '').trim();

    const hidden = document.getElementById('input-' + currentEditField);
    if (hidden) hidden.value = value;

    const targetRow = document.querySelector('.profile-row[data-field="' + currentEditField + '"]');
    if (targetRow) {
      const valueEl = targetRow.querySelector('.profile-row-value');
      if (valueEl) {
        valueEl.textContent =
          value || (currentEditField === 'fullName' ? 'Non défini' : 'Ajouter un statut');
      }
      targetRow.dataset.value = value;
    }

    if (currentEditField === 'fullName') {
      const nameEl = document.querySelector('.profile-name-block h2');
      if (nameEl) {
        nameEl.textContent = value || nameEl.dataset.username || '';
      }
    }

    closeEdit();
  }

  // ============================================================
  // TOGGLES
  // ============================================================
  function toggleSwitch(field) {
    const cb = document.getElementById(field);
    const sw = document.getElementById('switch-' + field);
    if (!cb || !sw) return;

    cb.checked = !cb.checked;
    sw.classList.toggle('on', cb.checked);
  }

  // ============================================================
  // INITIALISATION
  // ============================================================
  function init() {
    initAvatarUpload();

    document.querySelectorAll('.profile-row[data-field]').forEach(function (row) {
      row.addEventListener('click', function () {
        const field = row.dataset.field;
        const title = field === 'fullName' ? 'Nom complet' : 'Statut';
        const value = row.dataset.value || '';
        openEdit(field, title, value);
      });
    });

    document.querySelectorAll('.profile-toggle[data-toggle]').forEach(function (el) {
      el.addEventListener('click', function () {
        toggleSwitch(el.dataset.toggle);
      });
    });

    const btnCancel = document.getElementById('editModalCancel');
    const btnSave = document.getElementById('editModalSave');
    if (btnCancel) btnCancel.addEventListener('click', closeEdit);
    if (btnSave) btnSave.addEventListener('click', saveEdit);

    const modal = document.getElementById('editModal');
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeEdit();
      });
    }

    const modalInput = document.getElementById('editModalInput');
    if (modalInput) {
      modalInput.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeEdit();
        if (e.key === 'Enter') {
          e.preventDefault();
          saveEdit();
        }
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeEdit();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
