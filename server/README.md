# Serveur KIS de préproduction

Node.js 24 et SQLite intégré suffisent pour le serveur. Depuis la racine du dépôt, lancer `node server/start.mjs`, après chargement d’une clé KIS_DATA_KEY aléatoire de 32 octets en hexadécimal, puis ouvrir `http://127.0.0.1:8787`. Le serveur écoute sur la boucle locale. Le fichier SQLite persistant se trouve par défaut dans `~/.kis-data`. `KIS_DATA`, `KIS_PORT` et `KIS_ORIGIN` permettent de configurer l’instance. Garder le répertoire de données réservé au compte système du serveur. Tester avec `node --test --test-isolation=none server/service.test.mjs`.

Utiliser uniquement des comptes fictifs pour cette phase. Créer deux comptes dans des sessions de navigateur distinctes. L’opérateur vérifie hors ligne le statut d’âge et le consentement du représentant légal si nécessaire. Il enregistre le statut avec `node server/start.mjs attest-age compte adult|minor|unknown [guardian-approved]`. Ensuite, chaque compte confirme ses consentements dans l’interface. L’opérateur vérifie l’autorisation de contact avant d’exécuter la commande locale suivante avec le même répertoire de données que le serveur.

```sh
node server/start.mjs approve-contact compte_a compte_b
```

Une nouvelle attestation invalide les anciennes approbations de contact et remet les consentements du compte à zéro. Les échanges textuels nécessitent deux statuts compatibles et le consentement des deux comptes. Les mineurs ont besoin d’une autorisation du représentant légal sur chaque compte. Le mode Public n’ouvre aucun échange avec un inconnu. Les notifications dans l’interface montrent un nombre de nouveaux messages, sans extrait. Le blocage coupe la lecture et l’envoi dans les deux sens. Un destinataire peut signaler un message reçu. Un opérateur autorisé peut consulter les 100 derniers signalements avec `node server/start.mjs list-reports`. Cette sortie contient les textes signalés. La réserver à un poste habilité.

Les comptes ont un identifiant pseudonyme et un mot de passe dérivé avec scrypt et un sel individuel. Les sessions de huit heures utilisent un cookie HttpOnly avec SameSite Strict, et Secure sous HTTPS. Les requêtes d’écriture exigent l’origine configurée. Les identifiants de session sont hachés en base. L’API applique le socle de protection à tous les comptes, avec Privé par défaut. Les six options du socle couvrent le profil, la localisation, les invitations, les contacts, les recommandations et le partage. Le serveur ne fournit aucun annuaire ni recherche de profil. Le mode choisi ne dispense jamais de l’approbation du contact.

Pour des prétests Safari sur appareil, utiliser un hôte HTTPS de préproduction à accès restreint, avec un proxy qui préserve l’en-tête Host, termine TLS, limite les requêtes et transfère au serveur local. Définir KIS_ORIGIN sur l’origine HTTPS exacte. Prévoir une instance et une base dédiées aux tests. Le serveur est conçu pour un seul processus applicatif. Les commandes opérateur sont des opérations locales ponctuelles.

Avant une ouverture à de vrais utilisateurs, il reste à valider les procédures de vérification d’âge et de consentement, organiser le traitement des signalements, la récupération de compte et la durée de conservation, vérifier sauvegarde et restauration, puis tester le déploiement et sa supervision. Les messages sont transmis sous TLS en préproduction HTTPS. Leur contenu est chiffré au repos avec AES-256-GCM. Les métadonnées de conversation restent lisibles en base. Le serveur peut déchiffrer les messages pour les participants autorisés et les opérateurs chargés du traitement des signalements. Conserver la clé et ses sauvegardes hors de Git et séparément de la base. Ne pas changer la clé sans procédure de réencryption. Avant la première migration effectuer une sauvegarde externe et arrêter l’ancienne instance. La migration crée une archive chiffrée distincte lorsqu’elle trouve des messages. Les anciennes sauvegardes antérieures à ce mécanisme nécessitent la procédure de protection ci-dessous.

## Préproduction privée

Pour activer TLS directement, fournir KIS_TLS_CERT et KIS_TLS_KEY, KIS_ORIGIN en HTTPS et KIS_STAGE_USER et KIS_STAGE_PASSWORD, avec un mot de passe aléatoire d’au moins 20 caractères. Le serveur écoute sur la boucle locale. Les appareils ont besoin d’un accès privé à un hôte HTTPS joignable et d’un certificat reconnu par Safari. Si un proxy interne est utilisé, préserver l’en-tête Host et limiter l’accès en amont.

Pour les appels adultes, définir KIS_TURN_URL avec une URL turns en TCP et KIS_TURN_SECRET avec le secret partagé du serveur TURN REST. Le service génère des identifiants temporaires et n’accepte que des candidats relayés. Aucun appel n’est lancé sans action et permission locale du microphone, et de la caméra pour la vidéo. Le consentement d’échange est revérifié pendant la signalisation. Tester le trafic média avec deux appareils et un relais approuvé avant un usage réel.

Pour Kis York, configurer KIS_MUSIC_TOKEN avec le jeton du service historique. Le serveur ne transfère l’extrait qu’après consentement explicite d’un compte adulte attesté. Il ne conserve pas d’historique de recherche. Vérifier avec un extrait de test autorisé, puis valider les règles de conservation du prestataire. Le client ne reçoit jamais ce jeton.

Les notifications push, le raccordement réseau de la coque mobile et les autres fonctions sociales restent à intégrer. Le build de la coque contient le verrouillage local par l’authentification système. Il doit être testé sur appareil.

## Protection et restauration des anciennes sauvegardes

Conserver une clé KIS_BACKUP_KEY aléatoire et distincte de KIS_DATA_KEY, hors de Git et séparément des archives. La migration exige cette clé lorsqu’elle trouve des messages antérieurs. Elle produit une sauvegarde authentifiée AES-256-GCM au format `.kisb` avant de chiffrer les messages. Le cliché temporaire SQLite est créé dans un répertoire privé et nettoyé au terme de la migration. Après un arrêt brutal, vérifier les éventuels répertoires privés `.kis-migration-*` sur l’hôte.

Pour une *ancienne sauvegarde* au repos, hors du service actif, charger la clé depuis le stockage sécurisé, puis lancer les commandes suivantes avec des chemins locaux. La protection vérifie l’archive avant de restreindre le fichier source à son propriétaire. Le fichier d’origine reste sur disque et contient toujours les anciennes données en clair. Le conserver sur un volume chiffré et à accès restreint. La restauration écrit une nouvelle copie uniquement après vérification du chiffrement. Réaliser les restaurations dans un répertoire privé sur un volume chiffré.

```sh
node server/backup.mjs protect ancienne.sqlite ancienne.kisb
node server/backup.mjs verify ancienne.kisb
node server/backup.mjs restore ancienne.kisb restauration.sqlite
```

## Proxy HTTPS privé

Sur l’hôte de recette, servir chaque studio sous un nom d’hôte distinct. KIS accepte KIS_TLS_TERMINATED_PROXY=1 pour un proxy privé qui termine TLS et conserve le Host. Utiliser KIS_ORIGIN avec le nom HTTPS exact, puis définir KIS_STAGE_USER et KIS_STAGE_PASSWORD pour l’authentification du studio. Le service Node reste accessible sur la boucle locale. Un proxy Tailscale Serve sur un hôte déjà disponible peut fournir l’URL uniquement aux appareils autorisés.

- [Accès privé avec Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)

## Fil KIS Social

Le fil textuel sert à enregistrer des publications personnelles et à partager avec les contacts adultes approuvés, si les deux comptes sont adultes attestés et ont consenti aux échanges. Le mode Ultra privé masque le partage avec les contacts. Les mineurs et les comptes en attente d’attestation peuvent uniquement utiliser leur espace personnel. Les publications sont chiffrées au repos. Un retrait masque le contenu du fil et conserve une trace en base pour l’opérateur. Les signalements sont consultables localement avec `node server/start.mjs list-social-reports`.

## Modules personnels de recette

Pulse propose un journal de session. Moments affiche jusqu’à quatre images sélectionnées sur l’appareil. Vibes ouvre un fichier audio local. Flash affiche un brouillon privé pendant une ou cinq minutes. Les notes de session, fichiers et brouillons de ces quatre modules ne sont pas envoyés au serveur. Fermer l’onglet ou changer de compte réinitialise l’espace. En quittant Moments, Vibes ou Flash, les aperçus et contenus de ces modules sont libérés. Les quatre modules devront être comparés aux maquettes et aux spécifications validées avant distribution.
