/**
 * Serveur Express pour galerie photo (version avec users)
 * - Auth par utilisateur (users) + devices connus dans la table users
 * - Upload d'images vers Cloudinary
 * - PostgreSQL pour stocker URLs et utilisateurs
 */

const fs = require('fs');
const exif = require('exif-parser');
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/public', express.static(path.join(__dirname, 'public')));

// --- Cloudinary config ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// --- PostgreSQL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Render Postgres requiert SSL
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      devices TEXT[], -- tokens des appareils connus
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL,
      url TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      taken_at TIMESTAMPTZ,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log('✅ Tables users + photos vérifiées.');
}

// --- Middleware device token ---
app.use((req, res, next) => {
  let token = req.cookies.device_token;
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    const isSecure = req.protocol === 'https' || (req.get('x-forwarded-proto') === 'https');
    res.cookie('device_token', token, {
      maxAge: 1000 * 60 * 60 * 24 * 365 * 5,
      httpOnly: true,
      secure: isSecure,
      sameSite: 'lax'
    });
  }
  req.deviceToken = token;
  next();
});

// --- Helper: récupérer l’utilisateur depuis son device ---
async function getUserByDevice(token) {
  const { rows } = await pool.query(
    `SELECT * FROM users WHERE $1 = ANY(devices) LIMIT 1`,
    [token]
  );
  return rows[0] || null;
}

// --- Multer (mémoire) ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') cb(null, true);
    else cb(new Error('Formats autorisés: JPG, PNG'));
  }
});

// --- Routes ---
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// --- Route Toilet App ---
app.get('/toilet-app', async (req, res) => {
  try {
    // Récupération des photos avec le nom de l'utilisateur
    const { rows } = await pool.query(`
      SELECT photos.*, users.id
      FROM photos
      JOIN users ON photos.user_id = users.id
      ORDER BY COALESCE(taken_at, uploaded_at) DESC
      LIMIT 200
    `);

    // Récupération de l'utilisateur courant via le device token
    const user = await getUserByDevice(req.deviceToken);

    // Affichage de la vue toilet-app.ejs
    res.render('toilet-app', { photos: rows, user });
  } catch (e) {
    console.error(e);
    res.status(500).send('Erreur serveur');
  }
});

// --- Route index ---
app.get('/', async (req, res) => {
  try {
    // Récupération de l'utilisateur courant via le device token
    const user = await getUserByDevice(req.deviceToken);

    // Affichage de la vue index.ejs
    res.render('index', { user });
  } catch (e) {
    console.error(e);
    res.status(500).send('Erreur serveur');
  }
});

// route upload
app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.redirect('/');

    // Vérif utilisateur
    const user = await getUserByDevice(req.deviceToken);
    if (!user) {
      return res.status(403).send('⚠️ Vous devez être connecté pour uploader.');
    }

    // Lire les métadonnées EXIF
    let takenDate = null;
    try {
      const parser = exif.create(req.file.buffer);
      const result = parser.parse();
      if (result.tags && result.tags.DateTimeOriginal) {
        takenDate = new Date(result.tags.DateTimeOriginal * 1000);
      }
    } catch (ex) {
      console.warn('Impossible de lire les métadonnées EXIF:', ex.message);
    }

    // Upload Cloudinary
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "uploads" },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    const filename = uploadResult.public_id.split('/').pop();
    const url = uploadResult.secure_url;

    // Sauvegarde DB
    await pool.query(
      'INSERT INTO photos (filename, url, taken_at, user_id) VALUES ($1, $2, $3, $4)',
      [filename, url, takenDate, user.id]
    );

    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erreur upload');
  }
});

// Route login
const bcrypt = require('bcrypt'); // si tu veux sécuriser les mots de passe

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    // Vérifier si l'utilisateur existe
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];

    if (!user) {
      return res.status(401).send("Utilisateur introuvable");
    }

    // Vérifier le mot de passe
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).send("Mot de passe incorrect");
    }

    // Associer le device_token à l’utilisateur
    const token = req.deviceToken;
    await pool.query(
      `UPDATE users SET devices = array_append(devices, $1) WHERE id = $2 AND NOT ($1 = ANY(devices))`,
      [token, user.id]
    );

    // Stocker l'ID utilisateur en cookie pour la session
    res.cookie("user_id", user.id, { httpOnly: true });

    // Rediriger vers l'accueil
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send("Erreur serveur");
  }
});

// Démarrage
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Serveur démarré sur port ${PORT}`);
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});