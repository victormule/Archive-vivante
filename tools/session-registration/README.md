# Calibration du recalage entre sessions

Cale une session sur une session de référence à partir de la **table**, restée fixe entre les captures. La ligne de séparation entre la table grise et la table blanche fixe la position le long de la table ; ses bords fixent l'orientation et l'échelle.

Le calage automatique du pipeline (`register_to`, `register_anchor`) s'appuie sur les nuages LiDAR, dont les couleurs sont approximatives. Cet outil travaille sur le **rendu réel des splats**, c'est-à-dire ce que l'on voit dans le viewer.

## Procédure

```bash
# 0. Assets générés et viewer lancé en développement
cd web && npm run dev

# 1. Dépendance (une fois)
cd tools/session-registration && npm install

# 2. Vues de dessus des deux sessions (même caméra)
node render_top_views.mjs --reference j1-s1 --session j1-s2 --center=-0.62,-0.71,-4.2

# 3. Recalage et écriture dans sessions.json
../../.venv/Scripts/python register_top_views.py --reference j1-s1 --session j1-s2 --center=-0.62,-0.71,-4.2 --write

# 4. Application
../../.venv/Scripts/python ../../pipeline/build_sessions.py j1-s2 --only registration
```

`--center` : centre de la table dans le repère commun (`y` = hauteur approximative du plateau). Pour le trouver, cadrer la table dans le viewer et appuyer sur Shift+V : la valeur `target` de la vue copiée convient.

Le script affiche la corrélation avant/après, la rotation, l'échelle et la translation. Contrôle visuel : basculer d'une session à l'autre caméra immobile ; la ligne de séparation ne doit pas bouger.

## Résultat j1-s2 → j1-s1 (2026-10-08)

Rotation 5,1°, échelle 0,915, translation ≈ 3 cm, plateau abaissé de 4,1 cm. La corrélation de la table passe de 0,19 à 0,36.
