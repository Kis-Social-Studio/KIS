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
