# Sécurité de Sesame

## Signaler une vulnérabilité

Merci de **ne pas ouvrir d'issue publique**. Utilisez l'onglet **Security → Report a vulnerability** du dépôt (signalement privé GitHub). Une réponse est donnée sous 7 jours. Les versions prises en charge sont la dernière version publiée et la branche `main`.

## Modèle de menace

### Ce que Sesame protège

1. **Les secrets au repos.** Ils restent chiffrés par GnuPG dans le format `pass`. Sesame ne crée aucun autre stockage de secrets : ni cache, ni base de données, ni fichier temporaire en clair.
2. **La phrase de passe GPG.** Sesame ne la voit jamais. Elle est demandée par `gpg-agent` via pinentry. Le verrouillage automatique peut faire oublier à l'agent les phrases en cache (`gpgconf --reload gpg-agent`).
3. **Les secrets en transit dans l'application.** Ils sont déchiffrés à la demande dans le process principal et envoyés au renderer uniquement sur une action explicite (afficher, éditer). Ils sont oubliés au verrouillage et à la fermeture d'une vue.
4. **Le presse-papiers.** Il est effacé après `PASSWORD_STORE_CLIP_TIME` secondes (45 par défaut), **seulement s'il contient encore la valeur copiée**. La comparaison se fait sur une empreinte SHA-256 : le secret lui-même n'est pas conservé. Les indicateurs « contenu sensible » sont posés pour l'historique et les gestionnaires de presse-papiers (voir README, _Limites connues_).
5. **L'intégrité du store.** Les noms d'entrée sont validés deux fois : lexicalement (pas de `..`, pas de chemin absolu, pas de segment caché comme `.git`, pas de caractère de contrôle), puis par une preuve de confinement après résolution du chemin. Ces règles sont vérifiées par des tests de propriétés (fast-check) pour les sémantiques POSIX et Windows. Les écritures sont atomiques (fichier temporaire puis renommage) et les déplacements de dossiers sont transactionnels.

### Attaquants considérés

| Attaquant                                                                              | Mesures                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contenu malveillant atteignant un renderer (injection dans un nom d'entrée, une note…) | React échappe tout le texte. CSP stricte (`default-src 'none'`, `script-src 'self'`, pas de `unsafe-eval`, `connect-src 'none'`). `contextIsolation`, `sandbox`, `nodeIntegration: false`, `webSecurity`. Aucun contenu distant n'est chargé, toute navigation et toute ouverture de fenêtre sont refusées, les `webview` sont interdits et les permissions web systématiquement refusées.                                    |
| Renderer compromis                                                                     | Le preload n'expose qu'un `invoke` restreint aux canaux du contrat IPC (vérifié avec `Object.hasOwn`, pas avec `in`) et un abonnement aux événements. Chaque entrée est validée par zod dans le process principal (types _branded_ `EntryPath`, `GpgKeyId`, `PlainSecret`). Seules les pages de l'application, dans le cadre principal, peuvent appeler l'IPC. Les URL ouvertes dans le navigateur sont limitées à `http(s)`. |
| Store partagé hostile (dépôt git commun)                                               | Un `.gpg-id` dont une ligne commence par `-` est refusé : ce serait une injection d'option dans `gpg`. Les noms de fichiers ne sont jamais passés comme options : les chemins sont absolus et précédés de `--`. Les URL git `ext::`/`fd::` et celles qui commencent par `-` sont refusées, et `protocol.ext.allow=never` est imposé.                                                                                          |
| Injection de commande                                                                  | Les processus sont lancés uniquement via `spawn` avec un tableau d'arguments et `shell: false`. Les secrets passent **uniquement par stdin et stdout**, jamais par la ligne de commande, une variable d'environnement ou un fichier temporaire. Ces propriétés sont vérifiées par des tests : un secret « canari » n'apparaît dans aucun argument, aucun message d'erreur, aucun log, aucun fichier ni aucun objet git.       |
| Fuite par les logs ou les erreurs                                                      | Il n'y a ni télémétrie ni crash reporting distant. Les erreurs sont des unions discriminées dont les seuls textes viennent de stderr de gpg ou git (jamais du contenu déchiffré). Les exceptions inattendues sont réduites à leur nom de classe avant de traverser l'IPC.                                                                                                                                                     |
| Capture d'écran                                                                        | `setContentProtection(true)` dès qu'un secret est visible : efficace sous Windows et macOS, sans effet sous Linux.                                                                                                                                                                                                                                                                                                            |
| Altération du binaire                                                                  | Les Electron Fuses sont durcies : `RunAsNode`, `NODE_OPTIONS` et `--inspect` sont désactivés, `EnableEmbeddedAsarIntegrityValidation` et `OnlyLoadAppFromAsar` activés, de même que le chiffrement des cookies. Le binaire est signé et notarisé quand les certificats sont fournis.                                                                                                                                          |

### Hors périmètre

- Un attaquant qui exécute du code avec les droits de l'utilisateur pendant que la session est ouverte. Il peut lire le presse-papiers, enregistrer le clavier ou interroger `gpg-agent` : c'est le même modèle que `pass`.
- La compromission de la clé privée GPG ou de sa phrase de passe.
- Les métadonnées : **les noms des entrées (chemins) ne sont pas chiffrés**, comme avec `pass`. L'historique d'utilisation local (`history.json`) contient ces noms, des compteurs et des dates, jamais de secret.
- La sécurité du dépôt git distant et des identifiants git (gérés par git, ssh-agent et les gestionnaires d'identifiants du système).

### Risques résiduels connus

- La fuse `GrantFileProtocolExtraPrivileges` reste activée, car les pages sont servies en `file://` depuis l'asar dont l'intégrité est vérifiée. La navigation est bloquée et la CSP interdit tout chargement externe. Une évolution possible serait un protocole personnalisé (`app://`).
- `grep` (recherche dans le contenu) déchiffre toutes les entrées. Seules les lignes correspondantes, hors première ligne, sont envoyées à l'interface.
- Sous Linux sans compositeur compatible, les secrets affichés peuvent être capturés à l'écran.
- La mémoire d'un process JavaScript ne peut pas être effacée de façon déterministe. Sesame limite la durée de vie des secrets (aucun cache, état React supprimé au verrouillage), mais ne peut pas garantir leur effacement immédiat de la mémoire.

## Mise à jour automatique

`electron-updater` télécharge les mises à jour depuis les GitHub Releases du dépôt, en HTTPS, avec vérification de la signature sous Windows et macOS quand l'application est signée. Elle peut être désactivée dans les paramètres. Sesame ne fait aucune autre connexion réseau, en dehors des commandes git que vous lancez.
