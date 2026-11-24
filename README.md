# Sesame

Sesame est un gestionnaire de mots de passe de bureau (Linux, Windows, macOS) au fonctionnement de type « Spotlight » : un raccourci clavier global ouvre une petite fenêtre de recherche, vous tapez, Entrée, et le mot de passe est copié. Si l'entrée n'existe pas, vous la créez sur place, avec un mot de passe généré, collé depuis le presse-papiers ou saisi au clavier.

Sesame est **100 % compatible avec [`pass`](https://www.passwordstore.org/)**. Il lit et écrit le même store, avec les mêmes fichiers `.gpg`, les mêmes `.gpg-id` et les mêmes messages de commit git. Vous pouvez donc utiliser en parallèle `pass`, `gopass`, QtPass, Android Password Store, passff, Pass for iOS, etc.

- [Installation](#installation)
- [Premier lancement](#premier-lancement)
- [Raccourcis](#raccourcis)
- [Wayland](#wayland-raccourci-global)
- [Renouvellement des mots de passe](#renouvellement-des-mots-de-passe)
- [Compatibilité avec pass](#compatibilité-avec-pass)
- [Paramètres](#paramètres)
- [Développement et build](#développement-et-build)
- [Limites connues et choix de conception](#limites-connues-et-choix-de-conception)
- [Sécurité](SECURITY.md)

## Installation

### 1. Installer GnuPG

Sesame ne réimplémente pas la cryptographie : il appelle le programme `gpg` du système. La phrase de passe de votre clé est demandée par `gpg-agent` via **pinentry**. Sesame ne la voit jamais et ne la stocke jamais.

| OS                  | Installation                                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Debian / Ubuntu     | `sudo apt install gnupg pinentry-gnome3` (ou `pinentry-qt` sous KDE)                                                                                                    |
| Fedora              | `sudo dnf install gnupg2 pinentry-gnome3`                                                                                                                               |
| Arch                | `sudo pacman -S gnupg pinentry`                                                                                                                                         |
| macOS (Homebrew)    | `brew install gnupg pinentry-mac`, puis ajoutez `pinentry-program $(brew --prefix)/bin/pinentry-mac` à `~/.gnupg/gpg-agent.conf` et exécutez `gpgconf --kill gpg-agent` |
| macOS (alternative) | [GPG Suite](https://gpgtools.org/)                                                                                                                                      |
| Windows             | [Gpg4win](https://gpg4win.org/) (pinentry graphique inclus)                                                                                                             |

Sesame cherche `gpg` dans le `PATH`, puis aux emplacements standards :

- Linux : `/usr/bin/gpg`, `/usr/local/bin/gpg`, `/usr/bin/gpg2` ;
- macOS : `/opt/homebrew/bin/gpg`, `/usr/local/bin/gpg`, `/usr/local/MacGPG2/bin/gpg2` ;
- Windows : `C:\Program Files (x86)\GnuPG\bin\gpg.exe`, `C:\Program Files\GnuPG\bin\gpg.exe`.

Un autre chemin peut être choisi dans **Paramètres → Programme gpg**. Si `gpg` est introuvable, Sesame affiche les instructions d'installation propres à votre OS.

`git` est facultatif. Il n'est nécessaire que pour la synchronisation.

### 2. Installer Sesame

Téléchargez l'installeur de la [dernière release](../../releases) :

| OS      | Fichiers                                                                                                 |
| ------- | -------------------------------------------------------------------------------------------------------- |
| Linux   | `Sesame-x.y.z-linux-x86_64.AppImage` / `-arm64.AppImage`, `.deb`, `.rpm`                                 |
| Windows | `Sesame-Setup-x.y.z-x64.exe` (installeur), `Sesame-Portable-x.y.z-x64.exe` (portable), variantes `arm64` |
| macOS   | `Sesame-x.y.z-mac-universal.dmg` / `.zip` (Apple Silicon + Intel)                                        |

Vérifiez l'intégrité avec `SHA256SUMS.txt` (`sha256sum -c SHA256SUMS.txt`).

Les builds publiées sans certificat ne sont pas signées. Sous macOS, faites alors un clic droit puis **Ouvrir** au premier lancement. Sous Windows, SmartScreen demandera une confirmation.

## Premier lancement

Au premier lancement, l'assistant :

1. vérifie la présence de `gpg` ;
2. détecte un store existant (`$PASSWORD_STORE_DIR` ou `~/.password-store`, `%USERPROFILE%\.password-store` sous Windows). S'il existe, vous pouvez commencer tout de suite ;
3. sinon, vous propose de **choisir une clé**, d'en **créer une** (ed25519/cv25519 via `gpg --quick-generate-key`, la phrase de passe étant demandée par pinentry) ou d'en **importer une** ;
4. initialise le store (`pass init`) et, si vous le souhaitez, un dépôt git (`pass git init`) ;
5. ou **clone** un store existant depuis un dépôt git.

Ensuite, appuyez sur le raccourci, tapez `github`, choisissez « Créer “github” avec un mot de passe généré » et appuyez sur Entrée. Le mot de passe est enregistré, chiffré et copié. Au prochain raccourci, tapez `github` puis Entrée pour le copier.

## Raccourcis

Raccourci global par défaut : **Ctrl+Maj+Espace** (Windows, Linux) et **⌘⇧Espace** (macOS). Il se modifie dans **Paramètres** avec un enregistreur de touches, et les conflits avec une autre application sont signalés.

Dans le lanceur (`Mod` = Ctrl, ou ⌘ sous macOS) :

| Touche               | Action                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `↑` / `↓`            | Naviguer dans les résultats                                                                         |
| `Entrée`             | Copier le mot de passe et masquer la fenêtre                                                        |
| `Maj+Entrée`         | Copier l'identifiant (`login:`, `user:`, `username:`, `email:`, sinon le dernier segment du chemin) |
| `Mod+O`              | Copier le code OTP                                                                                  |
| `Mod+U`              | Ouvrir l'URL dans le navigateur                                                                     |
| `Tab` / `→`          | Détail de l'entrée (ou options du générateur sur « Créer avec un mot de passe généré »)             |
| `Mod+N`              | Créer une entrée à partir du texte saisi (formulaire)                                               |
| `Mod+G`              | Créer immédiatement une entrée avec un mot de passe généré                                          |
| `Mod+E`              | Éditer l'entrée sélectionnée                                                                        |
| `Mod+Retour arrière` | Supprimer (avec confirmation)                                                                       |
| `Échap`              | Revenir en arrière, effacer la saisie, puis fermer                                                  |

Le texte saisi devient le chemin de l'entrée (`web/github.com/moi` crée les sous-dossiers). Les noms dangereux ou non portables sont refusés : `..`, chemin absolu, `.git`, caractères interdits sous Windows, noms réservés comme `CON` ou `NUL`, point ou espace final. Un écrasement demande toujours confirmation.

La recherche porte uniquement sur les **noms** des entrées. Rien n'est déchiffré pour chercher. Le classement est le suivant : correspondance exacte, puis préfixe, puis sous-chaîne, puis recherche floue. Les ex aequo sont départagés par la fréquence et l'ancienneté d'utilisation, enregistrées localement dans un historique qui ne contient que des noms d'entrées.

## Wayland (raccourci global)

Sur une session Wayland pure, l'API de raccourcis globaux d'Electron ne fonctionne pas toujours. Sesame procède ainsi :

1. Il active le portail `org.freedesktop.portal.GlobalShortcuts` (`--enable-features=GlobalShortcutsPortal`). Avec un bureau qui le fournit (KDE Plasma ≥ 5.27, et les versions récentes de GNOME), le raccourci est proposé par le système à la première utilisation.
2. Sinon, utilisez la commande **`sesame --toggle`**. Sesame est mono-instance : cette commande affiche ou masque la fenêtre de l'instance déjà lancée. Les paramètres signalent quand le raccourci n'a pas pu être enregistré.

**GNOME** : Paramètres → Clavier → Raccourcis personnalisés → `+`

```bash
gsettings set org.gnome.settings-daemon.plugins.media-keys custom-keybindings "['/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/sesame/']"
```

```bash
gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/sesame/ name 'Sesame'
```

```bash
gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/sesame/ command 'sesame --toggle'
```

```bash
gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/sesame/ binding '<Control><Shift>space'
```

(La première commande remplace la liste des raccourcis personnalisés existants. Si vous en avez déjà, ajoutez plutôt le chemin à la liste.) Pour une AppImage, remplacez `sesame` par le chemin complet de l'AppImage.

**KDE Plasma** : Configuration du système → Clavier → Raccourcis → Ajouter une commande → `sesame --toggle`.

**Sway / Hyprland** : `bindsym Ctrl+Shift+space exec sesame --toggle` (Sway) ou `bind = CTRL SHIFT, space, exec, sesame --toggle` (Hyprland).

Autres options de ligne de commande : `--show`, `--manager` (fenêtre complète) et `--hidden` (démarrage silencieux, utilisé par le lancement à l'ouverture de session).

## Renouvellement des mots de passe

Certains mots de passe doivent être changés régulièrement (politique d'entreprise, banque…). Sesame peut le gérer **entrée par entrée** ; c'est facultatif.

1. Dans le détail d'une entrée : **Paramètres de renouvellement** → cochez « Renouveler ce mot de passe régulièrement », choisissez un délai (tous les mois, 2 mois, 3 mois, 6 mois, tous les ans, ou personnalisé en jours/semaines/mois/ans) et, si vous le souhaitez, l'**URL de la page de changement** du mot de passe.
2. À l'échéance (et à partir de N jours avant, 7 par défaut), Sesame affiche une **notification système**, un **bandeau dans le lanceur**, un marqueur « expiré » sur l'entrée et un compteur sur l'onglet **Renouvellement**. Tant que le mot de passe n'est pas renouvelé, le rappel revient chaque jour.
3. **Renouveler maintenant** ouvre un assistant :
   - ouvrir la page de changement (l'URL de connexion est utilisée si aucune n'est définie) ;
   - copier le mot de passe actuel si le site le demande ;
   - copier un **nouveau mot de passe aléatoire** (options du générateur réglables, bouton Régénérer) ;
   - confirmer : Sesame enregistre alors le nouveau mot de passe et la date. **Tant que vous n'avez pas confirmé, l'ancien mot de passe est conservé**, pour ne jamais le perdre si le changement échoue sur le site.

Ces informations sont stockées **dans l'entrée chiffrée**, sous forme de lignes `clé: valeur` standard. Elles voyagent donc avec le store (git) et restent lisibles par `pass` et les autres clients :

```
mot-de-passe
login: alice
rotation: 2m
password-changed: 2026-11-24
change-url: https://github.com/settings/security
```

`rotation` accepte `Nd`, `Nw`, `Nm` ou `Ny` (jours, semaines, mois, années ; les mois suivent le calendrier). Modifier la 1re ligne d'une entrée renouvelée dans Sesame (éditeur, génération en place) met aussi la date à jour.

Pour savoir quand prévenir **sans déchiffrer quoi que ce soit en arrière-plan** (ce qui déclencherait pinentry), Sesame tient un index local (`rotation.json` : noms d'entrées, délais et dates, aucun secret). Il est mis à jour chaque fois qu'une entrée est déchiffrée dans Sesame. Pour les entrées configurées avec `pass` ou sur un autre appareil, utilisez une fois **Renouvellement → Analyser le store**. Une entrée avec `rotation:` mais sans date connue est considérée comme expirée.

Les notifications et le délai d'avertissement se règlent dans **Paramètres**.

## Compatibilité avec pass

Sesame réimplémente le protocole `pass` en TypeScript, car `pass` est un script bash qui ne fonctionne pas nativement sous Windows. Le comportement est le même sur les trois OS.

- **Store** : `$PASSWORD_STORE_DIR`, sinon `~/.password-store`. Une entrée correspond à un fichier `chemin/entree.gpg`, et `/` sert de séparateur sur tous les OS.
- **`.gpg-id`** : c'est le plus proche en remontant l'arborescence qui s'applique. Plusieurs destinataires sont possibles, et les commentaires `#` et lignes vides sont ignorés.
- **Format** : la 1re ligne est le mot de passe. Viennent ensuite des lignes `clé: valeur` et des notes libres. Une ligne `otpauth://` active le TOTP (comme pass-otp).
- **Chiffrement** : `gpg --encrypt --batch --yes --quiet --compress-algo=none --no-encrypt-to --recipient … --output …`, avec le contenu sur stdin. L'écriture est atomique (fichier temporaire puis renommage).
- **Variables respectées** : `PASSWORD_STORE_DIR`, `PASSWORD_STORE_KEY`, `PASSWORD_STORE_GPG_OPTS`, `PASSWORD_STORE_CLIP_TIME` (45 s), `PASSWORD_STORE_GENERATED_LENGTH` (25), `PASSWORD_STORE_CHARACTER_SET`, `PASSWORD_STORE_CHARACTER_SET_NO_SYMBOLS`.
- **Lignes sensibles** : comme la 1re ligne, les champs dont la clé désigne un secret (`password:`, `pass:`, `pin:`, `secret:`, `token:`, `api key:`, `mot de passe:`, `cvv:`, `recovery codes:`…) sont masqués, avec un bouton pour les afficher. Les notes libres, l'éditeur multiligne et les notes du formulaire de création sont masqués jusqu'à ce que vous les affichiez, et la recherche dans le contenu ne renvoie jamais ces lignes en clair.
- **Renouvellement** : lignes `rotation:`, `password-changed:` et `change-url:` (voir [plus haut](#renouvellement-des-mots-de-passe)). `pass` les affiche comme des lignes ordinaires ; un mot de passe changé avec `pass edit` ne met pas la date à jour (pass ignore ces lignes) : utilisez « Renouveler » dans Sesame ou modifiez la date à la main.
- **Git** : si le store est un dépôt, chaque modification crée un commit avec les messages de pass (`Add given password for X to store.`, `Add generated password for X.`, `Edit password for X using Sesame.`, `Remove X from store.`, `Rename X to Y.`, `Copy X to Y.`, `Set GPG id to …`, `Reencrypt password store using new GPG id …`). `pass.signcommits` est respecté.

| `pass`                                           | Sesame                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `init [--path=sub] id…`                          | Assistant, ou onglet **Clés et destinataires** (avec re-chiffrement, barre de progression et annulation)                     |
| `ls` / `find`                                    | Arborescence et recherche floue                                                                                              |
| `grep`                                           | **Recherche dans le contenu** (à la demande, avec progression et annulation). La ligne du mot de passe n'est jamais affichée |
| `show [--clip[=n]] [--qrcode]`                   | Détail, bouton « Copier » par ligne, QR code                                                                                 |
| `insert [--multiline]`                           | Création (formulaire mot de passe, identifiant, URL et notes)                                                                |
| `edit`                                           | Éditeur intégré, avec un bouton « Générer » pour la 1re ligne                                                                |
| `generate [--no-symbols] [--in-place] [--force]` | Générateur (caractères, phrase de passe EFF, PIN)                                                                            |
| `rm [-r]`                                        | Suppression d'une entrée ou d'un dossier, avec confirmation                                                                  |
| `mv` / `cp`                                      | Renommer, déplacer (y compris par glisser-déposer) et dupliquer, en re-chiffrant si les destinataires diffèrent              |
| `git …`                                          | Onglet **Synchronisation** : statut, pull (`--rebase`), push, historique, dépôt distant, clonage                             |
| `otp` (pass-otp)                                 | Code en direct avec compte à rebours, copie, ajout d'une URI, import d'un QR code (image ou capture d'écran)                 |

La compatibilité est testée en CI contre le vrai `pass` (Linux et macOS) dans les deux sens : ce que Sesame écrit est lu par `pass`, et inversement, y compris les `.gpg-id` imbriqués et le re-chiffrement.

## Paramètres

Raccourci global, emplacement du store, programme gpg, durée d'effacement du presse-papiers, options par défaut et préréglages du générateur, lancement à l'ouverture de session (`setLoginItemSettings` sous Windows et macOS, `~/.config/autostart/sesame.desktop` sous Linux), thème (système, clair, sombre), langue (français, anglais), verrouillage automatique (oubli des données déchiffrées après N minutes, avec en option `gpgconf --reload gpg-agent`) et mise à jour automatique (désactivable).

## Développement et build

Prérequis : Node.js ≥ 22, `gpg` et `git` (et `pass` pour le test de compatibilité).

```bash
npm install
```

```bash
npm run dev
```

| Script                               | Rôle                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `npm run typecheck`                  | TypeScript strict (main, preload, renderer, tests, scripts)                                  |
| `npm run lint`                       | ESLint (`strictTypeChecked`, a11y, sécurité, Node), zéro avertissement                       |
| `npm run format:check`               | Prettier                                                                                     |
| `npm test` / `npm run test:coverage` | Vitest, avec seuils de couverture                                                            |
| `npm run test:e2e`                   | Build puis Playwright pour Electron (sous Linux sans écran : `xvfb-run -a npm run test:e2e`) |
| `npm run build`                      | electron-vite                                                                                |
| `npm run dist`                       | Installeurs de l'OS courant dans `dist/`                                                     |
| `npm run verify`                     | typecheck, lint, format:check, test:coverage puis build                                      |
| `npm run licenses`                   | Vérification des licences des dépendances de production                                      |

Les tests unitaires utilisent le **vrai** `gpg` dans un `GNUPGHOME` temporaire, avec des clés de test sans phrase de passe, et un store temporaire. Ils ne touchent jamais à `~/.gnupg` ni à `~/.password-store`.

Dans un conteneur exécuté en root, Chromium refuse son bac à sable. Lancez alors Electron avec `--no-sandbox` (`npm run dev -- --noSandbox` en développement ; les tests E2E le font automatiquement en root).

### CI

- `ci.yml` (chaque push et chaque PR) : **quality** (typecheck, lint, format, `npm audit --audit-level=high`, licences), **test** (matrice Ubuntu/Windows/macOS avec GnuPG installé, couverture et échec sous les seuils), **e2e** (matrice, `xvfb-run` sous Linux) et **build** (matrice, installeurs non signés conservés comme artefacts).
- `release.yml` (tag `v*`) : `verify` sur les trois OS, construction des installeurs, `SHA256SUMS.txt`, notes de version issues des commits conventionnels, puis GitHub Release. La signature et la notarisation n'ont lieu que si les secrets correspondants existent (`CSC_LINK`/`CSC_KEY_PASSWORD`, `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`, `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` ou `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`). Le build n'échoue pas en leur absence.
- `codeql.yml` (JavaScript/TypeScript) et Dependabot (npm et GitHub Actions).
- Les actions sont épinglées par SHA, avec `permissions: contents: read` par défaut, `concurrency`, cache npm et `timeout-minutes` sur chaque job.

### Branche protégée

Dans **Settings → Branches → Branch protection rules** pour `main` :

1. cochez **Require a pull request before merging** ;
2. cochez **Require status checks to pass before merging** et sélectionnez `quality`, `test (ubuntu-latest)`, `test (windows-latest)`, `test (macos-latest)`, `e2e (…)` (×3) et `build (…)` (×3) ;
3. cochez **Require branches to be up to date before merging**.

Les hooks locaux (husky) lancent `lint-staged` et `typecheck` avant chaque commit, et `commitlint` vérifie le format des messages (commits conventionnels).

## Limites connues et choix de conception

- **Renouvellement « imposé ».** Sesame ne peut pas bloquer l'usage d'un mot de passe expiré : il le signale (notification quotidienne, bandeau, marqueur, compteur) jusqu'au renouvellement. Les échéances viennent de l'index local, qui ne connaît que les entrées déchiffrées dans Sesame ou analysées via « Analyser le store ».

Les points suivants s'écartent de la demande initiale, ou dépendent de limites de l'OS ou d'Electron. Ils sont signalés ici plutôt que contournés en silence.

- **Ordre des propositions de création.** Quand aucun nom ne correspond exactement, les actions « Créer… » apparaissent en premier, **sauf** si une entrée existante correspond par préfixe (par exemple `githu` pour `web/github.com/moi`). Cette entrée reste alors en tête : sinon, Entrée sur un nom tapé partiellement créerait un quasi-doublon au lieu de copier l'entrée voulue.
- **Masquage pour les gestionnaires de presse-papiers.** Electron 45 permet d'écrire des formats bruts (`clipboard.write` et `electron application/osclipboard;format=…`). Sesame écrit en une seule opération le texte et `x-kde-passwordManagerHint=secret` (Linux), `org.nspasteboard.ConcealedType` (macOS), et `ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory=0` et `CanUploadToCloudClipboard=0` (Windows). La présence de l'indicateur est **vérifiée par les tests E2E sous Linux**. Sous Windows et macOS, le test E2E enregistre si l'OS a accepté ces formats. Si l'OS les refuse, Sesame se rabat sur une copie simple : le secret est quand même effacé après le délai, mais il n'est pas masqué aux outils d'historique.
- **Protection contre la capture d'écran.** `setContentProtection(true)` est appliqué dès qu'un secret est affiché. Il est efficace sous Windows et macOS, mais **n'a aucun effet sous Linux** (limite d'Electron et des serveurs d'affichage).
- **Wayland.** Voir [plus haut](#wayland-raccourci-global) : portail GlobalShortcuts si disponible, sinon `sesame --toggle` lié à un raccourci du bureau.
- **Tests E2E sur l'application empaquetée.** Les fuses désactivent `--inspect`, dont Playwright a besoin pour piloter Electron. Les tests E2E s'exécutent donc sur le build `out/`. L'application empaquetée est vérifiée par un démarrage et par la lecture des fuses (`npx @electron/fuses read --app …`).
- **Création de clé.** Dans l'interface, la phrase de passe d'une nouvelle clé est demandée par pinentry. Une variable réservée aux tests (`SESAME_TEST_UNPROTECTED_KEYS=1`) crée des clés sans phrase de passe pour la CI. Ne l'utilisez jamais en usage réel.
- **OTP.** Seul TOTP (`otpauth://totp/…`) est géré. HOTP, rarement utilisé avec pass-otp, ne l'est pas.
- **Mise à jour automatique.** Elle utilise les GitHub Releases du dépôt. Sous macOS, elle n'est possible que pour une application signée.
- **Pages en `file://`.** Les pages sont chargées depuis l'asar dont l'intégrité est vérifiée, avec une CSP stricte et toute navigation bloquée. La fuse `GrantFileProtocolExtraPrivileges` reste donc activée (voir SECURITY.md).

## Licence

MIT. `pass` est un projet distinct de Jason A. Donenfeld (GPL-2.0+). Sesame n'en reprend pas le code : il en réimplémente le format.
