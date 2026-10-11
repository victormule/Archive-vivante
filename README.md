# Performance Archive

Archive vivante de performances, capturées en photogrammétrie et en Gaussian Splatting (exports dür.air), et consultables dans un viewer web.

Chaque session se rejoue : le son de la vidéo d'origine est diffusé pendant que la caméra suit dans la scène 3D le trajet, lissé, de l'appareil au moment du tournage. Trois représentations de la scène se superposent, recalées dans un même repère : le Gaussian splat, la photogrammétrie texturée et le nuage de points LiDAR. Des annotations spatialisées (titre, note, images) y sont épinglées.

Toutes les sessions, quel que soit le jour, sont recalées dans un repère commun, calé sur la table restée en place, puis posées à l'endroit du bâtiment où elles ont été captées, sur un plan fixe et au même niveau de sol. On passe de l'une à l'autre en fondu enchaîné, pendant que la caméra se rend au lieu de la suivante en gardant son cadrage. Après 30 s d'inactivité, la caméra tourne lentement autour de la scène et les sessions se succèdent, une par demi-tour ; l'axe de rotation glisse d'un lieu à l'autre pendant le fondu. Le bouton « Toutes les sessions », à droite de la barre, les réunit toutes dans le bâtiment avec leurs annotations, chacune marquée de sa session (S1, S2…) ; les splats de chaque session s'y effacent loin de son centre (`fullFade` dans `plan.config.json`), l'Event reste entier. Un bouton « ▶ Session n » au départ de chaque trajet enregistré montre ce trajet au survol et lance son écoute (son et caméra) au milieu des autres.

## Arborescence

```
Performance Archive/
├── Journée1-session1/          Exports bruts dür.air (non versionnés, jamais modifiés)
├── Journée1-session2/          (vidéo seule, rattachée à j1-s1)
├── Journée1-session4/          Export de la session 2 de la journée (splat, photogrammétrie, nuage)
├── Journée2-session3/          Export de la session 3 (deux sessions ARKit : splat 1076BA54, vidéo BF499316)
├── Journée2-session3-video/    Vidéo de la session 3, exportée à part
├── Journée2-session4&5/        Sessions 4 (F21895A2, avec vidéo) et 5 (0447EF10), même export
├── Journée1-annotation*.zip    Annotations de j1-s1 / j1-s2 (non versionnées)
├── Doc1.jpeg …                 Images des annotations, associées par titre (non versionnées)
├── pipeline/                   Préparation des assets web (Python + numpy/scipy)
│   ├── sessions.json           Catalogue des sessions publiées
│   ├── build_sessions.py       Point d'entrée du pipeline
│   ├── scripts/transcode_spz.mjs  Compression des splats (encodeur de Spark)
│   ├── requirements.txt
│   └── archive_pipeline/
│       ├── builder.py          Construction d'une session (toutes les couches)
│       ├── export_reader.py    Lecture de la structure d'un export
│       ├── alignment.py        Recalage (ICP, ajustement de poses)
│       ├── camera_path.py      Trajectoire vidéo → chemin caméra horodaté
│       ├── point_cloud.py      Sous-échantillonnage et format points.bin
│       ├── annotations.py      Annotations spatialisées + images associées
│       ├── gltf.py, obj.py, ply.py   Formats 3D
│       └── media.py            Audio, textures (ffmpeg), splats SPZ (Node)
├── tools/session-registration/ Calibration du calage entre sessions (sur la table)
└── web/                        Viewer (Vite + TypeScript + three.js + Spark)
    ├── public/sessions/        Assets générés par le pipeline (versionnés : servis tels quels en production)
    ├── public/annotations.config.json  Titres, textes, couleurs, médias des annotations (à éditer)
    ├── public/media/           Médias (images, vidéos, PDF) cités par ce fichier
    ├── public/plan.config.json Plan du bâtiment et emplacement de chaque session (à éditer)
    ├── public/plan/plan.svg    Plan du bâtiment
    └── src/
        ├── app/                Orchestration (App, ArchiveView, SessionScene, IdleWatcher)
        ├── data/               Contrat de données et chargement
        ├── playback/           Horloge audio, interpolation et lissage du trajet
        ├── viewer/             Rendu three.js / Spark, navigation, rotation automatique (AutoOrbit)
        │   └── layers/         Couches : splat, maillage, nuage
        ├── ui/                 Composants d'interface
        │   └── annotations/    Étiquettes, fils, placement
        └── styles/
```

## Prérequis

- Python ≥ 3.10
- Node.js ≥ 20 (viewer, et compression des splats par le pipeline : `npm install` dans `web/` d'abord)
- ffmpeg dans le `PATH`

## Démarrage

```bash
# 1. Environnement Python du pipeline (une seule fois)
python -m venv .venv
.venv/Scripts/python -m pip install -r pipeline/requirements.txt      # Windows
# .venv/bin/python -m pip install -r pipeline/requirements.txt        # macOS / Linux

# 2. Générer les assets web à partir des exports bruts
.venv/Scripts/python pipeline/build_sessions.py

# 3. Lancer le viewer
cd web
npm install
npm run dev
```

Ouvrir http://localhost:5173.

Paramètres d'URL :
- `?session=j1-s1` : session affichée (`?session=full` : toutes les sessions) ;
- `?smoothing=0.7` : lissage du trajet caméra en secondes (`0` = trajet brut).

Tests : `cd web && npm test`.

## Déploiement (Cloudflare Pages)

Projet Cloudflare Pages relié au dépôt GitHub : chaque push sur `main` redéploie le site.

| Réglage | Valeur |
| --- | --- |
| Framework preset | None (ou Vite) |
| Root directory | `web` |
| Build command | `npm run build` |
| Build output directory | `dist` |

La version de Node vient de [web/.nvmrc](web/.nvmrc), les en-têtes (cache, hors-index du formulaire) de [web/public/_headers](web/public/_headers), lu par Cloudflare Pages comme par Netlify. L'adresse publique du site (`VITE_SITE_URL` dans `web/.env`) sert à l'URL canonique, aux balises de partage, à `robots.txt` et à `sitemap.xml`, générés au build ; l'image de partage est [web/public/og.jpg](web/public/og.jpg) (1200 × 630). Les assets de `web/public/sessions/` sont versionnés et copiés tels quels dans le build : après un passage du pipeline, commiter et pousser met le site à jour. Limite Cloudflare : 25 Mo par fichier (l'audio de j2-s3 en fait 22).

## Utilisation

| Action | Effet |
| --- | --- |
| Barre des sessions (en haut) | Changer de session (fondu enchaîné), regroupées par journée (J1, J2…) |
| Bouton ▶ / `Espace` | La caméra rejoint lentement le point de vue de la vidéo, puis la lecture démarre (son et caméra synchronisés) |
| `Shift+V` | Copie la vue courante (pour définir la vue d'arrivée dans `sessions.json`) |
| Boutons à gauche / `1` `2` `3` | Afficher ou masquer Gaussian, photogrammétrie, nuage de points (cumulables, en lecture comme en pause) |
| Bouton épingle / `4` | Afficher ou masquer les annotations |
| Survol d'une étiquette | Déplie la note et les images ; un clic la garde ouverte |
| Clic sur une image | Visionneuse plein écran (`←` `→`, `Échap`) |
| Pause | Navigation libre depuis la pose courante |
| Timeline | Déplace la tête de lecture (et la caméra) |
| Glisser / clic droit / molette | Orbiter / déplacer / zoomer (en pause) |
| Inactivité (30 s) | Rotation lente autour de l'axe de la scène, une session par demi-tour ; la moindre action rend la main |

À l'arrivée, **toutes les sessions** sont chargées et préparées sur le GPU (shaders, textures, tampons de tri) derrière l'écran de chargement : les changements de session sont ensuite instantanés. Les splats compressés (SPZ, ~2 à 3 Mo par session) gardent ce chargement court ; compter ~12 Mo par session, nuage de points compris.

La ligne dorée dans la scène matérialise le trajet de la caméra d'enregistrement. Une annotation cachée par la scène (d'après la géométrie photogrammétrique) apparaît atténuée.

## L'Event (journée 4)

L'Event conclut les sessions et s'en démarque : il a son propre lieu (environ 35 × 35 m), sa vue d'arrivée et son axe de rotation, et apparaît en doré à la fin de la barre (« Événement »). Choisir l'Event fait voler la caméra jusqu'à sa vue ; revenir à une session la ramène à la table. En rotation automatique, l'Event tourne seul autour de son centre ; les sessions se succèdent entre elles.

- **Une seule scène** : les cinq captures de la journée (dossier `Event/`, events 1, 4, 5, 6 et 7) sont réunies et recalées sur une seule référence, le LiDAR de la session vidéo (event 9) : il couvre tout le lieu et porte le trajet de la caméra. La relocalisation de dür.air ne suffisait pas (session vidéo 1,3 m plus haut, captures décalées de quelques dizaines de centimètres). Sols au même niveau à ±3 cm près ; photogrammétries à 5–9 cm du LiDAR de référence.
- **Une seule bande son, un seul trajet** : les vidéos de la session 1A4B75F5 sont mises bout à bout dans l'ordre de tournage (48 min 45 s). La première, de 3 s (`73A1CAA5`), est écartée. Seuls le son et la trajectoire sont gardés ; le trajet est lissé (écart-type de 2 s, `camera_smoothing`), synchronisé au centième de seconde (trajectoire de session) et corrigé de la dérive d'ARKit (`corrections`, mesurées en comparant la vidéo aux rendus de la photogrammétrie).

Exports bruts : `Event/*.zip`, extraits dans `Event/<nom du zip>/` (non versionnés). Reconstruction : `.venv/Scripts/python pipeline/build_sessions.py j4-event` (étapes `parts`, `pointCloud`, `playback`). Détail dans [pipeline/README.md](pipeline/README.md#event).

## Impressions du public (Event)

Sur l'Event, un volet rétractable à droite affiche les impressions du public (un bouton bulle l'ouvre et le ferme), de la plus récente à la plus ancienne, mises à jour en temps réel ; une vidéo se lit, muette, quand on survole sa vignette. On laisse une impression depuis le formulaire **`/participer/`** (page légère, sans scène 3D), où mène le QR code imprimé : nom ou pseudonyme, commentaire, une photo ou une vidéo. Le site lui-même n'indique pas ce lien : l'accès à la participation n'est donné que sur papier.

- **Compression avant envoi**, dans le téléphone : photos en WebP (JPEG sur Safari), 1920 px au plus ; vidéos réencodées en 720p, **muettes**, **30 s au plus** (seul le début est gardé). Aucun fichier ne dépasse 10 Mo (contrôlé aussi par le serveur).
- **Publication immédiate, sans modération.** Retirer une contribution : Supabase → Table Editor → `contributions` → supprimer la ligne ; elle disparaît en direct des écrans. Ses fichiers restent dans le bucket `contributions` (Storage), à supprimer à la main si besoin.
- **Serveur : Supabase** (base, stockage, temps réel). Le schéma, les droits (le public ajoute et lit, rien d'autre) et une limite de 30 contributions par minute sont dans [supabase/contributions.sql](supabase/contributions.sql), à coller dans l'éditeur SQL de Supabase (rejouable). L'URL du projet et sa clé *publishable* (publique par nature) sont dans `web/.env`.
- **QR code** : `print/affiche-participer.pdf` (A4) et `print/participer-qr.svg`. Les régénérer : `node web/scripts/qr.mjs`. L'adresse `https://impressiondarchive.netlify.app/participer/` est imprimée : elle ne doit pas changer.

## Ajouter une session

1. Déposer l'export dür.air à la racine (ex. `Journée2-session1/`).
2. Ajouter une entrée dans [pipeline/sessions.json](pipeline/sessions.json).
3. Relancer `.venv/Scripts/python pipeline/build_sessions.py <id>`.

Pour ne reconstruire qu'une étape (ex. après avoir modifié des annotations) : `--only annotations`.

Voir [pipeline/README.md](pipeline/README.md) pour le détail du format et du recalage.

## Gérer les annotations : `annotations.config.json`

[web/public/annotations.config.json](web/public/annotations.config.json) est l'endroit où l'on règle tout ce qui touche aux annotations : **titre, description, couleur, médias** (images, vidéos, PDF), masquage, petit décalage de l'épingle. Le site le lit au chargement, par-dessus les annotations du pipeline (qui restent intactes) : on enregistre, on recharge la page, sans rien reconstruire. Tout est facultatif ; une annotation ou un champ absent garde sa valeur d'origine. Le bloc `$aide` en tête du fichier rappelle les options.

```jsonc
"j2-s4": {
  "Experimentation": {                 // titre d'origine (dür.air) ou 8 premiers caractères de l'id
    "title": "Expérimentation",
    "color": "#e63946",                // couleur CSS, ou numéro de la palette
    "text": ["Premier paragraphe.", "Second paragraphe."],
    "media": [                         // remplace tous les médias, dans cet ordre
      { "file": "sessions/j2-s4/annotations/37580959-v1.mp4", "poster": "sessions/j2-s4/annotations/37580959-v1.jpg" },
      "mon-image.jpg",                 // un nom seul : web/public/media/
      "carnet.pdf"
    ],
    "hidden": false,                   // true : masquer
    "offset": [0, 0.3, 0]              // décaler l'épingle (m, repère de la session, y vers le haut)
  }
}
```

- **Médias** : déposer les fichiers dans [web/public/media/](web/public/media) et les citer par leur nom. Une vidéo se lit en boucle, sans le son, au survol et au clic ; un PDF s'ouvre dans la visionneuse ; un **audio** (`.m4a`, `.mp3`…) apparaît comme une rangée « ▶ Audio 1 » : au clic un petit lecteur s'ouvre et lit, met la vidéo de la session en pause, et se referme tout seul à la fin (`{ "file": "voix.m4a", "label": "Présentation", "duration": 40 }` pour le nommer). Garder les fichiers légers (images ≲ 1 Mo, vidéos de quelques Mo).
- **Nouvelles annotations** posées dans dür.air : après le build du pipeline, `.venv/Scripts/python pipeline/sync_annotations_config.py` ajoute leurs entrées au fichier, sans toucher aux réglages existants.
- **Erreurs** : une coquille (virgule, guillemet) ne casse pas le site, qui garde les valeurs d'origine ; la console du navigateur (F12) dit ce qui ne va pas, y compris une annotation introuvable ou un format de fichier inconnu.

## Plan du bâtiment et lieu des sessions : `plan.config.json`

Le plan du bâtiment ([web/public/plan/plan.svg](web/public/plan/plan.svg)) est fixe : chaque session y est posée à l'endroit où elle a été captée, tous les modèles au même niveau de sol. Le bouton « Plan du bâtiment » (touche 5), sous celui des annotations, l'affiche au sol en traits clairs et translucides ; il est allumé à l'arrivée.

[web/public/plan.config.json](web/public/plan.config.json) (lu au chargement : on enregistre, on recharge la page) règle :

- `metersPerUnit` : l'échelle du plan, en mètres par unité du SVG (0,104, d'après le mur courbe de l'amphithéâtre mesuré dans le nuage LiDAR de j3-s8) ; `color`, `opacity` : ses traits ;
- `plan` : sa pose (`center` [x, z] du centre du SVG, `rotation` en degrés, `floor` : hauteur du sol, commune à tous les modèles) ;
- `sessions` : l'emplacement de chaque session. Le point `anchor` [x, y, z] du modèle (au sol, dans le repère commun des sessions) est posé en `position` [x, z] sur le plan, au niveau du sol ; le modèle est tourné de `rotation` (degrés) et mis à l'échelle de `scale` autour de ce point. Pour déplacer un modèle : `position` ; le tourner : `rotation` ; l'agrandir : `scale`.

Les emplacements viennent des maquettes « Plan- sessionN.png » (plan recalé dans chaque capture, caméra de la capture retrouvée par les épingles d'annotation), avec les échelles ajustées à l'œil (j1-s2, j2-s5, j3-s7 : 1,1 ; j3-s9 : 1,25) et le sol de chaque modèle mesuré sur les faces horizontales de sa photogrammétrie. La vue d'arrivée et l'axe de rotation automatique (`scene` dans `sessions.json`, `view` et `orbit` de l'Event) restent exprimés dans le repère commun ; le viewer les transporte au lieu de chaque session. Shift+V copie la vue courante dans ce même repère.

## Contrat de données

Le pipeline produit, par session, dans `web/public/sessions/<id>/` :

| Fichier | Contenu |
| --- | --- |
| `manifest.json` | Métadonnées, références aux couches, rapport d'alignement |
| `splat.spz` | Gaussian splat compressé (SPZ, ×15 plus léger que le PLY d'origine) ; Event : `splat-<n>.spz`, un par capture, placé par sa matrice (`layers.splat.parts`) |
| `mesh.glb` | Photogrammétrie texturée (glTF, matériau unlit) |
| `points.bin` | Nuage de points quantifié (format décrit dans `point_cloud.py`) |
| `audio.m4a` | Piste audio AAC extraite de la vidéo (sans ré-encodage) |
| `camera_path.json` | Keyframes `{t, position, quaternion}` + FOV |
| `annotations.json` | Annotations : titre, texte, points 3D, images |
| `annotations/*.jpg` | Images des annotations (≤ 1600 px) |

`index.json` liste les sessions et porte les réglages de scène communs (`scene` : vue d'arrivée, axe et rythme de la rotation automatique).

Les types TypeScript correspondants sont dans [web/src/data/types.ts](web/src/data/types.ts).

## Système de coordonnées

Le pipeline exprime toutes les couches d'une session dans **le repère de son Gaussian splat** : mètres, Y vers le haut, repère droit, caméra orientée vers −Z (convention three.js). La `worldTransform` du manifest place ensuite la session dans le repère commun (celui de j1-s1, calé sur la table). Le détail est dans [pipeline/README.md](pipeline/README.md#recalage-des-couches).
