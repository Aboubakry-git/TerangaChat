// Bascule automatique liste / conversation sur petits écrans.
// Aucun état n'est conservé : le comportement dépend uniquement de la largeur.
(() => {
  const mobileQuery = window.matchMedia('(max-width: 767px)');

  function appContainer() {
    return document.querySelector('.chat-app');
  }

  function openChatOnMobile() {
    if (mobileQuery.matches) appContainer()?.classList.add('chat-open');
  }

  function closeChatOnMobile() {
    appContainer()?.classList.remove('chat-open');
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Après une navigation vers /chat/:id, la vue indique déjà la conversation active.
    if (window.activeConversationId) openChatOnMobile();

    document.querySelectorAll('.conversation-item').forEach(conversation => {
      conversation.addEventListener('click', openChatOnMobile);
    });

    document.getElementById('mobileBack')?.addEventListener('click', closeChatOnMobile);
  });

  // Le passage tablette/desktop réaffiche naturellement les deux colonnes.
  mobileQuery.addEventListener('change', event => {
    if (!event.matches) closeChatOnMobile();
    else if (window.activeConversationId) openChatOnMobile();
  });
})();
