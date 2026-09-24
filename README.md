# TerangaChat

Application de messagerie instantanée inspirée de WhatsApp Web.

## C'est quoi TerangaChat ?

TerangaChat est une application web de chat en temps réel qui permet à plusieurs 
utilisateurs de discuter en privé ou en groupe. Elle offre une expérience proche 
de WhatsApp Web : messages instantanés, partage de fichiers, appels audio/vidéo, 
notifications, statuts, et plus.

## Objectifs

- Offrir une alternative libre et auto-hébergeable aux messageries propriétaires
- Permettre des conversations privées et de groupe en temps réel
- Supporter les appels audio/vidéo via WebRTC
- Fonctionner avec un backend léger (Node.js + Cassandra)
- Proposer une interface moderne (clair/sombre, responsive)
- Garantir la confidentialité des données (aucun tiers, tout est chez vous)

## Fonctionnalités principales

- Chat 1-à-1 et groupes en temps réel
- Envoi de texte, images, fichiers, messages vocaux
- Appels audio/vidéo (1-à-1 et groupe)
- Notifications navigateur
- Mode clair / sombre
- Blocage d'utilisateurs
- Recherche de messages
- Statut en ligne / dernière connexion
- Gestion de profil (avatar, nom, statut)

## Stack technique

- **Backend** : Node.js, Express
- **Base de données** : Apache Cassandra
- **Temps réel** : Socket.IO
- **Appels** : WebRTC + PeerJS
- **Templates** : EJS
- **Auth** : JWT + sessions

## Prérequis

Avant de déployer, assurez-vous d'avoir installé :

- **Node.js** ≥ 18 — [télécharger](https://nodejs.org/)
- **Apache Cassandra** ≥ 4.0 — [télécharger](https://cassandra.apache.org/download/)
- **Git** — [télécharger](https://git-scm.com/)
- **npm** (inclus avec Node.js)

## Page Inscription
<img width="1918" height="939" alt="image" src="https://github.com/user-attachments/assets/ebe6b3e1-8eb8-4bf0-ab41-ca3da0c3098f" />

## Page Connexion
<img width="1917" height="941" alt="image" src="https://github.com/user-attachments/assets/7939fc94-4acb-44f5-8d8b-2ec74f201f99" />

## Interface de l'Application
<img width="1718" height="800" alt="image" src="https://github.com/user-attachments/assets/54a1f6ba-ab09-425c-a35d-16bc33e0a831" />


## Déploiement sur Ubuntu

```bash
# 1. Cloner le projet
git clone https://github.com/Aboubakry-git/TerangaChat.git
cd TerangaChat

# 2. Créer le keyspace et les tables Cassandra
cqlsh 127.0.0.1 9042 -f schema.cql

# 3. Configurer l'environnement
cp .env.example .env
nano .env
# → Remplir SESSION_SECRET, JWT_SECRET et les identifiants Cassandra

# 4. Générer un secret (pour SESSION_SECRET et JWT_SECRET)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 5. Installer les dépendances
npm install

# 6. Lancer l'application
npm start


