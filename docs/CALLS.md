# Appels TerangaChat — Architecture & guide de test

## Architecture

### Signalisation (Socket.IO)
- Chaque utilisateur rejoint `user:<userId>` au `user:join`.
- Un appel crée une room `call:<callId>` pour les participants connectés.
- **1-à-1** : `call:incoming` / `call:accepted` / `call:rejected` / `call:ended` via `user:<id>` (jamais uniquement `conv:`).
- **Groupe** : `call:group-invite` (Rejoindre / Ignorer), puis `call:join`, `call:peers`, `call:participant-joined|left`.

### Média (PeerJS / WebRTC)
- PeerJS est monté **sur le même serveur HTTP/HTTPS** que l’app (`/peerjs`), pas sur un port 9000 séparé.
- **1-à-1** : P2P classique. L’appelant fait `peer.call(calleePeerId)` après `call:accepted` (`force` dial).
- **Groupe** : **mesh** — dial unidirectionnel (ordre lexicographique des `userId`) pour éviter les doubles connexions ; gestion du glare (double offer).
- Limite soft : **5 participants**. Au-delà → message + proposition audio-only (`call:switch-audio`).
- STUN : Google + Twilio
- **TURN local (coturn)** sur le serveur app (`turn:<host>:3478`) — indispensable quand Chrome publie des candidats `.local` (mDNS) illisibles entre machines du LAN.
- Timer d’appel démarre au **premier flux distant**, pas à l’initiation.
- `peer.on('call')` ignoré s’il n’y a pas de session active / stream local.

### Persistance (Cassandra)
- `call_sessions` / `call_participants` en best-effort (échec DB ≠ échec d’appel).
- `call_history*` conservé pour compatibilité.

### Pourquoi pas SFU ?
Le mesh PeerJS est simple à déployer et suffisant jusqu’à ~5 pairs. Un SFU (mediasoup / LiveKit) serait nécessaire au-delà.

## Debug
- Ajouter `?callDebug=1` à l’URL du chat, ou `window.CALL_DEBUG = true` dans la console.
- Logs préfixés `[calls]` côté client ; erreurs serveur `call:* error`.
- Vérifier `PeerJS open` dans la console et `PeerJS connected:` côté serveur.

## Guide de test

### Prérequis
1. HTTPS recommandé (getUserMedia / WebRTC). En HTTP local, Chrome peut bloquer le micro hors localhost.
2. Accéder via l’URL du certificat (ex. `https://192.168.4.155:3000`) — PeerJS utilise **le même host/port**.
3. Deux navigateurs (ou profils) + idéalement un mobile.

### Test 1 — Appel audio 1-à-1
1. User A ouvre une discussion privée avec B.
2. A clique téléphone → modal « Appel en cours ».
3. B reçoit la sonnerie (bip répété) + modal entrant.
4. B accepte → les deux entendent l’audio ; timer démarre.
5. Mute / haut-parleur / raccrocher → OK des deux côtés.
6. Refus : B refuse → A voit « Appel refusé ».
7. Timeout : B n’accepte pas 30 s → appel manqué.

### Test 2 — Appel vidéo 1-à-1
1. Même flux avec bouton caméra.
2. Vérifier vignette locale + flux distant.
3. Couper caméra → piste vidéo désactivée.

### Test 3 — Appel de groupe
1. Groupe avec 3+ membres.
2. A démarre un appel → B et C reçoivent « Appel de groupe — N participants » (Rejoindre / Ignorer).
3. B rejoint → mesh A↔B.
4. C rejoint → connexions vers A et B.
5. Quitter : un participant raccroche → les autres restent si l’initiateur n’a pas terminé (l’initiateur termine tout le monde).
6. 6ᵉ participant → message de limite 5.

### Checklist régression
- [ ] Sonnerie s’arrête à l’acceptation / refus / timeout
- [ ] Pas de boucle audio après raccroché
- [ ] Messages / réactions / présence toujours OK pendant un appel
- [ ] CSP : aucun `onclick` inline sur les contrôles d’appel
- [ ] Déconnexion / refresh d’un participant nettoie la session
