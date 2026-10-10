# Pipeline

Transforme les exports bruts dür.air en assets prêts pour le web. Les exports ne sont jamais modifiés.

```bash
.venv/Scripts/python pipeline/build_sessions.py           # toutes les sessions
.venv/Scripts/python pipeline/build_sessions.py j1-s1     # une seule session
.venv/Scripts/python pipeline/build_sessions.py j1-s1 --only annotations   # une seule étape
```

Étapes : `splat`, `mesh`, `pointCloud`, `playback`, `annotations`, `registration`. `pointCloud` et `playback` relancent `mesh`, dont ils dépendent pour le recalage.

Compter quelques minutes par session (davantage si la vidéo vient d'une autre session ARKit : les deux nuages LiDAR sont lus). La lecture des nuages et l'ICP dominent. Chaque build affiche les résidus d'alignement, également consignés dans `manifest.json` (clé `alignment`).

## Catalogue : `sessions.json`

Réglages communs (`scene`), dans le repère commun :

```jsonc
"scene": {
  "initial_view": { "position": [], "quaternion": [], "target": [], "fovY": 48.3 },
  "orbit": { "center": [-0.62, -0.71, -4.2], "idle_seconds": 30, "turn_seconds": 80, "switch_degrees": 180 }
}
```

- `initial_view` : vue d'arrivée. Pour la définir, cadrer la vue dans le viewer, appuyer sur Shift+V et coller le résultat.
- `orbit` : rotation automatique après `idle_seconds` d'inactivité, autour de l'axe vertical passant par `center` (milieu de la table, hauteur du plateau), un tour en `turn_seconds`, changement de session tous les `switch_degrees` (180 : chaque demi-tour).

Par session :

```jsonc
{
  "id": "j1-s1",                     // identifiant URL (?session=j1-s1)
  "title": "Journée 1 — Session 1",
  "day": 1,
  "index": 1,
  "export_dir": "Journée1-session1", // dossier de l'export, relatif à la racine
  "arkit_session": "1076BA54",       // si l'export contient plusieurs sessions ARKit : celle du splat
  "playback": {                      // optionnel : replay audio + caméra
    "video_id": "7022E93E",          // videos/video_<id>.mp4 dans l'export
    "export_dir": "…",               // optionnel : vidéo exportée à part
    "arkit_session": "BF499316",     // optionnel : session ARKit de la vidéo, si ce n'est pas celle du splat
    "time_offset": 0.0,              // décalage caméra/audio en secondes (+ = caméra en retard)
    "align_to_world": true           // recalage ARKit -> splat (défaut : true)
  },
  "register_to": "j1-s1",            // optionnel : recaler cette session sur une autre (repère commun)
  "register_anchor": "table",        // optionnel : affiner le calage automatique sur le plateau de la table
  "world_transform": { "matrix": [] }, // optionnel : calage calibré (tools/session-registration), prioritaire
  "annotations": {                   // optionnel
    "source": "Journée1-annotation.zip",   // export d'annotations dür.air (zip ou dossier)
    "content_source": "…",                 // optionnel : reprendre textes et images d'un autre export, par titre
    "media_dir": ".",                      // dossier des médias associés (images, vidéos, PDF)
    "media": { "Titre": ["fichier.jpeg"] }, // optionnel : association explicite titre -> fichiers (sinon par nom)
    "arkit_session": "BF499316",           // optionnel : session ARKit des annotations
    "frame": "arkit",                      // optionnel : points en repère ARKit (session sans splat) -> recalés
    "reference_images": true               // optionnel : sans image par titre, montrer la vue caméra de l'annotation
  },
  "point_cloud": {                   // optionnel
    "voxel_size": 0.01,              // sous-échantillonnage (m) ; 1 cm ≈ 1 M points ≈ 9 Mo
    "icp_scale": false               // autoriser une mise à l'échelle dans l'ICP
  }
}
```

## Recalage des couches

Le repère de référence est celui du **Gaussian splat**. dür.air construit le splat à partir du maillage photogrammétrique aligné : appliquer la matrice `alignmentInfo.transformMatrix` (column-major) à l'OBJ redonne exactement les bornes du splat.

| Couche | Source | Transformation vers le repère du splat |
| --- | --- | --- |
| Gaussian | `gaussian/*.ply` | aucune |
| Photogrammétrie | `photogrammetry/*.obj` (repère du modèle) | matrice d'alignement dür.air (échelle ≈ 2,86) |
| Nuage de points | `scene/sparse_cloud_*.ply` (**exporté en Z-up**) | `(x, y, z) → (x, z, −y)`, puis ICP point-à-plan sur la surface photogrammétrique (deux départs : sans correction et recalage caméra ; le meilleur ajustement est retenu) |
| Gaussian (fichier web) | `splat.spz` | aucune : compression SPZ par l'encodeur de Spark (`scripts/transcode_spz.mjs`) |
| Trajectoire caméra | vidéo (repère ARKit) | ajustement rigide robuste entre les poses ARKit des captures et les poses photogrammétriques raffinées |
| Vidéo d'une autre session ARKit | idem | ICP entre les nuages LiDAR des deux sessions, composé avec la ligne précédente (`arkit_session`) |

Les données ARKit brutes sont décalées d'environ 2° / 24 cm par rapport au repère du splat. Deux estimations indépendantes concordent à quelques centimètres : l'ICP du nuage et l'ajustement sur 133 paires de poses.

Validation : on a rendu le splat aux poses des photos de capture et mesuré la ressemblance avec les photos (NCC). Le recalage fait mieux que les poses ARKit brutes (0,52 contre 0,48), le plafond étant de 0,61 avec les poses raffinées. L'écart résiduel (~6 cm médian) vient de la dérive d'ARKit pendant la prise de vue : aucune transformation globale ne peut le corriger.

## Recalage entre sessions

**Calage de référence : la table.** Elle n'a pas bougé entre les captures, contrairement aux personnes et au mobilier. La ligne de séparation entre la table grise et la table blanche fixe la position le long de la table ; ses bords fixent l'orientation et l'échelle.

- `world_transform` (prioritaire) : matrice calibrée avec `tools/session-registration`, à partir des vues de dessus réellement rendues (voir son README). j1-s2 : rotation 5,1°, échelle 0,915, plateau abaissé de 4,1 cm.
- Sinon, calage automatique : ICP entre nuages LiDAR (décor), puis affinage sur le plateau (`register_anchor: "table"`). Plus approximatif, car les couleurs des nuages sont peu fidèles.

Chaque session a son propre repère (celui de son splat). Une session avec `register_to` est recalée sur la session de référence par ICP entre leurs nuages LiDAR : le rejet progressif des appariements lointains écarte ce qui a changé entre les captures (personnes, mobilier) ; sol, façades et végétation contraignent le résultat.

Le résultat est écrit dans `manifest.json` (`worldTransform`) et appliqué à l'affichage à toute la session : couches, annotations, trajet. Le splat n'est pas réécrit, car il faudrait faire tourner ses harmoniques sphériques.

j1-s2 → j1-s1 : 3,3° / ~40 cm, résidu médian 9,7 → 6,0 cm, 45 % des points appariés.

## Annotations

- Lues directement dans le zip d'export (`sessions/<id>/annotations/annotation_*.json`), sans extraction.
- Le texte affiché réunit la description et les champs personnalisés (ex. « note »).
- Annotations reposées dans une autre session (mêmes titres, autres emplacements) : `content_source` reprend leur texte de l'export d'origine ; seul l'emplacement vient de la session.
- Couleur : un indice commun à toutes les sessions est attribué par titre. Les couleurs déjà publiées ne changent jamais ; un nouveau titre prend l'indice suivant (ordre du catalogue, puis ordre naturel des titres). Une source d'annotations absente n'empêche pas le build : ses couleurs publiées sont conservées.
- Images : associées par **titre** dans `media_dir` : `Doc3.jpg` pour une image unique, `Doc4-1.jpeg`, `Doc4-2.jpeg`… pour plusieurs (ordre numérique). Elles sont ré-encodées en JPEG, 1600 px maximum.
- Audios : un fichier son (`.m4a`, `.mp3`, `.wav`, `.aac`, `.ogg`, `.opus`, `.flac`, `.caf`) cité dans `media` est converti en AAC mono 96 kb/s (`<id>-a1.m4a`) ; le viewer l'affiche comme une rangée « ▶ Audio 1 · 0:40 » dans l'annotation. Les annotations vocales de dür.air (`voice_annotations/`) ne contiennent parfois que leurs métadonnées : les fichiers son sont alors à fournir.
- Vidéos et PDF : `media` associe explicitement des fichiers à un titre ; chacun est rangé selon son extension (image, vidéo `.mp4`/`.mov`/`.m4v`/`.webm`, document `.pdf`). Une vidéo est recopiée sans sa piste son (lecture muette en boucle dans le viewer, au survol et au clic) avec une image d'attente ; un PDF est copié tel quel avec la première page en vignette (PyMuPDF).
- Non destructif : si les fichiers sources d'une annotation ont été retirés du disque, ses médias déjà publiés sont conservés ; seuls les fichiers produits par le build (`<id>-1.jpg`, `-v1.mp4`, `-d1.pdf`…) sont remplacés ou retirés, les médias ajoutés à la main dans `annotations/` restent.
- Reconstruire seulement les annotations (`--only annotations`) ne demande pas l'export brut de la session : à défaut, les métadonnées sont lues dans l'export d'annotations.
- Repère : les points sont déjà dans le repère du splat (posés sur le modèle aligné, à moins de 1,5 cm de la surface photogrammétrique) ; aucune transformation n'est appliquée. Exception : annotations faites pendant une session sans splat (`frame: "arkit"`), recalées comme la vidéo de cette session.
- Sans image associée par titre, `reference_images` illustre l'annotation par la vue caméra enregistrée au moment où elle a été posée.

## Points d'attention

- **Noms de dossiers Unicode** : les exports iOS sont en NFD (`Journée`). `resolve_dir` les retrouve quelle que soit la normalisation.
- **Horodatage de la trajectoire** : l'export arrondit à la seconde. Le temps continu est reconstruit en encadrant la fraction de seconde du début vidéo à l'aide de `duration`, puis en répartissant les poses dans chaque seconde (voir `camera_path.py`). Si un décalage apparaît, l'ajuster avec `time_offset`.
- **Scène vivante** : la vidéo de j1-s1 a été tournée 5 minutes après la capture du splat, et les personnes ont bougé entre-temps. Le décor fixe (table, sol, arbres) coïncide, les corps non.
- **Vidéo HEVC** : les vidéos iPhone sont en H.265, mal supporté par les navigateurs. Seul l'audio est extrait pour l'instant.
- **j2-s3** : l'export Journée2-session3 contient deux sessions ARKit. 1076BA54 (14:19) porte le splat et la photogrammétrie ; BF499316 (14:28–14:53) porte la vidéo de 24 min (exportée à part) et 4 annotations. Les deux repères diffèrent de 12 cm / 0,3° (ICP des nuages LiDAR).
- **j1-s1** : la vidéo de l'export Journée1-session1 appartient en réalité à la session `293D7954` (Journée1-session2), tournée à 14:00, après la fin de la session 1 (13:55). Elle partage le repère ARKit de la session 1.

## Évolutions prévues

- Transcodage H.264 de la vidéo pour un affichage en incrustation.
