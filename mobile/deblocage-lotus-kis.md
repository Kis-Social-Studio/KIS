# Déblocage de la recette LOTUS et KIS

## 1. Relier les Workers existants

1. Dans Cloudflare, ouvrir **Workers & Pages** et sélectionner les Workers qui correspondent à LOTUS IA et Kis York. Vérifier les domaines **lotus-ia.dethierhelene.workers.dev/chat** et **kisyork.dethierhelene.workers.dev**. Consulter les réglages **Variables and Secrets**, sans copier les valeurs dans la conversation ou GitHub.
2. Dans le code du Worker, confirmer le chemin, le format POST et la manière dont le jeton d’appel est vérifié. Le relais LOTUS envoie un objet JSON avec `message`. KIS envoie un multipart avec le champ `file`. Les deux relais transmettent un jeton Bearer côté serveur. L’ancienne interface de Kis York mentionne `CLIENT_TOKEN`. Confirmer le nom réellement utilisé par le Worker et que le jeton est destiné aux clients autorisés. La clé du fournisseur IA ou musical reste dans Cloudflare.
3. Une fois l’essai autorisé et les limites approuvées, déposer le jeton LOTUS dans le stockage secret du serveur sous **LOTUS_AI_TOKEN** et activer **LOTUS_AI_RELAY=1**. Déposer le jeton d’appel Kis York sous **KIS_MUSIC_TOKEN**. Injecter les valeurs dans les processus Node depuis le gestionnaire de secrets. Utiliser une seule question et un seul extrait fictifs avec un compte de test adulte attesté et consentant. Contrôler le résultat, puis révoquer les jetons temporaires si utilisés.
4. Pour les appels, confirmer un relais TURN déjà autorisé. Renseigner **KIS_TURN_URL** avec une URL `turns:` en TCP et **KIS_TURN_SECRET** avec le secret TURN REST côté serveur. Faire un essai à deux appareils, avec consentement, puis couper le micro, raccrocher et essayer un retrait du consentement. Les notifications dans l’application sont séparées des notifications push, dont les accès et l’intégration restent nécessaires.

[Secrets Workers](https://developers.cloudflare.com/workers/configuration/secrets/)

## 2. Fournir deux liens Safari privés sans Mac

Sur un hôte Linux existant et autorisé, faire écouter les deux serveurs sur des ports de boucle locale différents. Si un domaine Cloudflare est déjà disponible, créer deux applications **Cloudflare Access** pour deux noms d’hôte distincts, avec une liste nominative d’adresses autorisées. Vérifier les refus dans une session sans accès avant de rattacher le tunnel à l’origine. Activer `LOTUS_TLS_TERMINATED_PROXY=1` et `KIS_TLS_TERMINATED_PROXY=1`, définir chaque origine HTTPS exacte et préserver l’en-tête Host. Conserver les mots de passe de recette côté serveur et les communiquer séparément. Ouvrir chaque lien sur iPhone et iPad dans Safari et vérifier le certificat et la demande d’accès. Cette opération attend l’autorisation sur l’hôte, le domaine et les paramètres Cloudflare. Ne créer aucun abonnement pour cette recette.

Si un réseau Tailscale existant est déjà autorisé pour les appareils, Tailscale Serve peut fournir l’accès HTTPS privé avec deux origines. Conserver le filtrage du réseau et les authentifications des studios.

[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) · [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)

## 3. Préparer les signatures

**Apple.** Dans le compte Apple Developer existant, choisir l’équipe autorisée et vérifier les deux identifiants `com.famillelotus.studio` et `com.kissocialstudio.kis`. Pour chacun, préparer un profil App Store lié au certificat Apple Distribution adéquat. La clé privée doit rester dans un trousseau autorisé. Pour un runner macOS, prévoir un trousseau éphémère et l’accès sécurisé au certificat avec sa clé privée, au profil, au Team ID et au nom de profil. Préparer un fichier ExportOptions pour chaque studio avec `method=app-store-connect`, `destination=export` et la correspondance exacte entre l’identifiant et le profil. Autoriser explicitement l’utilisation de ces éléments sur le runner avant l’exécution de `mobile/release.sh`.

**Android.** Dans chaque fiche Play Console existante, vérifier l’identifiant et ouvrir **Intégrité de l’application > Signature d’application**. Relever l’empreinte SHA-256 du **certificat de téléversement** et identifier le keystore et l’alias correspondants. Transmettre le keystore, les mots de passe et l’alias uniquement via le gestionnaire de secrets du runner. Fournir l’empreinte attendue au script. Si une fiche, une clé ou un compte manque, valider la création ou la réinitialisation avant toute action et toute dépense. Les scripts produisent des paquets locaux et une vérification de signature. La soumission aux boutiques reste une étape séparée.

[Profils App Store](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile/) · [Signature Android](https://developer.android.com/studio/publish/app-signing)

## 4. Fournir les visuels validés

Déposer les huit fichiers originaux avec une correspondance explicite par module, les maquettes approuvées des deux studios et les icônes de lanceur approuvées. Les visuels historiques retrouvés servent à comparer les versions. La validation graphique et les essais Safari et VoiceOver sur appareil précèdent la publication.
