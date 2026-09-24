/* Stories 24h — compositeur + ouverture de la modale */
(function () {
  const BG_COLORS = ['#075E54', '#128C7E', '#009999', '#1F2C34', '#6B3FA0', '#C2185B', '#E65100', '#1565C0'];

  const composerModal = document.getElementById('storyComposerModal');
  const textInput = document.getElementById('storyTextInput');
  const textPreview = document.getElementById('storyTextPreview');
  const bgSwatches = document.getElementById('storyBgSwatches');
  const mediaInput = document.getElementById('storyMediaInput');
  const mediaPreview = document.getElementById('storyMediaPreview');
  const mediaCaption = document.getElementById('storyMediaCaption');
  const tabText = document.getElementById('storyTabText');
  const tabMedia = document.getElementById('storyTabMedia');
  const publishBtn = document.getElementById('publishStoryBtn');
  const closeBtn = document.getElementById('closeStoryComposerBtn');
  const cancelBtn = document.getElementById('cancelStoryComposerBtn');

  let activeTab = 'text';
  let selectedBg = BG_COLORS[0];
  let mediaFile = null;

  function openStoryComposer() {
    if (!composerModal) return;
    resetComposer();
    composerModal.style.display = 'flex';
    if (activeTab === 'text' && textInput) textInput.focus();
  }

  function closeStoryComposer() {
    if (!composerModal) return;
    composerModal.style.display = 'none';
    resetComposer();
  }

  function resetComposer() {
    mediaFile = null;
    selectedBg = BG_COLORS[0];
    if (textInput) textInput.value = '';
    if (mediaCaption) mediaCaption.value = '';
    if (mediaInput) mediaInput.value = '';
    if (mediaPreview) {
      mediaPreview.innerHTML = '';
      mediaPreview.style.display = 'none';
    }
    updateTextPreview();
    setTab('text');
    document.querySelectorAll('.story-bg-swatch').forEach((s, i) => {
      s.classList.toggle('active', i === 0);
    });
  }

  function setTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.story-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.storyTab === tab);
    });
    if (tabText) tabText.style.display = tab === 'text' ? 'block' : 'none';
    if (tabMedia) tabMedia.style.display = tab === 'media' ? 'block' : 'none';
  }

  function updateTextPreview() {
    if (!textPreview) return;
    const value = (textInput?.value || '').trim() || 'Aperçu';
    textPreview.textContent = value;
    textPreview.style.background = selectedBg;
  }

  function initSwatches() {
    if (!bgSwatches) return;
    bgSwatches.innerHTML = '';
    BG_COLORS.forEach((color, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'story-bg-swatch' + (i === 0 ? ' active' : '');
      btn.style.background = color;
      btn.setAttribute('aria-label', `Fond ${color}`);
      btn.addEventListener('click', () => {
        selectedBg = color;
        bgSwatches.querySelectorAll('.story-bg-swatch').forEach((s) => s.classList.remove('active'));
        btn.classList.add('active');
        updateTextPreview();
      });
      bgSwatches.appendChild(btn);
    });
  }

  function markOwnStoryPublished() {
    const addBtn = document.getElementById('addStoryBtn');
    if (!addBtn) return;
    addBtn.classList.add('story-has-content');
    const label = addBtn.querySelector('.story-label');
    if (label) label.textContent = 'Mon statut';
  }

  async function publishStory() {
    if (!publishBtn) return;
    const fd = new FormData();

    if (activeTab === 'media') {
      if (!mediaFile) {
        alert('Choisissez une image ou une vidéo');
        return;
      }
      fd.append('media', mediaFile);
      if (mediaCaption?.value.trim()) fd.append('caption', mediaCaption.value.trim());
    } else {
      const text = (textInput?.value || '').trim();
      if (!text) {
        alert('Écrivez un texte pour votre statut');
        return;
      }
      fd.append('text', text);
      fd.append('background', selectedBg);
    }

    publishBtn.disabled = true;
    const prevLabel = publishBtn.textContent;
    publishBtn.textContent = 'Publication…';
    try {
      const res = await fetch('/api/stories', {
        method: 'POST',
        body: fd,
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error('publish story failed', res.status, data);
        alert(data.error || `Impossible de publier le statut (${res.status})`);
        return;
      }
      markOwnStoryPublished();
      closeStoryComposer();
    } catch (err) {
      console.error(err);
      alert('Erreur réseau — vérifiez votre connexion');
    } finally {
      publishBtn.disabled = false;
      publishBtn.textContent = prevLabel || 'Publier';
    }
  }

  // Bind UI
  document.querySelectorAll('.story-tab').forEach((btn) => {
    btn.addEventListener('click', () => setTab(btn.dataset.storyTab));
  });

  if (textInput) {
    textInput.addEventListener('input', updateTextPreview);
  }

  if (mediaInput) {
    mediaInput.addEventListener('change', () => {
      const file = mediaInput.files?.[0];
      mediaFile = file || null;
      if (!mediaPreview) return;
      if (!file) {
        mediaPreview.innerHTML = '';
        mediaPreview.style.display = 'none';
        return;
      }
      const url = URL.createObjectURL(file);
      if (/^video\//.test(file.type)) {
        mediaPreview.innerHTML = `<video src="${url}" controls></video>`;
      } else {
        mediaPreview.innerHTML = `<img src="${url}" alt="Aperçu">`;
      }
      mediaPreview.style.display = 'block';
    });
  }

  if (publishBtn) publishBtn.addEventListener('click', publishStory);
  if (closeBtn) closeBtn.addEventListener('click', closeStoryComposer);
  if (cancelBtn) cancelBtn.addEventListener('click', closeStoryComposer);

  if (composerModal) {
    composerModal.addEventListener('click', (e) => {
      if (e.target === composerModal) closeStoryComposer();
    });
  }

  const viewersClose = document.getElementById('closeStoryViewersBtn');
  if (viewersClose) {
    viewersClose.addEventListener('click', () => {
      const m = document.getElementById('storyViewersModal');
      if (m) m.style.display = 'none';
    });
  }

  const storyCloseBtn = document.getElementById('storyCloseBtn');
  if (storyCloseBtn) {
    storyCloseBtn.addEventListener('click', () => {
      const viewer = document.getElementById('storyViewer');
      if (viewer) viewer.style.display = 'none';
    });
  }

  initSwatches();
  updateTextPreview();

  window.openStoryComposer = openStoryComposer;
  window.closeStoryComposer = closeStoryComposer;
})();
