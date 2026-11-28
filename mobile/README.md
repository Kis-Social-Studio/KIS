# Projets mobiles et recette Safari

Depuis ce répertoire, installer les dépendances verrouillées avec `npm ci`. Exécuter `npm run native:init` une fois pour générer les projets Xcode et Gradle, puis `npm run native:sync` après chaque modification du fichier web à la racine. Les projets générés sont dans `ios/App` et `android`. La commande de génération embarque le fichier du studio via `www/index.html`. Conserver les éventuelles personnalisations natives dans une révision du projet avant de régénérer ses dossiers.

La cible iOS et iPadOS minimale est 17.0 pour ce prétest. Utiliser Xcode sur macOS pour le simulateur et les appareils iOS et iPadOS, et Android Studio avec JDK 21 et le SDK indiqué par `android/variables.gradle` pour Android. Ouvrir le projet généré et utiliser la configuration Debug pour la recette interne. Vérifier l’identifiant défini dans `capacitor.config.json`. La signature de distribution, les visuels de boutique et les soumissions nécessitent une validation distincte. Les modèles générés contiennent les ressources génériques Capacitor du lanceur.

## Recette sur appareil Apple

Consigner le modèle, la version iOS ou iPadOS, la version Safari, l’URL de préproduction et le commit. Utiliser un iPhone et un iPad, en portrait et paysage. Tester d’abord Safari, puis la coque native sur les mêmes appareils. Vérifier le rechargement, la reprise après mise en arrière-plan, et la perte puis le retour de réseau. Activer VoiceOver, la taille de texte élevée et les deux apparences système. Vérifier les intitulés, l’ordre du focus, l’absence de contenu coupé et les alternatives textuelles aux informations sonores. Sur iPad, refaire la navigation au clavier externe. Consigner chaque anomalie avec les étapes et le résultat observé.

Sur Safari, ouvrir la préproduction HTTPS KIS depuis deux sessions isolées. Créer deux comptes fictifs et faire approuver le contact par l’opérateur. Vérifier les trois modes sur les huit entrées, la persistance après reconnexion, l’envoi et la réception de texte, le signalement et l’arrêt des échanges après blocage. Vérifier qu’un troisième compte ne peut pas accéder à la conversation.

La coque native embarque l’interface locale. Elle reste à raccorder à une origine HTTPS KIS approuvée pour la messagerie et les comptes, dont l’API exige la même origine. Les huit pictogrammes officiels restent à importer depuis leurs fichiers d’origine.

Le verrouillage local utilise le module natif BiometricAuth. Sur iPhone ou iPad vérifier l’enrôlement, le refus, l’annulation, le code système et le retour depuis l’arrière-plan. Sur Android vérifier la biométrie et le code, avec et sans verrouillage système configuré. Aucun code n’est saisi ni stocké par l’interface web. L’archive contient des projets Debug à compiler sur les postes équipés.

## Compilation GitHub Actions

Le workflow `.github/workflows/native-preflight.yml` définit une compilation Android Debug sur Ubuntu avec JDK 21 et SDK API 36 et une compilation de simulateur sans signature sur macOS 15. Les tâches sont limitées aux runners standards et aux dépôts publics. Elles ne transfèrent aucun artefact et ne consomment aucun secret de signature. Un push ordinaire ne lance aucune compilation. La compilation par push nécessite le marqueur `[native-preflight]` dans le dernier message de commit de `developpement/regroupement`. GitHub exige que le workflow soit présent sur la branche par défaut avant le déclenchement avec `workflow_dispatch`.

Les sources et journaux sont soumis à la visibilité du dépôt. Garder les secrets et les données de test hors des commits. Une compilation réussie précède les tests sur appareils physiques et la signature. Confirmer les paramètres de facturation GitHub avant tout changement de visibilité, de runner ou de stockage des artefacts.

- [Runners standards](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Déclenchement manuel](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)

## Préparer les paquets signés

La compilation de recette GitHub Actions reste indépendante de la signature. Pour les paquets de distribution, générer et synchroniser les projets depuis le commit validé, puis exécuter le script `mobile/release.sh` sur un runner autorisé. Le répertoire de sortie doit être un nouveau chemin absolu. Le script produit uniquement des fichiers locaux. Ne placer aucune clé ni profil de distribution dans Git. Le projet nécessite encore les visuels de lanceur approuvés, la version commerciale et un numéro de build validés.

- **iOS** — sur un runner macOS autorisé, utiliser un trousseau éphémère avec certificat Apple Distribution et installer le profil App Store correspondant à l’identifiant. Fournir IOS_TEAM_ID, IOS_PROFILE_NAME et IOS_EXPORT_OPTIONS_PLIST dans l’environnement. Le fichier plist doit indiquer `app-store-connect` et une destination `export`. Lancer `bash mobile/release.sh ios /chemin/prive/ios-build`.
- **Android** — sur un runner autorisé équipé du JDK 21 et du SDK, fournir le keystore de téléversement par ANDROID_UPLOAD_KEYSTORE, son alias par ANDROID_UPLOAD_ALIAS, les deux mots de passe d’environnement ANDROID_UPLOAD_STOREPASS et ANDROID_UPLOAD_KEYPASS, et l’empreinte de la clé de téléversement attendue par ANDROID_UPLOAD_SHA256. Lancer `bash mobile/release.sh android /chemin/prive/android-build`. Le script vérifie l’empreinte du paquet produit.

Les comptes App Store Connect et Play Console, leurs certificats et clés ainsi que l’autorisation de préparer un runner avec ces secrets restent nécessaires. L’import des paquets dans les consoles et leur diffusion sont des opérations séparées.

- [Certificats Apple](https://developer.apple.com/help/account/certificates/certificates-overview/)
- [Signature Android](https://developer.android.com/studio/publish/app-signing)

La recette automatisée comprend aussi le bundle Android Release non signé et la compilation iOS Release pour appareil générique sans signature. Les vérifications de recette se déroulent sur les runners et ne transfèrent aucun paquet.
