# Déploiement sur Render (Node.js + PostgreSQL + Cloudinary)

## 0) Pré-requis
- Un compte GitHub
- Un compte Render (https://render.com)
- Un compte Cloudinary (plan gratuit)
- Node.js >= 18 installé localement (pour test local, optionnel)

## 1) Cloner, configurer en local (optionnel)
```
npm install
cp .env.example .env
# Remplir .env (ADMIN_CODE, DATABASE_URL si vous avez déjà un Postgres local, sinon plus tard)
npm start
```
Le site écoute sur http://localhost:10000

## 2) Pousser le code sur GitHub
- Créez un dépôt et poussez tout le projet.

## 3) Créer la base PostgreSQL sur Render
- Dashboard Render → New + → **PostgreSQL**
- Instance **Free** → Créer
- Une fois créée, ouvrez la base et copiez la **External Connection** (postgres://...)
- Notez: la base Free a **1 Go** de stockage et **1 instance par workspace**

## 4) Créer le service Web (Node) sur Render
- Dashboard Render → New + → **Web Service**
- Source: votre repo GitHub
- Runtime: Node, Instance type: **Free**
- Build Command: `npm install`
- Start Command: `npm start`
- Créez le service

## 5) Variables d’environnement (Render → Settings → Environment)
- `PORT` est fourni par Render automatiquement
- Ajoutez:
  - `ADMIN_CODE` = votre code secret
  - `DATABASE_URL` = la chaîne "External Connection" de votre Postgres Render
  - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`

Déployez (ou **Manual Deploy → Clear cache & deploy**).

## 6) Tester
- Accédez à `https://VOTRE_APP.onrender.com/`
- Allez sur `/authorize`, entrez `ADMIN_CODE`
- Revenez sur `/` pour voir le formulaire d'upload
- Uploadez une image (JPG/PNG ≤ 5 Mo) → elle est stockée sur Cloudinary, l'URL est enregistrée en base

## Notes
- Free Web Service Render **se met en veille après ~15min d'inactivité** et se réveille à la prochaine requête (petit délai). 
- Pour limiter le "cold start", configurez un ping régulier (UptimeRobot) vers `/healthz`.
- Les **persistent disks** ne sont pas dispo en Free, d'où l'usage de Cloudinary pour les images.
