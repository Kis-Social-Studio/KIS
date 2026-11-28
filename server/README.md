# Serveur KIS de préproduction

Node.js 24 et SQLite intégré suffisent pour le serveur. Depuis la racine du dépôt, lancer `node server/start.mjs`, puis ouvrir `http://127.0.0.1:8787`. Le serveur écoute sur la boucle locale. Le fichier SQLite persistant se trouve par défaut dans `~/.kis-data`. `KIS_DATA`, `KIS_PORT` et `KIS_ORIGIN` permettent de configurer l’instance. Garder le répertoire de données réservé au compte système du serveur. Tester avec `node --test --test-isolation=none server/service.test.mjs`.

Utiliser uniquement des comptes fictifs pour cette phase. Créer deux comptes dans des sessions de navigateur distinctes. L’opérateur doit vérifier les permissions et le consentement avant d’exécuter la commande locale suivante avec le même répertoire de données que le serveur.

```sh
node server/start.mjs approve-contact compte_a compte_b
```

Après actualisation de la liste, les deux comptes peuvent communiquer par texte. Le blocage coupe la lecture et l’envoi dans les deux sens. Un destinataire peut signaler un message reçu. Un opérateur autorisé peut consulter les 100 derniers signalements avec `node server/start.mjs list-reports`. Cette sortie contient les textes signalés. La réserver à un poste habilité.

Les comptes ont un identifiant pseudonyme et un mot de passe dérivé avec scrypt et un sel individuel. Les sessions de huit heures utilisent un cookie HttpOnly avec SameSite Strict, et Secure sous HTTPS. Les requêtes d’écriture exigent l’origine configurée. Les identifiants de session sont hachés en base. L’API applique le socle de protection à tous les comptes, avec Privé par défaut. Les six options du socle couvrent le profil, la localisation, les invitations, les contacts, les recommandations et le partage. Le serveur ne fournit aucun annuaire ni recherche de profil. Le mode choisi ne dispense jamais de l’approbation du contact.

Pour des prétests Safari sur appareil, utiliser un hôte HTTPS de préproduction à accès restreint, avec un proxy qui préserve l’en-tête Host, termine TLS, limite les requêtes et transfère au serveur local. Définir KIS_ORIGIN sur l’origine HTTPS exacte. Prévoir une instance et une base dédiées aux tests. Le serveur est conçu pour un seul processus applicatif. Les commandes opérateur sont des opérations locales ponctuelles.

Avant une ouverture à de vrais utilisateurs, il reste à valider les procédures de vérification d’âge et de consentement, organiser le traitement des signalements, la récupération de compte et la durée de conservation, vérifier sauvegarde et restauration, puis tester le déploiement et sa supervision. Les messages sont stockés en clair dans la base SQLite et transmis sous TLS en préproduction HTTPS. La messagerie livrée est textuelle, avec actualisation manuelle. Les communications audio et vidéo, les médias, les notifications, le verrouillage natif et les fonctions sociales et musicales restent à intégrer. Les préférences liées à ces fonctions sont enregistrées, en attendant leur application par les services correspondants.
