# Prompt — Sesame : gestionnaire de mots de passe Electron compatible `pass`

> Copie tout ce qui suit la ligne de séparation et donne-le à Fable.

---

## Rôle et objectif

Tu es un ingénieur senior spécialisé en Electron, TypeScript et sécurité applicative. Tu vas concevoir et livrer **Sesame**, une application de bureau multiplateforme (Linux, Windows, macOS) de gestion de mots de passe, **100 % compatible avec le standard `pass`** (https://www.passwordstore.org/), avec des exécutables prêts à installer pour les trois OS.

L'expérience centrale est de type « Spotlight / Raycast » : **un raccourci clavier global ouvre une petite fenêtre avec un champ de recherche**. Je tape, je trouve, j'appuie sur Entrée, le mot de passe est copié. **Si l'entrée n'existe pas**, je peux la créer immédiatement, soit en **collant/saisissant** un mot de passe, soit en **générant** un nouveau mot de passe.

Travaille de façon autonome, par phases, et livre un code complet et fonctionnel (pas de pseudo-code, pas de `TODO` laissés dans les fonctionnalités demandées).

---

## 1. Contrainte clé : `pass` sur Windows

`pass` est un script bash qui ne tourne pas nativement sur Windows (uniquement via WSL). Pour avoir **le même comportement sur les trois OS**, applique cette architecture :

- **Réimplémente le protocole `pass` en TypeScript** dans le process principal d'Electron, au lieu d'appeler le script `pass`.
- Le chiffrement/déchiffrement passe par le **binaire `gpg` du système** :
  - Linux : GnuPG (paquet `gnupg`) ;
  - macOS : GnuPG via Homebrew ou GPG Suite ;
  - Windows : **Gpg4win** (`gpg.exe`, généralement dans `C:\Program Files (x86)\GnuPG\bin` ou `C:\Program Files\GnuPG\bin`).
- La phrase de passe de la clé privée est gérée par **`gpg-agent` + pinentry** (pinentry-gtk/qt, pinentry-mac, pinentry-w32). L'application **ne demande ni ne stocke jamais** la phrase de passe GPG elle-même.
- Le format du store doit rester **strictement identique** à celui de `pass`, pour qu'un même dépôt soit utilisable en parallèle avec `pass`, `gopass`, QtPass, Android Password Store, passff, Pass for iOS, etc.

Détection de `gpg` : chercher dans le `PATH`, puis dans les emplacements standards par OS, avec la possibilité de définir un chemin personnalisé dans les paramètres. Si `gpg` est introuvable, afficher un écran d'aide avec les instructions d'installation propres à l'OS.

---

## 2. Compatibilité `pass` (spécification à respecter)

- **Emplacement du store** : `$PASSWORD_STORE_DIR` s'il est défini, sinon `~/.password-store` (`%USERPROFILE%\.password-store` sous Windows). Modifiable dans les paramètres.
- **Une entrée = un fichier** `chemin/vers/entree.gpg`. Le nom affiché correspond au chemin relatif sans `.gpg`, avec `/` comme séparateur sur tous les OS (normaliser les `\` de Windows).
- **`.gpg-id`** : liste des ID/empreintes de clés destinataires (une par ligne). Le `.gpg-id` le plus proche en remontant l'arborescence s'applique (sous-dossiers avec des destinataires différents). Prendre en charge plusieurs destinataires.
- **Contenu d'une entrée** : la 1re ligne est le mot de passe ; les lignes suivantes sont libres, avec la convention `clé: valeur` (`login:`, `user:`, `username:`, `email:`, `url:`…) ; une ligne `otpauth://…` active le TOTP (compatible `pass-otp`).
- **Chiffrement** : `gpg --encrypt --batch --yes --quiet --recipient <id>… --output <fichier>`, avec le contenu sur stdin. Respecter `PASSWORD_STORE_GPG_OPTS` s'il existe.
- **Déchiffrement** : `gpg --decrypt --batch --quiet --yes` avec sortie sur stdout (le pinentry est géré par l'agent).
- **Git** : si le store est un dépôt git, chaque modification crée un commit avec les mêmes messages que `pass` (`Add given password for X to store.`, `Add generated password for X.`, `Edit password for X using Sesame.`, `Remove X from store.`, `Rename X to Y.`, `Copy X to Y.`). Proposer pull, push, status et log dans l'interface. Utiliser le binaire `git` du système, appelé avec `execFile`.
- **Variables d'environnement à respecter** : `PASSWORD_STORE_DIR`, `PASSWORD_STORE_KEY`, `PASSWORD_STORE_GPG_OPTS`, `PASSWORD_STORE_CLIP_TIME` (45 s par défaut), `PASSWORD_STORE_GENERATED_LENGTH` (25 par défaut), `PASSWORD_STORE_CHARACTER_SET`, `PASSWORD_STORE_CHARACTER_SET_NO_SYMBOLS`.

### Commandes `pass` à couvrir (toutes accessibles depuis l'interface)

| Commande `pass` | Équivalent dans Sesame |
|---|---|
| `init [--path=sub] gpg-id…` | Assistant d'initialisation du store ou d'un sous-dossier, avec **re-chiffrement** de toutes les entrées concernées si les destinataires changent |
| `ls` / `find` | Arborescence + recherche floue |
| `grep` | Recherche dans le contenu déchiffré (à la demande, avec progression et annulation) |
| `show [--clip[=ligne]] [--qrcode]` | Affichage de l'entrée, copie du mot de passe ou d'une ligne, QR code |
| `insert [--multiline]` | Création manuelle, en une ligne ou en plusieurs lignes |
| `edit` | Éditeur intégré (pas d'éditeur externe) |
| `generate [--no-symbols] [--in-place] [--force] name length` | Générateur intégré |
| `rm [-r]` | Suppression d'une entrée ou d'un dossier, avec confirmation |
| `mv` / `cp` | Renommer, déplacer, dupliquer (en re-chiffrant si le `.gpg-id` cible est différent) |
| `git …` | Panneau de synchronisation git |
| `otp` (extension pass-otp) | Code TOTP en direct avec compte à rebours, copie, ajout d'une URI `otpauth://` ou import par QR code (image ou capture d'écran) |

---

## 3. Expérience « lanceur rapide » (le cœur du produit)

### Raccourci global
- Par défaut : `Ctrl+Shift+Espace` (Windows/Linux), `Cmd+Shift+Espace` (macOS). **Configurable** dans les paramètres, avec un enregistreur de raccourci et la détection des conflits (`globalShortcut.register` renvoie `false` en cas de conflit).
- Le raccourci **affiche ou masque** la fenêtre de recherche. Le focus doit aller dans l'input immédiatement.
- **Wayland** : `globalShortcut` ne fonctionne pas sous Wayland pur. Prévois une solution de repli : l'application est mono-instance (`app.requestSingleInstanceLock`) et lancer `sesame --toggle` affiche ou masque la fenêtre de l'instance déjà ouverte. Documente comment lier cette commande à un raccourci dans GNOME/KDE. Essaie aussi le portail `org.freedesktop.portal.GlobalShortcuts` quand il est disponible.

### Fenêtre de recherche
- Sans cadre, centrée sur l'écran actif (celui du curseur), toujours au premier plan, coins arrondis, environ 680 × 420 px, thème clair/sombre selon le système.
- Masquée quand elle perd le focus ou sur `Échap`. Elle n'apparaît pas dans la barre des tâches ni dans le Dock (`skipTaskbar`, `app.dock.hide()` en mode lanceur) ; une icône dans la zone de notification (tray) reste présente.
- **Recherche floue instantanée** sur les chemins des entrées (fuse.js ou équivalent), avec les correspondances surlignées, **sans déchiffrer quoi que ce soit**. Classement : correspondance exacte, puis préfixe, puis fréquence et date d'utilisation (historique local ne contenant que des noms d'entrées, jamais de secrets).
- L'index du store est surveillé (chokidar) pour suivre les changements faits par `pass` ou par git.

### Raccourcis dans la fenêtre
| Touche | Action |
|---|---|
| `↑` / `↓` | Naviguer dans les résultats |
| `Entrée` | Copier le mot de passe et masquer la fenêtre |
| `Shift+Entrée` | Copier l'identifiant (`login:`/`user:`/`username:`/`email:`, sinon le dernier segment du chemin) |
| `Ctrl/Cmd+O` | Copier le code OTP |
| `Ctrl/Cmd+U` | Ouvrir l'URL dans le navigateur |
| `Tab` / `→` | Ouvrir le détail de l'entrée (affichage, édition) |
| `Ctrl/Cmd+N` | Créer une entrée à partir du texte saisi |
| `Ctrl/Cmd+G` | Créer une entrée avec un mot de passe généré |
| `Ctrl/Cmd+E` | Éditer l'entrée sélectionnée |
| `Ctrl/Cmd+Backspace` | Supprimer (avec confirmation) |
| `Échap` | Revenir en arrière, puis fermer |

### Entrée inexistante : création immédiate
Quand la recherche ne donne **aucun résultat exact**, la liste affiche toujours en premier :
1. **« Créer `<saisie>` avec un mot de passe généré »** : génère selon les réglages par défaut, enregistre, copie le mot de passe et affiche une confirmation. Un clic ou une flèche ouvre le générateur pour ajuster les options avant d'enregistrer.
2. **« Créer `<saisie>` à partir du presse-papiers »** : propose le contenu actuel du presse-papiers, masqué, avec un bouton œil pour l'afficher.
3. **« Créer `<saisie>` en saisissant le mot de passe »** : mini-formulaire avec mot de passe, identifiant, URL et notes.

Le texte saisi devient le chemin de l'entrée (`web/github.com/moi` est accepté et crée les sous-dossiers). Le chemin est validé : pas de `..`, pas de chemin absolu, pas de caractères interdits sous Windows, pas d'écrasement sans confirmation.

---

## 4. Générateur de mots de passe

- Basé sur `crypto.getRandomValues` / `crypto.randomInt` **sans biais de modulo**.
- **Mode caractères** : longueur de 8 à 128 (25 par défaut), majuscules, minuscules, chiffres, symboles, exclusion des caractères ambigus (`0O1lI|`), caractères exclus personnalisés, au moins un caractère de chaque classe cochée.
- **Mode phrase de passe** : liste EFF large (embarquée), nombre de mots, séparateur, majuscules, ajout d'un chiffre.
- **Mode PIN**.
- Indicateur de robustesse (zxcvbn) et entropie en bits.
- Préréglages mémorisés. Génération « en place » (`--in-place`) : remplace la 1re ligne d'une entrée existante en conservant les autres lignes.

---

## 5. Application principale (vue complète)

Au-delà du lanceur, une fenêtre « gestionnaire » (ouverte depuis le tray ou depuis le lanceur) propose :
- une arborescence des dossiers, une liste et un détail d'entrée (champs `clé: valeur` affichés comme des champs copiables, notes, TOTP, QR code) ;
- la création, l'édition (éditeur multiligne avec un bouton « générer » sur la 1re ligne), le renommage, le déplacement par glisser-déposer, la duplication et la suppression ;
- la gestion des `.gpg-id` par dossier, avec la liste des clés disponibles (`gpg --list-keys --with-colons`) et un re-chiffrement avec barre de progression ;
- un panneau git (statut, pull, push, historique, clonage d'un store distant à la première configuration) ;
- **l'onboarding** : détection de `gpg`, détection d'un store existant, sinon assistant de **création d'une clé GPG** (`gpg --quick-generate-key` avec ed25519/cv25519) ou d'import d'une clé, puis `init` du store et `git init` en option ;
- les **paramètres** : raccourci global, chemin du store, chemin de `gpg`, durée d'effacement du presse-papiers, options par défaut du générateur, lancement au démarrage de la session, thème, langue (**FR et EN**), verrouillage automatique (oubli des données déchiffrées après N minutes et appel à `gpgconf --reload gpg-agent` en option).

---

## 6. Sécurité (non négociable)

- Configuration Electron : `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, CSP stricte, aucun contenu distant chargé, `setWindowOpenHandler` qui refuse tout, navigation bloquée, **Electron Fuses** durcis (désactivation de `RunAsNode`, de `NODE_OPTIONS` et du débogage d'inspection ; `EnableEmbeddedAsarIntegrityValidation` et `OnlyLoadAppFromAsar` activés).
- Le preload n'expose qu'une **API IPC typée et en liste blanche** (`contextBridge`). Chaque argument est validé dans le process principal (zod).
- Tous les appels système passent par `execFile`/`spawn` **avec un tableau d'arguments, jamais via un shell**. Les secrets transitent par stdin et stdout, jamais par la ligne de commande ni par des fichiers temporaires.
- **Presse-papiers** : effacement automatique après `PASSWORD_STORE_CLIP_TIME` secondes, **seulement si le contenu n'a pas changé entre-temps**, avec un compte à rebours dans le tray. Exclusion de l'historique du presse-papiers et des gestionnaires de presse-papiers :
  - Windows : formats `ExcludeClipboardContentFromMonitorProcessing` et `CanIncludeInClipboardHistory = 0` ;
  - macOS : type `org.nspasteboard.ConcealedType` ;
  - Linux : type MIME `x-kde-passwordManagerHint = secret`.
  Si ces formats ne sont pas accessibles via l'API Electron, utilise un petit module natif ou un helper documenté.
- Aucun secret dans les logs, la télémétrie (il n'y en a pas), les messages d'erreur ou les crash reports. Les secrets déchiffrés sont gardés en mémoire le moins longtemps possible et ne sont jamais envoyés au renderer sans une action explicite de l'utilisateur.
- Protection contre la capture d'écran de la fenêtre (`setContentProtection(true)`) quand un secret est affiché.
- Aucune dépendance réseau à l'exécution, en dehors de git et de la mise à jour automatique (désactivable).

---

## 7. Stack technique imposée

- **Electron** (dernière version stable), **TypeScript strict**, **electron-vite**, **React** + **Tailwind CSS**, avec une liste virtualisée pour les gros stores (plus de 5 000 entrées).
- Dépendances suggérées : `fuse.js`, `chokidar`, `zod`, `otpauth`, `qrcode`, `jsqr` (import de QR), `@zxcvbn-ts/core`, `i18next`.
- Packaging : **electron-builder** avec
  - Linux : `AppImage`, `deb`, `rpm` (x64 et arm64) ;
  - Windows : installeur `nsis` et version `portable` (x64 et arm64) ;
  - macOS : `dmg` et `zip`, **universal** (arm64 et x64), entitlements et hardened runtime prêts pour la notarisation.
- **CI GitHub Actions** : matrice `ubuntu-latest`, `windows-latest`, `macos-latest` qui lance typecheck, lint, tests et build, et publie les artefacts dans une GitHub Release sur un tag `v*`. Signature et notarisation conditionnelles via des secrets (`CSC_LINK`, `APPLE_ID`, etc.), le build ne doit pas échouer en leur absence. Le détail des exigences de qualité, de typage, de tests et de CI est en **section 9**.
- Mise à jour automatique avec `electron-updater` (désactivable).
- Lancement au démarrage via `app.setLoginItemSettings` (Windows/macOS) et un fichier `.desktop` dans `~/.config/autostart` (Linux).

### Architecture attendue

```
src/
  main/
    index.ts            # cycle de vie, mono-instance, tray, fenêtres
    shortcuts.ts        # raccourci global + --toggle + portail Wayland
    ipc.ts              # handlers IPC validés par zod
    store/
      PasswordStore.ts  # list, show, insert, generate, edit, rm, mv, cp, grep, init, reencrypt
      gpg.ts            # détection du binaire, encrypt/decrypt, liste des clés
      git.ts            # commit, pull, push, status, log, clone
      entry.ts          # parsing de la 1re ligne, des clés:valeurs et d'otpauth
      paths.ts          # validation et normalisation des chemins
    clipboard.ts        # copie sécurisée et effacement automatique
    generator.ts        # générateur de mots de passe
    settings.ts
  preload/index.ts      # API contextBridge typée
  renderer/
    launcher/           # fenêtre de recherche rapide
    manager/            # fenêtre complète
    components/ i18n/
tests/
  unit/                 # vitest
  e2e/                  # Playwright pour Electron
```

---

## 8. Tests et critères d'acceptation

- **Tests unitaires (vitest)** du `PasswordStore` contre un vrai `gpg` : chaque test crée un `GNUPGHOME` temporaire, génère une clé de test sans phrase de passe et un store temporaire. Couvrir insert, show, generate, edit, mv, cp, rm, les `.gpg-id` imbriqués, le re-chiffrement, le parsing des entrées, l'OTP, la validation des chemins (y compris les tentatives de path traversal) et l'absence de biais du générateur.
- **Test de compatibilité** : si `pass` est installé dans la CI Linux, une entrée créée par Sesame doit être lisible par `pass show`, et l'inverse doit fonctionner.
- **Tests E2E (Playwright + Electron)** : ouverture par `--toggle`, recherche, copie, création d'une entrée inexistante par génération puis par presse-papiers.
- La CI doit être verte sur les trois OS.

**Définition de « terminé »** :
1. `npm install && npm run dev` lance l'application en développement.
2. `npm run dist` produit les installeurs de l'OS courant ; la CI les produit pour les trois OS.
3. Sur une machine où `gpg` est installé, je peux en moins de 2 minutes : créer ou choisir une clé, initialiser un store, appuyer sur le raccourci, taper `github`, voir qu'il n'existe pas, le créer avec un mot de passe généré, et le retrouver puis le copier au raccourci suivant.
4. Le store produit est lisible tel quel par `pass` sous Linux/macOS.
5. `npm run verify` passe en local sans aucune erreur de type, aucun avertissement ESLint, avec la couverture au-dessus des seuils de la section 9.
6. La CI GitHub Actions est **verte sur les trois OS** (quality, test, e2e, build).

---

## 9. Qualité du code, typage, tests et CI (obligatoire)

### Typage
- TypeScript en mode **`strict`** partout (main, preload, renderer, tests, scripts), avec en plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`, `noFallthroughCasesInSwitch` et `verbatimModuleSyntax`.
- **Interdits** : `any` implicite ou explicite, `// @ts-ignore`, `// @ts-nocheck`, assertions `as` non justifiées. `// @ts-expect-error` n'est toléré qu'avec un commentaire d'explication. Ces règles sont imposées par ESLint (`@typescript-eslint/no-explicit-any`, `ban-ts-comment`, `no-non-null-assertion`).
- **Contrats IPC typés de bout en bout** : un seul fichier `src/shared/ipc.ts` définit les canaux, leurs arguments et leurs retours. Le preload, les handlers du process principal et le renderer en dérivent leurs types. Les schémas zod servent de source de vérité : les types sont inférés avec `z.infer`, jamais écrits à la main en double.
- Les erreurs attendues (gpg introuvable, clé absente, entrée existante, chemin invalide, conflit git…) sont des **types explicites** (union discriminée ou `Result<T, E>`), pas des chaînes de caractères.
- Les types sont **branded** pour les valeurs à risque (`EntryPath`, `GpgKeyId`, `PlainSecret`), afin qu'on ne puisse pas passer un chemin non validé ou un secret à la place d'une chaîne quelconque.

### Lint et format
- **ESLint** (config flat, `typescript-eslint` en mode `strictTypeChecked` et `stylisticTypeChecked`, `eslint-plugin-react`, `react-hooks`, `jsx-a11y`, `eslint-plugin-security`, `eslint-plugin-n`) avec **zéro avertissement toléré** (`--max-warnings 0`).
- **Prettier** pour le format, vérifié en CI (`prettier --check`).
- **Hooks git** avec `husky` + `lint-staged` : lint, format et typecheck sur les fichiers modifiés avant chaque commit.
- **Commits conventionnels** (`commitlint`).

### Tests
- **Unitaires (vitest)** : couverture minimale imposée en CI (**≥ 90 % des lignes et des branches** sur `src/main/store`, `generator`, `clipboard`, `paths`, `entry` ; ≥ 80 % sur le reste). Le build échoue en dessous du seuil.
- Les tests sont **déterministes** : horloge simulée (`vi.useFakeTimers`) pour le TOTP et l'effacement du presse-papiers, aléa injecté pour le générateur, aucun accès au vrai `~/.password-store`, aucun test qui dépend de l'ordre d'exécution.
- Tests de la logique du renderer avec **React Testing Library** (recherche, navigation clavier, création d'une entrée inexistante, états d'erreur), et vérification de l'accessibilité avec `jest-axe`.
- Tests de **propriétés** (`fast-check`) pour le générateur (longueur, classes de caractères respectées, caractères exclus absents) et pour la validation des chemins (aucune chaîne ne doit permettre de sortir du store).
- **Tests de sécurité** : tentatives de path traversal, noms d'entrée avec caractères spéciaux et injection d'arguments (`--option`) vers `gpg` et `git`, vérification qu'aucun secret n'apparaît dans les logs, les erreurs ou les arguments des processus.
- **E2E (Playwright pour Electron)** sur les trois OS pour le parcours principal (raccourci ou `--toggle`, recherche, copie, création par génération et par presse-papiers).
- Scripts npm attendus : `typecheck`, `lint`, `format:check`, `test`, `test:coverage`, `test:e2e`, `build`, `dist`, et `verify` qui enchaîne typecheck, lint, format:check, test:coverage et build.

### CI GitHub Actions
- Workflow **`ci.yml`** déclenché sur chaque `push` et `pull_request`, avec ces jobs :
  1. **`quality`** (Ubuntu) : installation avec `npm ci`, `typecheck`, `lint`, `format:check`, `npm audit --audit-level=high`, vérification des licences des dépendances ;
  2. **`test`** en **matrice** `ubuntu-latest` / `windows-latest` / `macos-latest` : installation de GnuPG sur chaque OS (apt, Chocolatey ou Homebrew), tests unitaires avec couverture, envoi du rapport (Codecov ou artefact) et échec sous le seuil ;
  3. **`e2e`** en matrice sur les trois OS (sous Linux avec `xvfb-run`) ;
  4. **`build`** en matrice : `electron-builder` sans publication, avec les installeurs conservés comme artefacts de la CI.
- Workflow **`release.yml`** déclenché sur un tag `v*` : rejoue `verify` sur les trois OS, construit les installeurs, génère les sommes de contrôle SHA-256, et crée la GitHub Release avec les notes issues des commits conventionnels. Signature et notarisation conditionnelles aux secrets, sans échec en leur absence.
- **Hygiène des workflows** : `permissions: contents: read` par défaut, actions épinglées par SHA, `concurrency` pour annuler les exécutions obsolètes, cache npm, `timeout-minutes` sur chaque job, **Dependabot** (npm et GitHub Actions) et **CodeQL** (JavaScript/TypeScript) activés.
- Règle de **branche protégée** documentée dans le README : fusion impossible tant que `quality`, `test`, `e2e` et `build` ne sont pas verts.

---

## 10. Méthode de travail

Avance par phases, en t'assurant que chacune **compile sans erreur de type, passe lint et tests** avant de passer à la suivante. **Écris les tests en même temps que le code** (idéalement le test d'abord pour la logique métier), pas à la fin :
1. Squelette electron-vite, sécurité Electron, mono-instance, tray et raccourci global.
2. Couche `gpg` et `PasswordStore` avec leurs tests unitaires.
3. Lanceur : recherche, copie, création d'entrée inexistante.
4. Générateur.
5. Fenêtre gestionnaire : CRUD, `.gpg-id`, re-chiffrement, OTP, QR code.
6. Git.
7. Onboarding, paramètres, i18n.
8. Packaging, CI multi-OS et mise à jour automatique.
9. README (installation de GnuPG/Gpg4win par OS, raccourcis, configuration Wayland, compatibilité `pass`, build) et `SECURITY.md` (modèle de menace).

Si une contrainte est techniquement impossible sur un OS, ne la contourne pas en silence : explique-la, propose la meilleure alternative, implémente-la et documente-la dans le README.
