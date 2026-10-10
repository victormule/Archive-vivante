# Performance Archive

Archive vivante de performances, capturées en photogrammétrie et en Gaussian Splatting (exports dür.air), et consultables dans un viewer web.

Chaque session se rejoue : le son de la vidéo d'origine est diffusé pendant que la caméra suit dans la scène 3D le trajet, lissé, de l'appareil au moment du tournage. Trois représentations de la scène se superposent, recalées dans un même repère : le Gaussian splat, la photogrammétrie texturée et le nuage de points LiDAR. Des annotations spatialisées (titre, note, images) y sont épinglées.

Toutes les sessions, quel que soit le jour, sont recalées dans un repère commun, calé sur la table restée en place : on passe de l'une à l'autre en fondu enchaîné, sans que la caméra bouge. Après 30 s d'inactivité, la caméra tourne lentement autour de l'axe de la scène et les sessions se succèdent, une par demi-tour.

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
- `?session=j1-s1` : session affichée ;
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

La version de Node vient de [web/.nvmrc](web/.nvmrc), les en-têtes de cache de [web/public/_headers](web/public/_headers). Les assets de `web/public/sessions/` sont versionnés et copiés tels quels dans le build : après un passage du pipeline, commiter et pousser met le site à jour. Limite Cloudflare : 25 Mo par fichier (l'audio de j2-s3 en fait 22).

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

## Contrat de données

Le pipeline produit, par session, dans `web/public/sessions/<id>/` :

| Fichier | Contenu |
| --- | --- |
| `manifest.json` | Métadonnées, références aux couches, rapport d'alignement |
| `splat.spz` | Gaussian splat compressé (SPZ, ×15 plus léger que le PLY d'origine) |
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
